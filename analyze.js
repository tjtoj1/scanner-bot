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

  // 7. Rejected-signal context from market_log
  const ml = readJSONL("market_log.jsonl");
  if (ml.length) {
    const neutral = ml.filter(r => r.sig === "NEUTRAL").length;
    m += `\n<b>7️⃣ الإشارات</b>\n  مرفوضة ${neutral} | مقبولة ${ml.length - neutral} (من ${ml.length} تقييم)\n`;
  }

  m += `\n<i>ص = صفقة | النسبة = WR</i>`;
  return m;
}

(async () => {
  console.log("=== Analysis", new Date().toISOString(), "===");
  const added = joinToday();
  const report = analyze();
  console.log(report.replace(/<[^>]+>/g, ""));
  await sendTelegram(report);
  console.log(`Done. Added ${added} rows.`);
})();
