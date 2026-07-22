// ============================================================
// DAILY ANALYSIS — standalone, does NOT touch the trading bot.
// Runs after the close. Two jobs:
//   1) JOIN today's research_log features with today's state.json outcomes
//      and append to outcomes.jsonl  (permanent — state.json wipes daily)
//   2) ANALYZE the whole accumulated outcomes.jsonl and send the table
//      to Telegram.
// ============================================================
import fs from "fs";

const TG_TOKEN = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";

function readJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { return fallback; }
}
function readJSONL(path) {
  try {
    return fs.readFileSync(path, "utf8").split("\n").filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

async function sendTelegram(text) {
  if (!TG_TOKEN) { console.log("No TG_TOKEN"); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode: "HTML" }),
    });
    const d = await res.json();
    if (!d.ok) console.error("TG:", JSON.stringify(d).slice(0, 200));
  } catch (e) { console.error("TG failed:", e.message); }
}

// ---------- STEP 1: JOIN today's features with today's outcomes ----------
// ---------- STEP 1b: record today's PEAK vs CLOSE (permanent) ----------
// state.json wipes daily, so _dailyPeakProfit would be lost. We snapshot it
// here along with the day's actual result, to later choose a data-driven
// threshold for the profit guard.
async function recordPeak() {
  const state = readJSON("state.json", {});
  const today = state._date;
  if (!today) return;

  const existing = readJSONL("peaks.jsonl");
  if (existing.some(r => r.day === today)) {
    console.log("Peak already recorded for", today);
    return;
  }

  const peak = state._dailyPeakProfit ?? null;
  const trades = state._dailyTrades || [];
  const estClose = Math.round(trades.reduce((a, t) => a + (t.pnl || 0), 0));

  // Real closing P&L from Alpaca if keys are available (more accurate)
  let realClose = null;
  const K = process.env.ALPACA_KEY, S = process.env.ALPACA_SECRET;
  if (K && S) {
    try {
      const res = await fetch("https://paper-api.alpaca.markets/v2/account", {
        headers: { "APCA-API-KEY-ID": K, "APCA-API-SECRET-KEY": S },
      });
      const a = await res.json();
      const eq = parseFloat(a.portfolio_value);
      const last = parseFloat(a.last_equity || a.equity);
      if (!isNaN(eq) && !isNaN(last)) realClose = Math.round(eq - last);
    } catch (e) {
      console.error("Alpaca fetch failed:", e.message);
    }
  }

  fs.appendFileSync("peaks.jsonl", JSON.stringify({
    day: today,
    peak: peak !== null ? Math.round(peak) : null,
    close: realClose !== null ? realClose : estClose,
    estClose,
    realClose,
    protectedFlag: !!state._profitProtected,
    trades: trades.length,
  }) + "\n");
  console.log(`Recorded peak for ${today}: peak=${peak} close=${realClose ?? estClose}`);
}

function joinToday() {
  const research = readJSON("research_log.json", []);
  const state = readJSON("state.json", {});
  const trades = state._dailyTrades || [];
  const today = state._date;
  if (!today || trades.length === 0) {
    console.log("No trades to join today.");
    return 0;
  }

  const existing = readJSONL("outcomes.jsonl");
  const alreadyDone = new Set(existing.map(r => `${r.day}|${r.symbol}|${r.entryPremium}`));

  const todaysFeatures = research.filter(r => r.day === today);
  let added = 0;

  for (const tr of trades) {
    if (tr.window === "RECOVERED" || tr.setup === "Recovered from Alpaca") continue; // not a clean signal
    const key = `${today}|${tr.symbol}|${tr.entryPremium}`;
    if (alreadyDone.has(key)) continue;

    // match feature row by symbol + signal + entry premium (tolerance for rounding)
    const f = todaysFeatures.find(x =>
      x.symbol === tr.symbol &&
      x.signal === tr.signal &&
      Math.abs((x.entryPremium || 0) - tr.entryPremium) < 0.02
    );
    if (!f) continue;

    fs.appendFileSync("outcomes.jsonl", JSON.stringify({
      day: today,
      symbol: tr.symbol,
      signal: tr.signal,
      window: tr.window,
      entryPremium: tr.entryPremium,
      pnl: Math.round(tr.pnl),
      pnlPct: +tr.pnlPct.toFixed(1),
      win: tr.pnl > 0,
      reason: tr.reason,
      // features captured at entry
      beyond: f.closedBeyondLevel,
      volR: f.volRatio,
      volSurge: f.volSurge,
      body: f.bodyPct,
      rsi: f.rsi,
      level: f.level,
      entryStockPrice: f.entryStockPrice,
    }) + "\n");
    added++;
  }
  console.log(`Joined ${added} trades for ${today}`);
  return added;
}

