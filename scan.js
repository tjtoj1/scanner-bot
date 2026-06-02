const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
const MIN_SCORE     = parseInt(process.env.MIN_SCORE || "50");
const SEND_SUMMARY  = process.env.SEND_SUMMARY === "true";

if (!ALPACA_KEY || !ALPACA_SECRET || !TG_TOKEN || !TG_CHAT_ID) {
  console.error("Missing env vars");
  process.exit(1);
}

const TICKERS = ["SPY", "QQQ", "NVDA", "TSLA", "META", "AAPL", "MSTR"];

const META = {
  SPY:  { strikeStep: 1,   posSize: "100%",     risk: "normal",   ivCategory: "low",     wallPct: 0.005 },
  QQQ:  { strikeStep: 1,   posSize: "100%",     risk: "normal",   ivCategory: "low",     wallPct: 0.006 },
  NVDA: { strikeStep: 1,   posSize: "50% only", risk: "elevated", ivCategory: "high",    wallPct: 0.015 },
  TSLA: { strikeStep: 1,   posSize: "50% only", risk: "elevated", ivCategory: "high",    wallPct: 0.018 },
  META: { strikeStep: 2.5, posSize: "100%",     risk: "normal",   ivCategory: "medium",  wallPct: 0.010 },
  AAPL: { strikeStep: 1,   posSize: "100%",     risk: "normal",   ivCategory: "low",     wallPct: 0.007 },
  MSTR: { strikeStep: 5,   posSize: "25% only", risk: "extreme",  ivCategory: "extreme", wallPct: 0.030 },
};

const ALPACA_HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
};

async function getLatestTrade(symbol) {
  const r = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/trades/latest?feed=iex`, { headers: ALPACA_HEADERS });
  if (!r.ok) throw new Error(`Trade ${symbol}: HTTP ${r.status}`);
  return (await r.json()).trade;
}

async function getBars(symbol, timeframe, daysBack) {
  const end = new Date(Date.now() - 60000).toISOString();
  const start = new Date(Date.now() - daysBack * 86400000).toISOString();
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&feed=iex&limit=500&adjustment=raw`;
  const r = await fetch(url, { headers: ALPACA_HEADERS });
  if (!r.ok) throw new Error(`Bars ${symbol} ${timeframe}: HTTP ${r.status}`);
  return (await r.json()).bars || [];
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function macd(closes) {
  if (closes.length < 35) return null;
  const vals = [];
  for (let i = 25; i < closes.length; i++) {
    const e12 = ema(closes.slice(0, i + 1), 12);
    const e26 = ema(closes.slice(0, i + 1), 26);
    if (e12 && e26) vals.push(e12 - e26);
  }
  const line = vals[vals.length - 1];
  const sig = vals.length >= 9 ? ema(vals, 9) : null;
  const hist = sig !== null ? line - sig : null;
  return {
    histogram: hist ? parseFloat(hist.toFixed(4)) : null,
    bias: hist > 0.01 ? "bullish" : hist < -0.01 ? "bearish" : "neutral",
  };
}

function bollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return {
    upper: parseFloat((mean + 2 * std).toFixed(2)),
    middle: parseFloat(mean.toFixed(2)),
    lower: parseFloat((mean - 2 * std).toFixed(2)),
  };
}

