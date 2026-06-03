import { readFileSync, writeFileSync, existsSync } from "fs";

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
const MIN_SCORE     = parseInt(process.env.MIN_SCORE || "65");
const SEND_SUMMARY  = process.env.SEND_SUMMARY === "true";
const STATE_FILE    = "state.json";

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

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

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

function calculateLiquidity(bars5m, atr5m, price) {
  if (!bars5m || bars5m.length < 5) return { score: 0, reasons: [], tier: "none" };

  let score = 0;
  const reasons = [];

  const recentBars = bars5m.slice(-5);
  const lastBar = recentBars[recentBars.length - 1];
  const avgVol = bars5m.slice(-20).reduce((a, b) => a + b.v, 0) / Math.min(bars5m.length, 20);
  const currentVolRatio = lastBar.v / avgVol;

  if (currentVolRatio > 5) {
    score += 35;
    reasons.push(`Volume ${currentVolRatio.toFixed(1)}x (massive)`);
  } else if (currentVolRatio > 3) {
    score += 25;
    reasons.push(`Volume ${currentVolRatio.toFixed(1)}x (strong)`);
  } else if (currentVolRatio > 2) {
    score += 15;
    reasons.push(`Volume ${currentVolRatio.toFixed(1)}x`);
  } else if (currentVolRatio > 1.5) {
    score += 8;
    reasons.push(`Volume ${currentVolRatio.toFixed(1)}x (elevated)`);
  }

  let strongBarsCount = 0;
  for (let i = recentBars.length - 1; i >= 0; i--) {
    const bar = recentBars[i];
    const barAvgVol = bars5m.slice(Math.max(0, bars5m.length - 20 + (i - recentBars.length)), bars5m.length + (i - recentBars.length + 1)).reduce((a, b) => a + b.v, 0) / 20;
    if (bar.v > barAvgVol * 1.5) {
      strongBarsCount++;
    } else {
      break;
    }
  }
  if (strongBarsCount >= 3) {
    score += 20;
    reasons.push(`${strongBarsCount} consecutive strong bars`);
  } else if (strongBarsCount >= 2) {
    score += 10;
    reasons.push(`${strongBarsCount} strong bars`);
  }

  if (atr5m && lastBar) {
    const barRange = lastBar.h - lastBar.l;
    const rangeVsAtr = barRange / atr5m;
    if (rangeVsAtr > 2) {
      score += 15;
      reasons.push(`Range ${rangeVsAtr.toFixed(1)}x ATR`);
    } else if (rangeVsAtr > 1.5) {
      score += 8;
      reasons.push(`Range ${rangeVsAtr.toFixed(1)}x ATR`);
    }
  }

  const barTotal = lastBar.h - lastBar.l;
  if (barTotal > 0) {
    const closePos = (lastBar.c - lastBar.l) / barTotal;
    if (closePos > 0.8) {
      score += 8;
      reasons.push("Strong buying pressure");
    } else if (closePos < 0.2) {
      score += 8;
      reasons.push("Strong selling pressure");
    }
  }

  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const totalMin = utcHour * 60 + utcMin;
  
  if ((totalMin >= 14 * 60 + 30 && totalMin <= 15 * 60 + 30) ||
      (totalMin >= 18 * 60 + 30 && totalMin <= 19 * 60)) {
    score += 10;
    reasons.push("Prime trading hour");
  } else if (totalMin >= 17 * 60 + 30 && totalMin <= 18 * 60 + 30) {
    score -= 5;
    reasons.push("Low activity time");
  }

  if (recentBars.length >= 3) {
    const lastClose = recentBars[recentBars.length - 1].c;
    const prevClose = recentBars[recentBars.length - 2].c;
    const prev2Close = recentBars[recentBars.length - 3].c;
    
    const move1 = Math.abs(lastClose - prevClose);
    const move2 = Math.abs(prevClose - prev2Close);
    
    if (move1 > move2 * 1.5 && currentVolRatio > 1.5) {
      score += 12;
      reasons.push("Price acceleration");
    }
  }

  score = Math.max(0, Math.min(score, 100));

  let tier;
  if (score >= 86) tier = "whale";
  else if (score >= 71) tier = "very_strong";
  else if (score >= 51) tier = "strong";
  else if (score >= 31) tier = "elevated";
  else tier = "normal";

  return { score, reasons, tier };
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
  if (d.volRatio > 2 && d.macd5m.bias === "bullish" && d.price > d.vwap) return { name: "Order Flow", quality: "excellent", direction: "CALL" };
  if (d.volRatio > 2 && d.macd5m.bias === "bearish" && d.price < d.vwap) return { name: "Order Flow", quality: "excellent", direction: "PUT" };
  if (d.price > d.bollinger.upper && d.volRatio > 1.3) return { name: "Breakout Up", quality: "excellent", direction: "CALL" };
  if (d.price < d.bollinger.lower && d.volRatio > 1.3) return { name: "Breakout Down", quality: "excellent", direction: "PUT" };
  if (d.gamma?.proximityWarning === "near_put_wall" && d.macd5m.bias === "bullish") return { name: "Put Wall Bounce", quality: "excellent", direction: "CALL" };
  if (d.gamma?.proximityWarning === "near_call_wall" && d.macd5m.bias === "bearish") return { name: "Call Wall Rejection", quality: "excellent", direction: "PUT" };
  const vwapDist = Math.abs(d.price - d.vwap) / d.vwap;
  if (vwapDist < 0.003 && d.macd5m.bias === "bullish" && d.rsi5m > 45 && d.rsi5m < 65) return { name: "VWAP Bounce Up", quality: "good", direction: "CALL" };
  if (vwapDist < 0.003 && d.macd5m.bias === "bearish" && d.rsi5m < 55 && d.rsi5m > 35) return { name: "VWAP Bounce Down", quality: "good", direction: "PUT" };
  if (d.rsi5m < 30) return { name: "Oversold", quality: "good", direction: "CALL" };
  if (d.rsi5m > 70) return { name: "Overbought", quality: "good", direction: "PUT" };
  if (d.price > d.bollinger.middle && d.macd5m.bias === "bullish") return { name: "Momentum Up", quality: "fair", direction: "CALL" };
  if (d.price < d.bollinger.middle && d.macd5m.bias === "bearish") return { name: "Momentum Down", quality: "fair", direction: "PUT" };
  return null;
}