// ---------- STEP 2: ANALYZE everything accumulated ----------
function pct(n, d) { return d ? Math.round(n / d * 100) : 0; }

function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function line(label, rows) {
  const w = rows.filter(r => r.win).length;
  const net = rows.reduce((a, r) => a + r.pnl, 0);
  return `${label}: ${rows.length}ص | ${pct(w, rows.length)}% | ${net >= 0 ? "+" : ""}$${net}`;
}

function analyze() {
  const rows = readJSONL("outcomes.jsonl");
  if (rows.length < 5) {
    return `📊 <b>تحليل البيانات</b>\n\nالعينة صغيرة (${rows.length} صفقة). نحتاج 20+ للتحليل.`;
  }

  const days = [...new Set(rows.map(r => r.day))].sort();
  const wins = rows.filter(r => r.win).length;
  const net = rows.reduce((a, r) => a + r.pnl, 0);

  let m = `📊 <b>تحليل تراكمي</b>\n`;
  m += `${days.length} أيام | ${rows.length} صفقة | WR ${pct(wins, rows.length)}% | ${net >= 0 ? "+" : ""}$${net}\n`;

  // 1. THE KEY HYPOTHESIS: breakout vs rejection
  m += `\n<b>1️⃣ اختراق ضد ارتداد</b>\n`;
  const B = rows.filter(r => r.beyond === true);
  const N = rows.filter(r => r.beyond === false);
  if (B.length) m += `  ${line("دخلنا ضد اختراق", B)}\n`;
  if (N.length) m += `  ${line("رفض حقيقي", N)}\n`;
  if (B.length >= 5 && N.length >= 5) {
    const wb = pct(B.filter(r => r.win).length, B.length);
    const wn = pct(N.filter(r => r.win).length, N.length);
    m += `  ← ${wb > wn ? "الاختراق أفضل" : wn > wb ? "الارتداد أفضل" : "متساويان"} (${wb}% مقابل ${wn}%)\n`;
  }

  // 2. Volume
  m += `\n<b>2️⃣ الحجم</b>\n`;
  const S = rows.filter(r => r.volSurge === true);
  const NS = rows.filter(r => r.volSurge === false);
  if (S.length) m += `  ${line("حجم مرتفع", S)}\n`;
  if (NS.length) m += `  ${line("حجم عادي", NS)}\n`;

  // 3. Windows
  m += `\n<b>3️⃣ النوافذ</b>\n`;
  const gw = [...group(rows, r => r.window)].sort((a, b) =>
    b[1].reduce((x, r) => x + r.pnl, 0) - a[1].reduce((x, r) => x + r.pnl, 0));
  for (const [k, v] of gw) m += `  ${line(k.replace("_Pullback", "").replace("_VWAP", "").replace("_Resume", "").replace("_Day_Fade", "Fade"), v)}\n`;

  // 4. Symbols
  m += `\n<b>4️⃣ الأسهم</b>\n`;
  const gs = [...group(rows, r => r.symbol)].sort((a, b) =>
    b[1].reduce((x, r) => x + r.pnl, 0) - a[1].reduce((x, r) => x + r.pnl, 0));
  for (const [k, v] of gs) m += `  ${line(k, v)}\n`;

  // 5. Direction
  m += `\n<b>5️⃣ الاتجاه</b>\n`;
  for (const [k, v] of group(rows, r => r.signal)) m += `  ${line(k, v)}\n`;

  // 6. RSI buckets
  m += `\n<b>6️⃣ RSI</b>\n`;
  for (const [k, v] of [...group(rows, r => r.rsi < 40 ? "تحت 40" : r.rsi > 60 ? "فوق 60" : "40-60")].sort()) {
    m += `  ${line(k, v)}\n`;
  }

  // 7. Rejected-signal context + FORWARD MOVE analysis
  const ml = readJSONL("market_log.jsonl");
  if (ml.length) {
    const neutral = ml.filter(r => r.sig === "NEUTRAL").length;
    m += `\n<b>7️⃣ الإشارات</b>\n  مرفوضة ${neutral} | مقبولة ${ml.length - neutral} (من ${ml.length} تقييم)\n`;
    m += analyzeForward(ml);
  }

  m += `\n<i>ص = صفقة | النسبة = WR</i>`;
  return m + analyzePeaks();
}