function vwap(bars) {
  let tv = 0, v = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    tv += tp * b.v;
    v += b.v;
  }
  return v > 0 ? parseFloat((tv / v).toFixed(2)) : null;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  return parseFloat((closes.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(2));
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = bars.slice(1).map((c, i) =>
    Math.max(c.h - c.l, Math.abs(c.h - bars[i].c), Math.abs(c.l - bars[i].c))
  );
  return parseFloat((trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(3));
}

function estimateGamma(symbol, price, atr5m, vwap, sma20, bollinger) {
  const meta = META[symbol];
  const baseWallPct = meta.wallPct;

  const atrPct = atr5m && price ? (atr5m / price) : 0.005;
  const dynamicAdj = Math.min(atrPct * 2, baseWallPct * 0.5);
  const wallDist = baseWallPct + dynamicAdj;

  const callWallRaw = price * (1 + wallDist);
  const putWallRaw = price * (1 - wallDist);

  const callWall = Math.round(callWallRaw / meta.strikeStep) * meta.strikeStep;
  const putWall = Math.round(putWallRaw / meta.strikeStep) * meta.strikeStep;

  const gammaFlip = vwap && sma20 ? parseFloat(((vwap + sma20) / 2).toFixed(2)) : parseFloat(bollinger?.middle.toFixed(2)) || price;

  let gammaRegime = "neutral";
  if (price > gammaFlip * 1.002) gammaRegime = "positive";
  else if (price < gammaFlip * 0.998) gammaRegime = "negative";

  const callWallDist = ((callWall - price) / price * 100).toFixed(2);
  const putWallDist = ((price - putWall) / price * 100).toFixed(2);

  let proximityWarning = null;
  if (Math.abs(price - callWall) / price < 0.003) proximityWarning = "near_call_wall";
  else if (Math.abs(price - putWall) / price < 0.003) proximityWarning = "near_put_wall";

  return {
    callWall, putWall, gammaFlip, gammaRegime,
    callWallDist: parseFloat(callWallDist),
    putWallDist: parseFloat(putWallDist),
    proximityWarning,
    confidence: "estimated",
  };
}

function detectSetup(d) {
  if (d.volRatio > 2 && d.macd5m.bias === "bullish" && d.price > d.vwap) {
    return { name: "Order Flow", quality: "excellent", direction: "CALL" };
  }
  if (d.volRatio > 2 && d.macd5m.bias === "bearish" && d.price < d.vwap) {
    return { name: "Order Flow", quality: "excellent", direction: "PUT" };
  }
  if (d.price > d.bollinger.upper && d.volRatio > 1.3) {
    return { name: "Breakout Up", quality: "excellent", direction: "CALL" };
  }
  if (d.price < d.bollinger.lower && d.volRatio > 1.3) {
    return { name: "Breakout Down", quality: "excellent", direction: "PUT" };
  }
  if (d.gamma?.proximityWarning === "near_put_wall" && d.macd5m.bias === "bullish") {
    return { name: "Put Wall Bounce", quality: "excellent", direction: "CALL" };
  }
  if (d.gamma?.proximityWarning === "near_call_wall" && d.macd5m.bias === "bearish") {
    return { name: "Call Wall Rejection", quality: "excellent", direction: "PUT" };
  }
  const vwapDist = Math.abs(d.price - d.vwap) / d.vwap;
  if (vwapDist < 0.003 && d.macd5m.bias === "bullish" && d.rsi5m > 45 && d.rsi5m < 65) {
    return { name: "VWAP Bounce Up", quality: "good", direction: "CALL" };
  }
  if (vwapDist < 0.003 && d.macd5m.bias === "bearish" && d.rsi5m < 55 && d.rsi5m > 35) {
    return { name: "VWAP Bounce Down", quality: "good", direction: "PUT" };
  }
  if (d.rsi5m < 30) {
    return { name: "Oversold", quality: "good", direction: "CALL" };
  }
  if (d.rsi5m > 70) {
    return { name: "Overbought", quality: "good", direction: "PUT" };
  }
  if (d.price > d.bollinger.middle && d.macd5m.bias === "bullish") {
    return { name: "Momentum Up", quality: "fair", direction: "CALL" };
  }
  if (d.price < d.bollinger.middle && d.macd5m.bias === "bearish") {
    return { name: "Momentum Down", quality: "fair", direction: "PUT" };
  }
  return null;
}

function scoreBullish(d) {
  let s = 0;
  const reasons = [];
  if (d.macd5m?.bias === "bullish")  { s += 15; reasons.push("MACD 5m+"); }
  if (d.macd15m?.bias === "bullish") { s += 15; reasons.push("MACD 15m+"); }
  if (d.price > d.vwap)              { s += 15; reasons.push("Above VWAP"); }
  if (d.sma20 && d.price > d.sma20)  { s += 10; reasons.push("Above SMA20"); }
  if (d.sma50 && d.price > d.sma50)  { s += 5;  reasons.push("Above SMA50"); }
  if (d.rsi5m > 50 && d.rsi5m < 70)  { s += 10; reasons.push("RSI healthy"); }
  if (d.rsi5m < 30)                   { s += 15; reasons.push("RSI oversold"); }
  if (d.volRatio > 1.5)              { s += 10; reasons.push(`Vol ${d.volRatio}x`); }
  if (d.volRatio > 2.5)              { s += 5;  reasons.push("Vol spike"); }
  if (d.price > d.bollinger.upper)   { s += 10; reasons.push("Above BB upper"); }
  if (d.gamma?.gammaRegime === "positive") { s += 8; reasons.push("+Gamma regime"); }
  if (d.gamma?.proximityWarning === "near_put_wall") { s += 12; reasons.push("Near Put Wall (support)"); }
  return { score: s, reasons };
}

function scoreBearish(d) {
  let s = 0;
  const reasons = [];
  if (d.macd5m?.bias === "bearish")  { s += 15; reasons.push("MACD 5m-"); }
  if (d.macd15m?.bias === "bearish") { s += 15; reasons.push("MACD 15m-"); }
  if (d.price < d.vwap)              { s += 15; reasons.push("Below VWAP"); }
  if (d.sma20 && d.price < d.sma20)  { s += 10; reasons.push("Below SMA20"); }
  if (d.sma50 && d.price < d.sma50)  { s += 5;  reasons.push("Below SMA50"); }
  if (d.rsi5m < 50 && d.rsi5m > 30)  { s += 10; reasons.push("RSI weak"); }
  if (d.rsi5m > 70)                   { s += 15; reasons.push("RSI overbought"); }
  if (d.volRatio > 1.5)              { s += 10; reasons.push(`Vol ${d.volRatio}x`); }
  if (d.volRatio > 2.5)              { s += 5;  reasons.push("Vol spike"); }
  if (d.price < d.bollinger.lower)   { s += 10; reasons.push("Below BB lower"); }
  if (d.gamma?.gammaRegime === "negative") { s += 8; reasons.push("-Gamma regime"); }
  if (d.gamma?.proximityWarning === "near_call_wall") { s += 12; reasons.push("Near Call Wall (resistance)"); }
  return { score: s, reasons };
}

async function analyzeTicker(symbol) {
  const [trade, bars5m, bars15m] = await Promise.all([
    getLatestTrade(symbol),
    getBars(symbol, "5Min", 3),
    getBars(symbol, "15Min", 5),
  ]);

  if (!bars5m.length || !bars15m.length) return { symbol, error: "no bars" };

  const price = trade.p;
  const closes5m = bars5m.map(b => b.c);
  const closes15m = bars15m.map(b => b.c);

  const rsi5m = rsi(closes5m);
  const rsi15m = rsi(closes15m);
  const macd5m = macd(closes5m);
  const macd15m = macd(closes15m);
  const boll = bollinger(closes5m);
  const vwap5m = vwap(bars5m.slice(-78));
  const sma20 = sma(closes5m, 20);
  const sma50 = sma(closes5m, 50);
  const atr5m = atr(bars5m);

  const lastBar = bars5m[bars5m.length - 1];
  const avgVol = bars5m.slice(-10).reduce((a, b) => a + b.v, 0) / 10;
  const volRatio = parseFloat((lastBar.v / avgVol).toFixed(2));

  const prevClose = bars5m[Math.max(0, bars5m.length - 78)]?.c || price;
  const pct = parseFloat(((price - prevClose) / prevClose * 100).toFixed(2));

  const gamma = estimateGamma(symbol, price, atr5m, vwap5m, sma20, boll);

  const indicators = {
    price, rsi5m, rsi15m, macd5m, macd15m, bollinger: boll,
    vwap: vwap5m, sma20, sma50, volRatio, gamma,
  };

  const bull = scoreBullish(indicators);
  const bear = scoreBearish(indicators);

  const setup = detectSetup(indicators);
  let setupBonus = 0;
  if (setup) {
    setupBonus = setup.quality === "excellent" ? 20 : setup.quality === "good" ? 12 : 5;
  }

  let signal = "NEUTRAL";
  let score = 0;
  let reasons = [];

  if (bull.score > bear.score && bull.score >= 25) {
    signal = "CALL";
    score = bull.score + (setup?.direction === "CALL" ? setupBonus : 0);
    reasons = bull.reasons;
    if (setup?.direction === "CALL") reasons.push(`Setup: ${setup.name}`);
  } else if (bear.score > bull.score && bear.score >= 25) {
    signal = "PUT";
    score = bear.score + (setup?.direction === "PUT" ? setupBonus : 0);
    reasons = bear.reasons;
    if (setup?.direction === "PUT") reasons.push(`Setup: ${setup.name}`);
  }

  score = Math.min(score, 95);

  const strengthAr = score >= 80 ? "قوية جداً"
                   : score >= 65 ? "قوية"
                   : score >= 50 ? "متوسطة"
                   : score >= 35 ? "ضعيفة"
                   : "محايد";

  const meta = META[symbol];
  const atmStrike = Math.round(price / meta.strikeStep) * meta.strikeStep;

  return {
    symbol, price: parseFloat(price.toFixed(2)), pct, volRatio,
    rsi5m, rsi15m,
    macd5m: macd5m?.bias, macd15m: macd15m?.bias,
    vwap: vwap5m, vwapBias: price > vwap5m ? "above" : "below",
    gamma,
    setup, signal, strengthAr, score, reasons,
    suggestedStrike: atmStrike, riskNote: meta.risk, posSize: meta.posSize,
    bullScore: bull.score, bearScore: bear.score,
  };
}

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) console.error(`Telegram error: ${await r.text()}`);
  return r.ok;
}

