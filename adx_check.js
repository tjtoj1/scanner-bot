// ============================================================
// ADX DIAGNOSTIC — standalone, does NOT touch the bot
// Fetches SPY 5-min bars for recent trading days, computes the
// average intraday ADX per day, and prints it next to known results.
// Hypothesis: losing (choppy) days have low ADX (<20),
//             winning (trend) days have high ADX (>20).
// ============================================================

const ALPACA_KEY = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const DATA_BASE = "https://data.alpaca.markets/v2";

if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.log("Missing ALPACA_KEY / ALPACA_SECRET env vars");
  process.exit(1);
}

// Known results from the daily reports (WR + Alpaca real PnL)
const KNOWN = {
  "2026-07-07": { wr: "n/a", pnl: "n/a", note: "(pre-clean)" },
  "2026-07-08": { wr: 38.5, pnl: -1314 },
  "2026-07-09": { wr: 0,    pnl: -528 },
  "2026-07-10": { wr: 41.2, pnl: -1687 },
  "2026-07-13": { wr: 8.3,  pnl: -2740 },
  "2026-07-14": { wr: 73.3, pnl: +1949 },
  "2026-07-15": { wr: 30.0, pnl: -3   },
};

async function getBars(symbol, timeframe, startISO, endISO) {
  const url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=${timeframe}&start=${startISO}&end=${endISO}&limit=10000&adjustment=raw`;
  const res = await fetch(url, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  const data = await res.json();
  return data.bars || [];
}

// Wilder's ADX. Returns array of ADX values aligned to bars.
function computeADX(bars, period = 14) {
  if (bars.length < period * 2) return [];

  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const highLow = bars[i].h - bars[i].l;
    const highClose = Math.abs(bars[i].h - bars[i - 1].c);
    const lowClose = Math.abs(bars[i].l - bars[i - 1].c);
    tr.push(Math.max(highLow, highClose, lowClose));
  }

  // Wilder smoothing
  function smooth(arr) {
    const out = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out[period - 1] = sum;
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      out[i] = sum;
    }
    return out;
  }

  const trS = smooth(tr), plusS = smooth(plusDM), minusS = smooth(minusDM);
  const dx = [];
  for (let i = period - 1; i < tr.length; i++) {
    if (!trS[i] || trS[i] === 0) { dx[i] = 0; continue; }
    const plusDI = 100 * (plusS[i] / trS[i]);
    const minusDI = 100 * (minusS[i] / trS[i]);
    const diSum = plusDI + minusDI;
    dx[i] = diSum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / diSum;
  }

  // ADX = Wilder-smoothed DX
  const adx = [];
  const validDX = dx.filter(v => v !== undefined);
  if (validDX.length < period) return [];
  let adxVal = validDX.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const startIdx = dx.findIndex(v => v !== undefined) + period;
  adx[startIdx - 1] = adxVal;
  for (let i = startIdx; i < dx.length; i++) {
    if (dx[i] === undefined) continue;
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    adx[i] = adxVal;
  }
  return adx;
}

function dateStr(d) { return d.toISOString().split("T")[0]; }

(async () => {
  console.log("\n=== ADX DIAGNOSTIC — SPY (5-min bars, intraday) ===\n");
  console.log("Day         | Avg ADX | Regime   | WR     | Alpaca PnL");
  console.log("------------|---------|----------|--------|------------");

  const days = Object.keys(KNOWN).sort();
  const rows = [];

  for (const day of days) {
    // Regular session in UTC: 13:30–20:00 (8:30 AM – 3:00 PM CDT)
    const start = `${day}T13:30:00Z`;
    const end = `${day}T20:00:00Z`;
    let bars;
    try {
      bars = await getBars("SPY", "5Min", start, end);
    } catch (e) {
      console.log(`${day} | fetch error: ${e.message}`);
      continue;
    }
    if (!bars || bars.length < 30) {
      console.log(`${day} | insufficient bars (${bars ? bars.length : 0})`);
      continue;
    }

    const adx = computeADX(bars, 14);
    const validAdx = adx.filter(v => v !== undefined && !isNaN(v));
    if (validAdx.length === 0) {
      console.log(`${day} | ADX could not be computed`);
      continue;
    }
    // Average ADX over the active part of the day (skip warmup)
    const activeAdx = validAdx.slice(Math.floor(validAdx.length * 0.2));
    const avgAdx = activeAdx.reduce((a, b) => a + b, 0) / activeAdx.length;

    const regime = avgAdx >= 20 ? "TREND ↗" : "CHOP  ↔";
    const k = KNOWN[day];
    const wrStr = k.wr === "n/a" ? "  n/a " : `${String(k.wr).padStart(4)}%`;
    const pnlStr = k.pnl === "n/a" ? "  n/a" : `${k.pnl >= 0 ? "+" : ""}$${k.pnl}`;
    console.log(`${day} |  ${avgAdx.toFixed(1).padStart(5)} | ${regime} | ${wrStr} | ${pnlStr} ${k.note || ""}`);
    rows.push({ day, avgAdx, ...k });
  }

  // Simple correlation check
  console.log("\n=== HYPOTHESIS CHECK ===\n");
  const scored = rows.filter(r => typeof r.pnl === "number");
  const trendDays = scored.filter(r => r.avgAdx >= 20);
  const chopDays = scored.filter(r => r.avgAdx < 20);

  const sum = arr => arr.reduce((a, b) => a + b.pnl, 0);
  console.log(`TREND days (ADX≥20): ${trendDays.length} days, total PnL ${sum(trendDays) >= 0 ? "+" : ""}$${sum(trendDays)}`);
  console.log(`  → ${trendDays.map(r => r.day.slice(5)).join(", ") || "none"}`);
  console.log(`CHOP days  (ADX<20): ${chopDays.length} days, total PnL ${sum(chopDays) >= 0 ? "+" : ""}$${sum(chopDays)}`);
  console.log(`  → ${chopDays.map(r => r.day.slice(5)).join(", ") || "none"}`);

  console.log("\nInterpretation:");
  console.log("- If TREND days are mostly green and CHOP days mostly red → filter is promising.");
  console.log("- If they're mixed → ADX alone doesn't explain it; look elsewhere.");
  console.log("- 6 days is a SMALL sample — treat as a hint, not proof.\n");
})();
