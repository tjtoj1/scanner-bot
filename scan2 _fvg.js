// ============================================================
// BOT #2 — FVG STRATEGY (Fair Value Gap)
// Completely independent from Bot #1 (pullback strategy).
// Logic:
//   1. Detect FVG (3-candle imbalance) on 5-min chart
//   2. When next candle OPENS at the FVG edge → enter CALL (bullish) or PUT (bearish)
//   3. Structural stop: 5-min candle CLOSES beyond the FVG on the other side → flip
//   4. Profit ladder: +10% → trail stop at +5% | +20% → trail stop at +10% + 10% trail
// ============================================================

import fs from "fs";

const ALPACA_KEY    = process.env.ALPACA_KEY_2;
const ALPACA_SECRET = process.env.ALPACA_SECRET_2;
const TG_TOKEN      = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const MODE          = process.env.MODE || "scan";

if (!ALPACA_KEY || !ALPACA_SECRET || !TG_TOKEN) {
  console.log("Missing env vars"); process.exit(1);
}

const TRADING_BASE = "https://paper-api.alpaca.markets/v2";
const DATA_BASE    = "https://data.alpaca.markets/v2";
const TICKERS      = ["SPY", "QQQ", "GLD"];

// FVG minimum size (% of price) — skip tiny gaps that are just noise
const FVG_MIN_PCT = 0.10;  // 0.10% of price
// How close current price must be to the FVG edge to trigger entry (% of price)
const FVG_EDGE_TOLERANCE = 0.08;
// Profit ladder
const LADDER_1_PCT   = 10;   // +10% → move stop to +5%
const LADDER_1_STOP  = 5;
const LADDER_2_PCT   = 20;   // +20% → move stop to +10% + 10% trail
const LADDER_2_STOP  = 10;
const TRAIL_PCT      = 10;
// GLD only Mon/Wed/Fri
const GLD_DAYS = new Set([1, 3, 5]); // Mon=1, Wed=3, Fri=5

// ─── HELPERS ────────────────────────────────────────────────
function nowUTC() { return new Date(); }
function utcMin(d) { return d.getUTCHours()*60 + d.getUTCMinutes(); }

function isMarketOpen() {
  const m = utcMin(nowUTC());
  return m >= 13*60+35 && m < 20*60;
}
function isPastLastEntry() { return utcMin(nowUTC()) >= 19*60+40; }
function isForceExit()     { return utcMin(nowUTC()) >= 19*60+55; }

function loadState() {
  try { return JSON.parse(fs.readFileSync("state_fvg.json","utf8")); }
  catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync("state_fvg.json", JSON.stringify(s, null, 2));
}

async function tg(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode:"HTML" })
    });
  } catch(e) { console.error("TG failed:", e.message); }
}