function formatAlert(r) {
  const emoji = r.signal === "CALL" ? "📈" : "📉";
  const arrow = r.pct >= 0 ? "▲" : "▼";
  const g = r.gamma;
  const gammaEmoji = g.gammaRegime === "positive" ? "🟢" : g.gammaRegime === "negative" ? "🔴" : "⚪";

  return `🚨 <b>${r.symbol} — ${emoji} ${r.signal} ${r.strengthAr}</b> (${r.score}%)

💵 <b>السعر:</b> $${r.price} ${arrow}${Math.abs(r.pct)}%
📊 <b>المخاطرة:</b> ${r.riskNote} · <b>حجم:</b> ${r.posSize}

${r.setup ? `<b>🎯 Setup:</b> ${r.setup.name} (${r.setup.quality})\n` : ""}<b>📊 المؤشرات:</b>
• RSI 5m: <code>${r.rsi5m}</code> / 15m: <code>${r.rsi15m}</code>
• MACD: 5m ${r.macd5m === "bullish" ? "🟢" : r.macd5m === "bearish" ? "🔴" : "⚪"} / 15m ${r.macd15m === "bullish" ? "🟢" : r.macd15m === "bearish" ? "🔴" : "⚪"}
• VWAP: $${r.vwap} (${r.vwapBias === "above" ? "فوق ✓" : "تحت ✗"})
• Volume: <b>${r.volRatio}x</b>

<b>🎯 Gamma (تقديري):</b>
• Call Wall: $${g.callWall} (+${g.callWallDist}%)
• Put Wall: $${g.putWall} (-${g.putWallDist}%)
• Gamma Flip: $${g.gammaFlip}
• Regime: ${gammaEmoji} ${g.gammaRegime}${g.proximityWarning ? `\n• ⚠ <b>${g.proximityWarning === "near_call_wall" ? "قرب Call Wall — مقاومة" : "قرب Put Wall — دعم"}</b>` : ""}

<b>✓ التأكيدات:</b>
${r.reasons.map(x => `• ${x}`).join("\n")}

━━━━━━━━━━━━━━━━━━━
⭐ <b>اقتراح العقد (0DTE):</b>
${r.signal} <b>$${r.suggestedStrike}</b> — ينتهي اليوم
🎯 هدف: <b>+35%</b> على Premium
🛑 وقف: <b>-30%</b> على Premium
⏱ مدة: 5-30 دقيقة

⚠ افتح Webull للسعر الحقيقي
⚠ Gamma Walls تقديرية وليست من Options Chain حقيقي
⚠ ${r.posSize}`;
}