// ---------- PEAK vs CLOSE: how often does a good day collapse? ----------
function analyzePeaks() {
  const rows = readJSONL("peaks.jsonl");
  if (rows.length === 0) return "";

  let s = `\n\n<b>9️⃣ القمة مقابل الإغلاق</b>\n`;
  for (const r of rows.slice(-10)) {
    const p = r.peak !== null ? `+$${r.peak}` : "—";
    const c = `${r.close >= 0 ? "+" : ""}$${r.close}`;
    const gap = r.peak !== null ? r.peak - r.close : null;
    const flag = r.protectedFlag ? " 🛡" : "";
    s += `  ${r.day.slice(5)}: قمة ${p} → إغلاق ${c}${gap !== null && gap > 0 ? ` (فقد $${Math.round(gap)})` : ""}${flag}\n`;
  }

  // Which activation threshold would have caught the collapses?
  const withPeak = rows.filter(r => r.peak !== null);
  if (withPeak.length >= 3) {
    s += `\n  <b>أي عتبة كانت تمسك؟</b>\n`;
    for (const th of [500, 700, 900, 1200]) {
      const hit = withPeak.filter(r => r.peak >= th);
      const saved = hit.filter(r => r.peak - r.close >= 300);
      s += `  $${th}: تتفعّل ${hit.length}/${withPeak.length} يوم | تنقذ ${saved.length}\n`;
    }
  }
  return s;
}

// ---------- FORWARD MOVE: what did price do AFTER each evaluation? ----------
// Uses market_log itself as the price series (every symbol is re-evaluated
// every ~5 min while it has no open position, so rejected signals have a
// continuous track). No extra API calls needed.
function analyzeForward(ml) {
  // index snapshots by symbol+day, sorted by time
  const series = new Map();
  for (const r of ml) {
    if (!r.px || !r.t) continue;
    const k = `${r.d}|${r.s}`;
    if (!series.has(k)) series.set(k, []);
    series.get(k).push(r);
  }
  for (const arr of series.values()) arr.sort((a, b) => new Date(a.t) - new Date(b.t));

  // For each snapshot, find the price ~30 min later and the max excursion
  const HORIZON_MS = 30 * 60 * 1000;
  const results = [];
  for (const [k, arr] of series) {
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i];
      const t0 = new Date(cur.t).getTime();
      const fut = arr.filter(x => {
        const dt = new Date(x.t).getTime() - t0;
        return dt > 0 && dt <= HORIZON_MS;
      });
      if (fut.length < 2) continue; // need enough forward data
      const highs = Math.max(...fut.map(x => x.px));
      const lows = Math.min(...fut.map(x => x.px));
      const upMove = (highs - cur.px) / cur.px * 100;
      const dnMove = (cur.px - lows) / cur.px * 100;
      results.push({
        sig: cur.sig,
        rsn: cur.rsn || "",
        upMove: +upMove.toFixed(2),
        dnMove: +dnMove.toFixed(2),
        maxMove: +Math.max(upMove, dnMove).toFixed(2),
      });
    }
  }

  if (results.length < 20) {
    return `\n<b>8️⃣ حركة السعر بعد التقييم</b>\n  بيانات غير كافية (${results.length})\n`;
  }

  const rejected = results.filter(r => r.sig === "NEUTRAL");
  const taken = results.filter(r => r.sig !== "NEUTRAL");

  // A 0DTE option roughly doubles on ~0.3-0.5% underlying move; use 0.3% as
  // the "tradeable move" threshold.
  const TRADEABLE = 0.3;
  const bigRej = rejected.filter(r => r.maxMove >= TRADEABLE).length;
  const bigTaken = taken.filter(r => r.maxMove >= TRADEABLE).length;

  const avg = a => a.length ? (a.reduce((x, r) => x + r.maxMove, 0) / a.length).toFixed(2) : "0";

  let s = `\n<b>8️⃣ حركة السعر خلال 30 دقيقة</b>\n`;
  s += `  مرفوضة: ${rejected.length} | متوسط الحركة ${avg(rejected)}%\n`;
  s += `    منها ${bigRej} (${pct(bigRej, rejected.length)}%) تحرّكت ${TRADEABLE}%+\n`;
  if (taken.length) {
    s += `  مقبولة: ${taken.length} | متوسط الحركة ${avg(taken)}%\n`;
    s += `    منها ${bigTaken} (${pct(bigTaken, taken.length)}%) تحرّكت ${TRADEABLE}%+\n`;
  }
  if (taken.length >= 10) {
    const at = parseFloat(avg(taken)), ar = parseFloat(avg(rejected));
    s += `  ← ${at > ar ? "المقبولة تتحرك أكثر ✅ (الفلتر يشتغل)" : "المرفوضة تتحرك أكثر ⚠️ (الفلتر يرفض الفرص)"}\n`;
  }
  return s;
}

(async () => {
  console.log("=== Analysis", new Date().toISOString(), "===");
  await recordPeak();
  const added = joinToday();
  const report = analyze();
  console.log(report.replace(/<[^>]+>/g, ""));
  await sendTelegram(report);
  console.log(`Done. Added ${added} rows.`);
})();