async function alpaca(path, method="GET", body=null) {
  const res = await fetch(`${TRADING_BASE}${path}`, {
    method,
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : null
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function getBars(symbol, tf="5Min", daysBack=1) {
  const start = new Date(Date.now() - daysBack*24*60*60*1000).toISOString();
  const url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&limit=200&adjustment=raw`;
  const res = await fetch(url, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
  });
  const d = await res.json();
  return d.bars || [];
}

async function getLatestPrice(symbol) {
  const r = await fetch(`${DATA_BASE}/stocks/${symbol}/quotes/latest`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
  });
  const d = await r.json();
  return d.quote ? (d.quote.ap + d.quote.bp) / 2 : null;
}

// ─── FVG DETECTION ─────────────────────────────────────────
// Returns the MOST RECENT valid FVG from the bars array
// Bullish FVG: low of candle[i+2] > high of candle[i]  (gap above candle i)
// Bearish FVG: high of candle[i+2] < low of candle[i]  (gap below candle i)
function detectFVG(bars) {
  if (bars.length < 3) return null;
  // scan from newest backwards
  for (let i = bars.length - 3; i >= Math.max(0, bars.length - 20); i--) {
    const c1 = bars[i], c2 = bars[i+1], c3 = bars[i+2];
    // Bullish FVG
    if (c3.l > c1.h) {
      const gapLow  = c1.h;
      const gapHigh = c3.l;
      const gapPct  = (gapHigh - gapLow) / c1.h * 100;
      if (gapPct >= FVG_MIN_PCT) {
        // candle 2 must be strong (body > 50% of range)
        const body = Math.abs(c2.c - c2.o);
        const range = c2.h - c2.l;
        if (range > 0 && body/range >= 0.5) {
          return { type:"bullish", gapLow, gapHigh, gapPct:+gapPct.toFixed(3), bar:i };
        }
      }
    }
    // Bearish FVG
    if (c3.h < c1.l) {
      const gapHigh = c1.l;
      const gapLow  = c3.h;
      const gapPct  = (gapHigh - gapLow) / c1.l * 100;
      if (gapPct >= FVG_MIN_PCT) {
        const body = Math.abs(c2.c - c2.o);
        const range = c2.h - c2.l;
        if (range > 0 && body/range >= 0.5) {
          return { type:"bearish", gapLow, gapHigh, gapPct:+gapPct.toFixed(3), bar:i };
        }
      }
    }
  }
  return null;
}

// ─── OPTION HELPERS ─────────────────────────────────────────
function getExpiry() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

async function findOption(symbol, signal, spotPrice) {
  const expiry = getExpiry();
  const type = signal === "CALL" ? "call" : "put";
  const steps = [0, 1, -1, 2, -2, 3, -3];
  const base = symbol === "SPY" || symbol === "QQQ" ? 1 : symbol === "GLD" ? 1 : 1;

  for (const s of steps) {
    const strike = Math.round(spotPrice / base) * base + s * base;
    const sym = `${symbol}${expiry.replace(/-/g,"").slice(2)}${signal[0]}${String(strike).padStart(8,"0")}`;
    try {
      const quote = await fetch(`${DATA_BASE}/options/${sym}/quotes/latest`, {
        headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
      });
      const q = await quote.json();
      if (q.quote && q.quote.ap > 0.05) {
        const mid = (q.quote.ap + q.quote.bp) / 2;
        return { symbol: sym, strike, premium: mid };
      }
    } catch {}
  }
  return null;
}

async function placeOrder(optSym, qty) {
  return alpaca("/orders", "POST", {
    symbol: optSym, qty: String(qty), side: "buy",
    type: "market", time_in_force: "day"
  });
}

async function closePosition(optSym, qty) {
  return alpaca("/orders", "POST", {
    symbol: optSym, qty: String(qty), side: "sell",
    type: "market", time_in_force: "day"
  });
}

async function getCurrentPremium(optSym) {
  try {
    const r = await fetch(`${DATA_BASE}/options/${optSym}/quotes/latest`, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const d = await r.json();
    return d.quote ? (d.quote.ap + d.quote.bp) / 2 : null;
  } catch { return null; }
}

// ─── POSITION SIZING — max $500 per trade ──────────────────
function calcQty(premium) {
  const budget = 500;
  return Math.max(1, Math.floor(budget / (premium * 100)));
}

// ─── MONITOR ACTIVE POSITION ─────────────────────────────
async function monitorPosition(state, symbol) {
  const pos = state[symbol];
  if (!pos || !pos.active) return;

  const bars = await getBars(symbol, "5Min", 1);
  if (bars.length < 2) return;

  const lastClosed = bars[bars.length - 2]; // last completed 5-min candle
  const currentPremium = await getCurrentPremium(pos.optionSymbol);
  if (!currentPremium) return;

  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium * 100;
  const elapsed = Math.round((Date.now() - pos.entryTime) / 60000);
  console.log(`${symbol} [FVG]: ${pos.signal} | ${pnlPct.toFixed(1)}% | ${elapsed}m`);

  // ── FORCE EXIT at 2:55 PM ─────────────────────────────
  if (isForceExit()) {
    await closePosition(pos.optionSymbol, pos.qty);
    const pnl = Math.round((currentPremium - pos.entryPremium) * pos.qty * 100);
    await tg(`🔔 <b>FVG خروج إجباري ${symbol}</b>\n${pos.signal} | ${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`);
    delete state[symbol]; saveState(state); return;
  }

  // ── PROFIT LADDER ─────────────────────────────────────
  if (pnlPct >= LADDER_2_PCT && !pos.ladder2) {
    pos.ladder2 = true;
    pos.stopPct  = LADDER_2_STOP;
    pos.trailPct = TRAIL_PCT;
    pos.peakPct  = Math.max(pos.peakPct || 0, pnlPct);
    await tg(`📈 <b>FVG ${symbol} مستوى 2</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_2_STOP}% + تريلينق ${TRAIL_PCT}%`);
  } else if (pnlPct >= LADDER_1_PCT && !pos.ladder1) {
    pos.ladder1 = true;
    pos.stopPct  = LADDER_1_STOP;
    pos.peakPct  = Math.max(pos.peakPct || 0, pnlPct);
    await tg(`📊 <b>FVG ${symbol} مستوى 1</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_1_STOP}%`);
  }

  // update trailing peak
  if (pos.trailPct) {
    pos.peakPct = Math.max(pos.peakPct || 0, pnlPct);
  }

  // ── TRAILING / LADDER STOP ────────────────────────────
  if (pos.stopPct !== undefined) {
    const stopFloor = pos.trailPct
      ? pos.peakPct - pos.trailPct      // trail from peak
      : pos.stopPct;                    // fixed ladder stop
    if (pnlPct <= stopFloor) {
      await closePosition(pos.optionSymbol, pos.qty);
      const pnl = Math.round((currentPremium - pos.entryPremium) * pos.qty * 100);
      await tg(`🛑 <b>FVG وقف ربح ${symbol}</b>\n${pos.signal} | ${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`);
      delete state[symbol]; saveState(state); return;
    }
  }

  // ── STRUCTURAL STOP + FLIP ────────────────────────────
  // Check if last closed candle broke the FVG on the wrong side
  const fvg = pos.fvg;
  if (fvg) {
    const brokeDown = pos.signal === "CALL" && lastClosed.c < fvg.gapLow;
    const brokeUp   = pos.signal === "PUT"  && lastClosed.c > fvg.gapHigh;

    if (brokeDown || brokeUp) {
      // close current position
      await closePosition(pos.optionSymbol, pos.qty);
      const pnl = Math.round((currentPremium - pos.entryPremium) * pos.qty * 100);
      const flipSignal = pos.signal === "CALL" ? "PUT" : "CALL";
      await tg(`🔄 <b>FVG انعكاس ${symbol}</b>\n${pos.signal} خسر ${pnlPct.toFixed(1)}% (${pnl>=0?"+":""}$${pnl})\nنفتح ${flipSignal}...`);
      delete state[symbol]; saveState(state);

      // open flipped position if not past last entry
      if (!isPastLastEntry()) {
        const spot = await getLatestPrice(symbol);
        const opt  = spot ? await findOption(symbol, flipSignal, spot) : null;
        if (opt && opt.premium > 0.05) {
          const qty   = calcQty(opt.premium);
          const order = await placeOrder(opt.symbol, qty);
          if (order.id) {
            state[symbol] = {
              active: true, signal: flipSignal,
              optionSymbol: opt.symbol, strike: opt.strike,
              entryPremium: opt.premium, qty,
              entryTime: Date.now(), fvg,
            };
            saveState(state);
            await tg(`🚀 <b>FVG FLIP ${symbol} ${flipSignal} $${opt.strike}</b>\n💰 $${opt.premium.toFixed(2)} × ${qty}\n🔄 انعكاس FVG`);
          }
        }
      }
    }
  }
  saveState(state);
}

// ─── SCAN FOR NEW ENTRIES ───────────────────────────────────
async function scanEntry(state, symbol) {
  if (state[symbol]?.active) return;
  if (isPastLastEntry()) return;

  // GLD filter
  if (symbol === "GLD") {
    const dow = new Date().getUTCDay();
    if (!GLD_DAYS.has(dow)) { console.log("GLD: no 0DTE today"); return; }
  }

  const bars = await getBars(symbol, "5Min", 1);
  if (bars.length < 4) return;

  const fvg = detectFVG(bars);
  if (!fvg) { console.log(`${symbol}: no FVG found`); return; }

  const spot  = await getLatestPrice(symbol);
  if (!spot) return;

  // Entry condition: current price is at the FVG edge (within tolerance)
  const tolerance = spot * FVG_EDGE_TOLERANCE / 100;
  let signal = null;

  if (fvg.type === "bullish" && Math.abs(spot - fvg.gapHigh) <= tolerance) {
    signal = "CALL"; // price at top of bullish FVG → buy CALL
  } else if (fvg.type === "bearish" && Math.abs(spot - fvg.gapLow) <= tolerance) {
    signal = "PUT";  // price at bottom of bearish FVG → buy PUT
  }

  if (!signal) {
    console.log(`${symbol}: FVG ${fvg.type} [$${fvg.gapLow.toFixed(2)}-$${fvg.gapHigh.toFixed(2)}] | spot $${spot.toFixed(2)} — not at edge`);
    return;
  }

  const opt = await findOption(symbol, signal, spot);
  if (!opt || opt.premium < 0.05) { console.log(`${symbol}: no option found`); return; }

  const qty   = calcQty(opt.premium);
  const order = await placeOrder(opt.symbol, qty);
  if (!order.id) { console.log(`${symbol}: order failed`, order); return; }

  state[symbol] = {
    active: true, signal,
    optionSymbol: opt.symbol, strike: opt.strike,
    entryPremium: opt.premium, qty,
    entryTime: Date.now(), fvg,
  };
  saveState(state);

  console.log(`✅ FVG ENTRY: ${symbol} ${signal} $${opt.strike} | $${opt.premium.toFixed(2)} × ${qty}`);
  await tg(`🎯 <b>FVG ${symbol} ${signal} $${opt.strike} 0DTE</b>
💰 Entry: $${opt.premium.toFixed(2)} × ${qty}
📊 FVG: $${fvg.gapLow.toFixed(2)} — $${fvg.gapHigh.toFixed(2)} (${fvg.gapPct}%)
🔄 وقف: إغلاق شمعة خارج الـ FVG → انعكاس`);
}

// ─── MAIN ───────────────────────────────────────────────────
(async () => {
  console.log(`=== FVG Bot started ${new Date().toISOString()} ===`);
  if (!isMarketOpen()) { console.log("Market closed"); process.exit(0); }

  const state = loadState();

  if (MODE === "monitor") {
    for (const sym of TICKERS) {
      if (state[sym]?.active) await monitorPosition(state, sym);
    }
  } else {
    for (const sym of TICKERS) {
      try { await scanEntry(state, sym); }
      catch(e) { console.error(`${sym} error:`, e.message); }
    }
  }
  console.log("Done.");
})();