function scoreBullish(d) {
  let s = 0; const reasons = [];
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
  let s = 0; const reasons = [];
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
  const liquidity = calculateLiquidity(bars5m, atr5m, price);

  const indicators = {
    price, rsi5m, rsi15m, macd5m, macd15m, bollinger: boll,
    vwap: vwap5m, sma20, sma50, volRatio, gamma,
  };

  const bull = scoreBullish(indicators);
  const bear = scoreBearish(indicators);

  const setup = detectSetup(indicators);
  let setupBonus = 0;
  if (setup) setupBonus = setup.quality === "excellent" ? 20 : setup.quality === "good" ? 12 : 5;

  let signal = "NEUTRAL", score = 0, reasons = [];

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
  const STRIKE_OFFSET = parseInt(process.env.STRIKE_OFFSET || "1");
  const atmStrike = Math.round(price / meta.strikeStep) * meta.strikeStep;
  const suggestedStrike = signal === "CALL" ? atmStrike + (STRIKE_OFFSET * meta.strikeStep)
                        : signal === "PUT"  ? atmStrike - (STRIKE_OFFSET * meta.strikeStep)
                        : atmStrike;

  return {
    symbol, price: parseFloat(price.toFixed(2)), pct, volRatio,
    rsi5m, rsi15m,
    macd5m: macd5m?.bias, macd15m: macd15m?.bias,
    vwap: vwap5m, vwapBias: price > vwap5m ? "above" : "below",
    gamma, liquidity, setup, signal, strengthAr, score, reasons,
    suggestedStrike, riskNote: meta.risk, posSize: meta.posSize,
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

function formatNewAlert(r) {
  const arrow = r.pct >= 0 ? "▲" : "▼";
  const signalEmoji = r.signal === "CALL" ? "🟢" : "🔴";
  const g = r.gamma;
  const gammaEmoji = g.gammaRegime === "positive" ? "🟢" : g.gammaRegime === "negative" ? "🔴" : "⚪";
  
  const liq = r.liquidity;
  let liquiditySection = "";
  let whaleHeader = "";
  
  if (liq && liq.score >= 51) {
    let tierEmoji, tierName;
    if (liq.tier === "whale") {
      tierEmoji = "🐋";
      tierName = "Whale";
      whaleHeader = "\n🐋 <b>WHALE ACTIVITY!</b>";
    } else if (liq.tier === "very_strong") {
      tierEmoji = "💎";
      tierName = "Very Strong";
    } else {
      tierEmoji = "🔵";
      tierName = "Strong";
    }
    
    const topReasons = liq.reasons.slice(0, 3).map(x => `   • ${x}`).join("\n");
    liquiditySection = `\n💧 <b>Liquidity: ${liq.score}/100</b> ${tierEmoji} ${tierName}\n${topReasons}\n`;
  }

  return `🚨 <b>${r.symbol} — ${r.signal} ${r.score}%</b> ${signalEmoji}${whaleHeader}

💰 $${r.price} ${arrow} ${Math.abs(r.pct)}%
${r.setup ? `🎯 ${r.setup.name}\n` : ""}⚡ Strike: <b>${r.signal} $${r.suggestedStrike}</b> (0DTE)
${liquiditySection}
💼 Walls: $${g.putWall} ⟷ $${g.callWall}
🎯 Gamma: ${gammaEmoji} ${g.gammaRegime}

━━━━━━━━━━━━━━━━━
🎯 Target +35% | 🛑 Stop -30%
⏱ 5-30 min | 💼 Size ${r.posSize}`;
}

function formatWeakening(r, prev) {
  return `⚠️ <b>${r.symbol} — ضعفت الإشارة</b>

📉 ${prev.signal} ${prev.score}% → ${r.signal} ${r.score}%
💰 $${r.price}

<i>فكر في الخروج إذا أنت في صفقة</i>`;
}

function formatReversal(r, prev) {
  const signalEmoji = r.signal === "CALL" ? "🟢" : "🔴";
  return `🔄 <b>${r.symbol} — انعكاس الاتجاه!</b> ${signalEmoji}

❌ ${prev.signal} ${prev.score}% → ✅ <b>${r.signal} ${r.score}%</b>
💰 $${r.price}
${r.setup ? `🎯 ${r.setup.name}\n` : ""}⚡ Strike: <b>${r.signal} $${r.suggestedStrike}</b>

⚠️ اخرج من الصفقة السابقة فوراً!`;
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 13 * 60 + 30 && utcMin <= 20 * 60;
}

function shouldAlert(current, previous) {
  const isStrong = current.score >= MIN_SCORE && (current.strengthAr === "قوية" || current.strengthAr === "قوية جداً");

  if (!previous) {
    return isStrong ? { send: true, type: "new" } : { send: false };
  }

  const prevWasStrong = previous.score >= MIN_SCORE && (previous.strengthAr === "قوية" || previous.strengthAr === "قوية جداً");

  if (prevWasStrong && current.signal !== previous.signal && current.signal !== "NEUTRAL" && isStrong) {
    return { send: true, type: "reversal" };
  }

  if (prevWasStrong && (current.strengthAr === "ضعيفة" || current.strengthAr === "محايد" || current.signal === "NEUTRAL")) {
    return { send: true, type: "weakening" };
  }

  if (!prevWasStrong && isStrong) {
    return { send: true, type: "new" };
  }

  return { send: false };
}

async function main() {
  console.log(`\n=== Scan started ${new Date().toISOString()} ===`);
  console.log(`MIN_SCORE = ${MIN_SCORE}, SEND_SUMMARY = ${SEND_SUMMARY}`);

  if (!isMarketOpen()) {
    console.log("Market closed, skipping");
    return;
  }

  const state = loadState();
  const newState = {};
  const results = [];

  for (const symbol of TICKERS) {
    try {
      const r = await analyzeTicker(symbol);
      results.push(r);
      const g = r.gamma;
      console.log(`OK ${symbol}: $${r.price} | ${r.signal} ${r.score}% | Liq:${r.liquidity.score}(${r.liquidity.tier}) | CW:$${g.callWall} PW:$${g.putWall} | ${r.setup?.name || "-"}`);

      newState[symbol] = {
        signal: r.signal,
        score: r.score,
        strengthAr: r.strengthAr,
        timestamp: Date.now(),
      };
    } catch (e) {
      console.error(`FAIL ${symbol}: ${e.message}`);
      results.push({ symbol, error: e.message });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  let sentCount = 0;
  for (const r of results) {
    if (r.error) continue;

    const previous = state[r.symbol];
    const decision = shouldAlert(r, previous);

    if (decision.send) {
      let msg;
      if (decision.type === "new") msg = formatNewAlert(r);
      else if (decision.type === "reversal") msg = formatReversal(r, previous);
      else if (decision.type === "weakening") msg = formatWeakening(r, previous);

      await sendTelegram(msg);
      console.log(`Sent (${decision.type}): ${r.symbol}`);
      sentCount++;
    } else {
      console.log(`Silent: ${r.symbol} (no change)`);
    }
  }

  console.log(`Sent: ${sentCount} alerts`);
  saveState(newState);
  console.log(`=== Done ===\n`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  sendTelegram(`Bot error: ${e.message}`).catch(() => {});
  process.exit(1);
});