function formatSummary(results) {
  const sorted = [...results].sort((a, b) => (b.score || 0) - (a.score || 0));
  let msg = `📊 <b>ملخص الفحص</b>\n${new Date().toLocaleString("ar-SA", { timeZone: "America/Chicago" })}\n\n`;
  for (const r of sorted) {
    if (r.error) {
      msg += `❌ <b>${r.symbol}</b>: ${r.error}\n`;
      continue;
    }
    const emoji = r.signal === "CALL" ? "🟢" : r.signal === "PUT" ? "🔴" : "⚪";
    const setupTxt = r.setup ? r.setup.name : "—";
    const gammaTxt = r.gamma ? `[CW:$${r.gamma.callWall} PW:$${r.gamma.putWall}]` : "";
    msg += `${emoji} <b>${r.symbol}</b> $${r.price} | ${r.signal} ${r.score}% | ${setupTxt} ${gammaTxt}\n`;
  }
  return msg;
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 14 * 60 + 30 && utcMin <= 19 * 60;
}

async function main() {
  console.log(`\n=== Scan started ${new Date().toISOString()} ===`);
  console.log(`MIN_SCORE = ${MIN_SCORE}, SEND_SUMMARY = ${SEND_SUMMARY}`);

  if (!isMarketOpen()) {
    console.log("Market closed, skipping");
    return;
  }

  const results = [];
  for (const symbol of TICKERS) {
    try {
      const r = await analyzeTicker(symbol);
      results.push(r);
      const g = r.gamma;
      console.log(`OK ${symbol}: $${r.price} | ${r.signal} ${r.score}% (b:${r.bullScore} s:${r.bearScore}) | CW:$${g.callWall} PW:$${g.putWall} | ${r.setup?.name || "-"}`);
    } catch (e) {
      console.error(`FAIL ${symbol}: ${e.message}`);
      results.push({ symbol, error: e.message });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const alerts = results.filter(r => !r.error && r.score >= MIN_SCORE);
  console.log(`Alerts: ${alerts.length} / ${results.length}`);

  for (const r of alerts) {
    await sendTelegram(formatAlert(r));
    console.log(`Sent: ${r.symbol}`);
  }

  if (SEND_SUMMARY && alerts.length === 0) {
    await sendTelegram(formatSummary(results));
    console.log("Sent summary");
  }

  console.log(`=== Done ===\n`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  sendTelegram(`Bot error: ${e.message}`).catch(() => {});
  process.exit(1);
});
