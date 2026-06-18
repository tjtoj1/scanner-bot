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

const TICKERS = ["SPY", "QQQ", "NVDA", "TSLA", "META", "AAPL", "MSTR", "AMZN"];

const META = {
  SPY:  { strikeStep: 1,   posSize: "100%",     risk: "normal",   ivCategory: "low",     wallPct: 0.005 },
  QQQ:  { strikeStep: 1,   posSize: "100%",     risk: "normal",   ivCategory: "low",     wallPct: 0.006 },
  NVDA: { strikeStep: 1,   posSize: "50% only", risk: "elevated", ivCategory: "high",    wallPct: 0.015 },
  TSLA: { strikeStep: 1,   posSize: "50% only", risk: "elevated", ivCategory: "high",    wallPct: 0.018 },
  META: { strikeStep: 2.5, posSize: "100%",     risk: "normal",   ivCategory: "medium",  wallPct: 0.010 },
  AAPL: { strikeStep: 1,   posSize: "100%",     risk: "normal",   ivCategory: "low",     wallPct: 0.007 },
  MSTR: { strikeStep: 5,   posSize: "25% only", risk: "extreme",  ivCategory: "extreme", wallPct: 0.030 },
  AMZN: { strikeStep: 1,   posSize: "100%",     risk: "normal",   ivCategory: "low",     wallPct: 0.008 },
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

function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = bars.slice(1).map((c, i) =>
    Math.max(c.h - c.l, Math.abs(c.h - bars[i].c), Math.abs(c.l - bars[i].c))
  );
  return parseFloat((trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(3));
}

// V16.11: ADX - Average Directional Index (trend strength)
function adx(bars, period = 14) {
  if (bars.length < period * 2 + 1) return null;
  let plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    ));
  }
  const sum = arr => arr.slice(-period).reduce((a, b) => a + b, 0);
  const trSum = sum(trs);
  if (trSum === 0) return null;
  const plusDI = (sum(plusDM) / trSum) * 100;
  const minusDI = (sum(minusDM) / trSum) * 100;
  const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
  return parseFloat(dx.toFixed(1));
}

// V16.11: Get historical ATR average for "market activity" comparison
function atrAverage(bars, period = 14, lookback = 5) {
  if (bars.length < period + lookback + 1) return null;
  const atrs = [];
  for (let i = 0; i < lookback; i++) {
    const slice = bars.slice(0, bars.length - i);
    const atrVal = atr(slice, period);
    if (atrVal) atrs.push(atrVal);
  }
  if (!atrs.length) return null;
  return parseFloat((atrs.reduce((a, b) => a + b, 0) / atrs.length).toFixed(3));
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
  // V16.22: Momentum (fair) REMOVED - data shows 0-25% win rate, biggest loser
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
  let absolutePoints = 0; // V16.16: Track absolute strength

  if (bull.score > bear.score && bull.score >= 25) {
    signal = "CALL";
    score = bull.score + (setup?.direction === "CALL" ? setupBonus : 0);
    absolutePoints = bull.score;
    reasons = bull.reasons;
    if (setup?.direction === "CALL") reasons.push(`Setup: ${setup.name}`);
  } else if (bear.score > bull.score && bear.score >= 25) {
    signal = "PUT";
    score = bear.score + (setup?.direction === "PUT" ? setupBonus : 0);
    absolutePoints = bear.score;
    reasons = bear.reasons;
    if (setup?.direction === "PUT") reasons.push(`Setup: ${setup.name}`);
  }

  score = Math.min(score, 95);

  // V16.16: ABSOLUTE SCORE FILTER - require minimum raw points
  // Prevents "high relative %" when actual evidence is weak
  if (signal !== "NEUTRAL" && absolutePoints < 70) {
    console.log(`  ${symbol}: ${signal} BLOCKED - absolute points too low (${absolutePoints} < 70)`);
    signal = "NEUTRAL";
    score = 0;
    reasons = [`Absolute too low: ${absolutePoints}/70`];
  }

  // V16.16: SETUP QUALITY MULTIPLIER - reward strong setups
  if (signal !== "NEUTRAL" && setup) {
    const qualityMultiplier = setup.quality === "excellent" ? 1.10
                            : setup.quality === "good" ? 1.00
                            : 0.90; // fair
    const originalScore = score;
    score = Math.min(95, Math.round(score * qualityMultiplier));
    if (score !== originalScore) {
      reasons.push(`Setup quality ${setup.quality}: ${originalScore}→${score}`);
    }
  }

  // V16.18: SETUP-SIGNAL MISMATCH - block trades where setup direction contradicts signal
  // Example: Overbought (PUT direction) but signal CALL → contradiction → block
  if (signal !== "NEUTRAL" && setup && setup.direction && setup.direction !== signal) {
    const originalSignal = signal;
    console.log(`  ${symbol}: ${signal} BLOCKED - setup "${setup.name}" direction is ${setup.direction}, contradicts signal`);
    signal = "NEUTRAL";
    score = 0;
    reasons = [`Setup mismatch: ${setup.name} → ${setup.direction} vs ${originalSignal}`];
  }

  // V16.22: MULTI-TIMEFRAME CONFIRMATION - both 5m AND 15m must agree
  // Prevents entering against the bigger trend
  if (signal !== "NEUTRAL") {
    const tf5Bull = macd5m?.bias === "bullish";
    const tf5Bear = macd5m?.bias === "bearish";
    const tf15Bull = macd15m?.bias === "bullish";
    const tf15Bear = macd15m?.bias === "bearish";
    
    if (signal === "CALL" && !(tf5Bull && tf15Bull)) {
      console.log(`  ${symbol}: CALL BLOCKED - timeframes don't align (5m=${macd5m?.bias}, 15m=${macd15m?.bias})`);
      signal = "NEUTRAL";
      score = 0;
      reasons = [`Multi-TF: need 5m AND 15m bullish (got 5m=${macd5m?.bias}, 15m=${macd15m?.bias})`];
    }
    if (signal === "PUT" && !(tf5Bear && tf15Bear)) {
      console.log(`  ${symbol}: PUT BLOCKED - timeframes don't align (5m=${macd5m?.bias}, 15m=${macd15m?.bias})`);
      signal = "NEUTRAL";
      score = 0;
      reasons = [`Multi-TF: need 5m AND 15m bearish (got 5m=${macd5m?.bias}, 15m=${macd15m?.bias})`];
    }
  }

  // V16.22: VOLUME SPIKE REQUIREMENT - smart money confirmation
  // Block entries without volume confirmation (1.5x+ avg)
  if (signal !== "NEUTRAL" && volRatio < 1.5) {
    console.log(`  ${symbol}: ${signal} BLOCKED - no volume spike (${volRatio}x < 1.5x)`);
    signal = "NEUTRAL";
    score = 0;
    reasons = [`Volume too low: ${volRatio}x (need 1.5x+)`];
  }


  // V16.10: TREND FILTER - Block signals against strong trend
  // Check 4 indicators on 5m: price vs SMA20, SMA50, VWAP, and SMA20 vs SMA50
  const above20 = price > sma20;
  const above50 = price > sma50;
  const aboveVwap = price > vwap5m;
  const sma20AboveSma50 = sma20 > sma50;
  const bullishCount = [above20, above50, aboveVwap, sma20AboveSma50].filter(Boolean).length;
  const trend = bullishCount === 4 ? "strongly_bullish"
              : bullishCount === 0 ? "strongly_bearish"
              : "mixed";

  if ((signal === "PUT" && trend === "strongly_bullish") ||
      (signal === "CALL" && trend === "strongly_bearish")) {
    console.log(`  ${symbol}: ${signal} BLOCKED by trend filter (trend: ${trend})`);
    signal = "NEUTRAL";
    score = 0;
    reasons = [`Trend filter: ${trend}`];
  }

  // V16.11: ADX FILTER - Detect Sideways markets
  const adxValue = adx(bars5m);
  if (adxValue !== null && signal !== "NEUTRAL") {
    if (adxValue < 20) {
      console.log(`  ${symbol}: ADX ${adxValue} < 20 → Sideways market, blocking signal`);
      signal = "NEUTRAL";
      score = 0;
      reasons = [`ADX too low: ${adxValue} (sideways)`];
    } else if (adxValue < 25) {
      score = Math.max(0, score - 15);
      reasons.push(`ADX weak ${adxValue} (-15)`);
    } else if (adxValue >= 30) {
      score = Math.min(95, score + 5);
      reasons.push(`Strong ADX ${adxValue} (+5)`);
    }
  }

  // V16.11: ATR FILTER - Detect dead/chaotic markets
  const atrAvg = atrAverage(bars5m);
  if (atrAvg && atr5m && signal !== "NEUTRAL") {
    const atrRatio = atr5m / atrAvg;
    if (atrRatio < 0.5) {
      console.log(`  ${symbol}: ATR ${atr5m} too low (${(atrRatio * 100).toFixed(0)}% of avg) → dead market`);
      score = Math.max(0, score - 20);
      reasons.push(`ATR very low (${(atrRatio * 100).toFixed(0)}%)`);
    } else if (atrRatio > 2.0) {
      // V16.12: Chaos = opportunity! Bonus instead of penalty
      console.log(`  ${symbol}: ATR ${atr5m} high volatility (${(atrRatio * 100).toFixed(0)}% of avg) → opportunity`);
      score = Math.min(95, score + 10);
      reasons.push(`High volatility ${(atrRatio * 100).toFixed(0)}% (+10)`);
    } else if (atrRatio >= 0.8 && atrRatio <= 1.5) {
      score = Math.min(95, score + 5);
      reasons.push(`ATR healthy (+5)`);
    }
  }

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
    gamma, setup, signal, strengthAr, score, reasons,
    suggestedStrike: atmStrike, riskNote: meta.risk, posSize: meta.posSize,
    bullScore: bull.score, bearScore: bear.score,
    atr5m, // V16.15: needed for hybrid stop calculation
  };
}

// ============================================================
// ALPACA TRADING API (Paper Trading)
// ============================================================
const TRADING_BASE = "https://paper-api.alpaca.markets/v2";
const OPTIONS_BASE = "https://data.alpaca.markets/v1beta1/options";

async function alpacaCall(url, method = "GET", body = null) {
  const opts = {
    method,
    headers: { ...ALPACA_HEADERS, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Alpaca ${method} ${url.split("/").slice(-2).join("/")}: ${r.status} ${text}`);
  }
  return r.json();
}

async function getAccount() {
  return alpacaCall(`${TRADING_BASE}/account`);
}

async function getOptionContracts(symbol, expirationDate, type, strikeMin, strikeMax) {
  const params = new URLSearchParams({
    underlying_symbols: symbol,
    expiration_date: expirationDate,
    type: type.toLowerCase(),
    strike_price_gte: strikeMin.toFixed(2),
    strike_price_lte: strikeMax.toFixed(2),
    status: "active",
    limit: "50",
  });
  const data = await alpacaCall(`${TRADING_BASE}/options/contracts?${params}`);
  return data.option_contracts || [];
}

async function getOptionQuote(optionSymbol) {
  try {
    // Use the correct endpoint: /v1beta1/options/quotes/latest?symbols=...
    const url = `https://data.alpaca.markets/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(optionSymbol)}`;
    const data = await alpacaCall(url);
    const quote = data.quotes?.[optionSymbol];
    if (!quote) {
      console.log(`  No quote data for ${optionSymbol}`);
      return null;
    }
    const bid = quote.bp || 0;
    const ask = quote.ap || 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask || bid);
    return { bid, ask, mid };
  } catch (e) {
    console.log(`  Quote fetch error for ${optionSymbol}: ${e.message}`);
    return null;
  }
}

async function placeOptionOrder(optionSymbol, qty, side) {
  return alpacaCall(`${TRADING_BASE}/orders`, "POST", {
    symbol: optionSymbol,
    qty: String(qty),
    side, // "buy" or "sell"
    type: "market",
    time_in_force: "day",
  });
}

async function getPosition(optionSymbol) {
  try {
    return await alpacaCall(`${TRADING_BASE}/positions/${optionSymbol}`);
  } catch {
    return null;
  }
}

async function closePosition(optionSymbol) {
  return alpacaCall(`${TRADING_BASE}/positions/${optionSymbol}`, "DELETE");
}

// V16.4: Stop Loss Order Management
async function placeStopLossOrder(optionSymbol, qty, stopPrice) {
  return alpacaCall(`${TRADING_BASE}/orders`, "POST", {
    symbol: optionSymbol,
    qty: String(qty),
    side: "sell",
    type: "stop",
    stop_price: stopPrice.toFixed(2),
    time_in_force: "day",
  });
}

async function cancelOrder(orderId) {
  try {
    return await alpacaCall(`${TRADING_BASE}/orders/${orderId}`, "DELETE");
  } catch (e) {
    console.error(`  Cancel order ${orderId} failed: ${e.message}`);
    return null;
  }
}

async function getOrder(orderId) {
  try {
    return await alpacaCall(`${TRADING_BASE}/orders/${orderId}`);
  } catch {
    return null;
  }
}

async function updateStopLoss(pos, newStopPrice) {
  // Cancel old, place new
  if (pos.stopOrderId) {
    await cancelOrder(pos.stopOrderId);
    await new Promise(r => setTimeout(r, 500)); // Let Alpaca process
  }
  try {
    const order = await placeStopLossOrder(pos.optionSymbol, pos.qty, newStopPrice);
    console.log(`  ${pos.symbol}: Stop Loss updated to $${newStopPrice.toFixed(2)} (order ${order.id})`);
    return order.id;
  } catch (e) {
    console.error(`  ${pos.symbol}: Failed to place new Stop Loss: ${e.message}`);
    return null;
  }
}

// ============================================================
// Pick best option contract for a signal
// ============================================================
async function pickOptionContract(symbol, signal, atmStrike, strikeStep) {
  const today = new Date().toISOString().split("T")[0];
  const targetStrike = signal === "CALL" ? atmStrike + strikeStep : atmStrike - strikeStep;
  const min = targetStrike - strikeStep * 0.5;
  const max = targetStrike + strikeStep * 0.5;

  const contracts = await getOptionContracts(symbol, today, signal, min, max);
  if (contracts.length === 0) {
    // No 0DTE found, try wider range
    const wideMin = targetStrike - strikeStep * 2;
    const wideMax = targetStrike + strikeStep * 2;
    const wider = await getOptionContracts(symbol, today, signal, wideMin, wideMax);
    if (wider.length === 0) return null;
    // Pick closest to target
    wider.sort((a, b) => Math.abs(a.strike_price - targetStrike) - Math.abs(b.strike_price - targetStrike));
    return wider[0];
  }
  // Pick exact match or closest
  contracts.sort((a, b) => Math.abs(a.strike_price - targetStrike) - Math.abs(b.strike_price - targetStrike));
  return contracts[0];
}

// ============================================================
// Calculate quantity based on portfolio %
// ============================================================
function calculateQty(portfolioValue, premiumPerContract, pctOfPortfolio = 0.10) {
  const targetDollar = portfolioValue * pctOfPortfolio;
  const contractCost = premiumPerContract * 100; // each contract = 100 shares
  const qty = Math.floor(targetDollar / contractCost);
  return Math.max(qty, 1); // at least 1 contract
}

// ============================================================
// Time helpers (CDT = UTC-5)
// ============================================================
function isPastForceExitTime(now) {
  // 2:39 PM CDT = 19:39 UTC
  const d = now ? new Date(now) : new Date();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin >= 19 * 60 + 39;
}

function isBeforeNoEntryTime(now) {
  // No new entries after 2:30 PM CDT = 19:30 UTC
  const d = now ? new Date(now) : new Date();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin < 19 * 60 + 30;
}

// V16.21: FOMC / High-Impact Event Days - stop trading early
function isFomcDay(now) {
  const FOMC_DATES_2026 = ["2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];
  const d = now ? new Date(now) : new Date();
  const dateStr = d.toISOString().split("T")[0];
  return FOMC_DATES_2026.includes(dateStr);
}

function isBeforeFomcCutoff(now) {
  // On FOMC days, no new entries after 12:30 PM CDT = 17:30 UTC
  const d = now ? new Date(now) : new Date();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin < 17 * 60 + 30;
}

function isReportTime(now) {
  // 3:00 PM CDT = 20:00 UTC, fire once
  const d = now ? new Date(now) : new Date();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin >= 20 * 60 && utcMin < 20 * 60 + 10;
}

// ============================================================
// V16: PHASED TRAILING STOP SYSTEM
// ============================================================
// V16.15: Hybrid ATR + Score Stop Loss
function calculateStopConfig(price, atr, score) {
  // Default fallback (when no data)
  if (!atr || !price || atr <= 0 || price <= 0) {
    return { stopPct: 30, bePct: 10, trailPct: 30, peakBufferPct: 5 };
  }

  // Calculate volatility as % of stock price
  const volatility = (atr / price) * 100;

  // Base stop scales with volatility
  // Low vol stocks: 20-25%, High vol stocks: 35-45%
  let basePct = 20 + (volatility * 12);

  // Score adjustment: stronger signal = tighter stop
  let scoreAdj = 0;
  if (score >= 95) scoreAdj = -3;       // Very strong: tighter
  else if (score >= 90) scoreAdj = -1;
  else if (score < 85) scoreAdj = +3;   // Weaker: wider

  // Final stop %, clamped between 20% and 45%
  const stopPct = Math.max(20, Math.min(45, Math.round(basePct + scoreAdj)));

  // BE trigger ~ stop/3, Trailing trigger ~ stop
  const bePct = Math.max(8, Math.round(stopPct / 3));
  const trailPct = stopPct;
  const peakBufferPct = 5; // peak buffer stays at 5%

  return { stopPct, bePct, trailPct, peakBufferPct };
}

function calculatePhase(entryPremium, peakPremium, config) {
  const cfg = config || { stopPct: 30, bePct: 10, trailPct: 30, peakBufferPct: 5 };
  const peakPct = ((peakPremium - entryPremium) / entryPremium) * 100;
  if (peakPct >= cfg.trailPct) return "trailing";
  if (peakPct >= cfg.bePct) return "breakeven";
  return "initial";
}

function calculateStop(entryPremium, peakPremium, config) {
  const cfg = config || { stopPct: 30, bePct: 10, trailPct: 30, peakBufferPct: 5 };
  const phase = calculatePhase(entryPremium, peakPremium, cfg);
  switch (phase) {
    case "trailing":  return Math.max(entryPremium * (1 + cfg.trailPct / 100), peakPremium * (1 - cfg.peakBufferPct / 100));
    case "breakeven": return entryPremium;
    default:          return entryPremium * (1 - cfg.stopPct / 100);
  }
}

function getPhaseLabel(phase, config) {
  const cfg = config || { stopPct: 30, bePct: 10, trailPct: 30, peakBufferPct: 5 };
  switch (phase) {
    case "trailing":  return `Trailing (+${cfg.trailPct}% Min / Peak -${cfg.peakBufferPct}%)`;
    case "breakeven": return "Break-Even";
    default:          return `Initial (-${cfg.stopPct}%)`;
  }
}

function getPhaseEmoji(phase) {
  switch (phase) {
    case "trailing":  return "🚀";
    case "breakeven": return "🛡️";
    default:          return "🛑";
  }
}

async function sendTelegram(text, replyToMessageId = null) {
  const body = { chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyToMessageId) {
    body.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`Telegram error: ${await r.text()}`);
    return null;
  }
  const data = await r.json();
  return data.result?.message_id || null;
}

function formatBuyAlert(r, pos) {
  const target = pos.entryPremium * 1.35;
  const stop = pos.entryPremium * 0.70;
  return `✅ <b>BUY ${r.symbol} ${r.signal} $${pos.strike} 0DTE</b>
💰 Entry: $${pos.entryPremium.toFixed(2)} × ${pos.qty}
🎯 Target: $${target.toFixed(2)} (+35%)
🛑 Stop: $${stop.toFixed(2)} (-30%)
📊 ${r.score}% ${r.setup?.name || ""}`;
}

function formatMonitor(pos, currentPremium, peakPremium, currentStop, minutesElapsed) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium * 100);
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1);
  const phase = calculatePhase(pos.entryPremium, peakPremium, pos.stopConfig);
  const emoji = getPhaseEmoji(phase);
  const phaseLabel = getPhaseLabel(phase, pos.stopConfig);
  return `📊 <b>${pos.symbol || ""} - مراقبة</b>
💰 Premium: $${currentPremium.toFixed(2)} (${pctStr}%)
🎯 Stop: $${currentStop.toFixed(2)} ${emoji} ${phaseLabel}
📈 Peak: $${peakPremium.toFixed(2)}
⏱ ${minutesElapsed} دقيقة`;
}

function formatBreakEven(pos, currentPremium) {
  return `🛡️ <b>BREAK-EVEN: ${pos.symbol || ""}</b>
💰 $${currentPremium.toFixed(2)} (+${(((currentPremium - pos.entryPremium) / pos.entryPremium) * 100).toFixed(1)}%)
🔒 Stop: $${pos.entryPremium.toFixed(2)} (سعر الدخول)`;
}

function formatBuffer(pos, currentPremium, peakPremium, stop) {
  return `📈 <b>BUFFER: ${pos.symbol || ""}</b>
💰 $${currentPremium.toFixed(2)} (+${(((currentPremium - pos.entryPremium) / pos.entryPremium) * 100).toFixed(1)}%)
🎯 Stop: $${stop.toFixed(2)} (Peak - 7%)`;
}

function formatTrailing(pos, currentPremium, peakPremium, stop) {
  const stopPct = ((stop - pos.entryPremium) / pos.entryPremium * 100).toFixed(1);
  return `🚀 <b>TRAILING ACTIVATED: ${pos.symbol || ""}</b>
💰 $${currentPremium.toFixed(2)} (+${(((currentPremium - pos.entryPremium) / pos.entryPremium) * 100).toFixed(1)}%)
🔒 Stop: $${stop.toFixed(2)} (+${stopPct}% مضمون)
📈 سيرتفع مع Peak (-5%)`;
}

function formatV16Exit(pos, currentPremium, reason, minutesElapsed) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium) * 100;
  const pnl = pos.qty * (currentPremium - pos.entryPremium) * 100;
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1);
  const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0);
  const emoji = pct >= 0 ? "✅" : "🛑";
  const reasonText = {
    profit: "خروج بربح",
    loss: "خروج بخسارة",
    trailing: "Trailing Stop",
    breakeven: "Break-Even Stop",
    force: "إغلاق إجباري (2:39 PM)",
    reversal: "انعكاس",
  }[reason] || reason;
  return `${emoji} <b>EXIT: ${pos.symbol || ""} (${reasonText})</b>
💰 $${pos.entryPremium.toFixed(2)} → $${currentPremium.toFixed(2)}
${pct >= 0 ? "📈" : "📉"} ${pctStr}% (${pnlStr}$)
⏱ ${minutesElapsed} دقيقة`;
}

function formatStatusUpdate(label, pos, currentPremium) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium * 100);
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1);
  return `📊 <b>${label}: مستمر</b>
💰 Premium: $${currentPremium.toFixed(2)} (${pctStr}%)`;
}

function formatExitProfit(pos, currentPremium, reason, minutesElapsed) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium * 100);
  const pnl = pos.qty * (currentPremium - pos.entryPremium) * 100;
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1);
  const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0);
  return `✅ <b>EXIT: ${reason}</b>
💰 Premium: $${pos.entryPremium.toFixed(2)} → $${currentPremium.toFixed(2)}
📈 ${pctStr}% (${pnlStr}$)
⏱ المدة: ${minutesElapsed} دقيقة`;
}

function formatExitLoss(pos, currentPremium, reason, minutesElapsed) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium * 100);
  const pnl = pos.qty * (currentPremium - pos.entryPremium) * 100;
  const pctStr = pct.toFixed(1);
  const pnlStr = pnl.toFixed(0);
  return `🛑 <b>EXIT: ${reason}</b>
💰 Premium: $${pos.entryPremium.toFixed(2)} → $${currentPremium.toFixed(2)}
📉 ${pctStr}% (${pnlStr}$)
⏱ المدة: ${minutesElapsed} دقيقة`;
}

function formatExitTime(pos, currentPremium, minutesElapsed) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium * 100);
  const pnl = pos.qty * (currentPremium - pos.entryPremium) * 100;
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1);
  const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0);
  const emoji = pct >= 0 ? "🏁" : "🏁";
  return `${emoji} <b>EXIT: انتهت المدة (30 دقيقة)</b>
💰 Premium: $${pos.entryPremium.toFixed(2)} → $${currentPremium.toFixed(2)}
${pct >= 0 ? "📈" : "📉"} ${pctStr}% (${pnlStr}$)`;
}

function formatExitReversal(pos, currentPremium, newSignal) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium * 100);
  const pnl = pos.qty * (currentPremium - pos.entryPremium) * 100;
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1);
  const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0);
  return `🔄 <b>EXIT: انعكاس → ${newSignal}</b>
💰 Premium: $${pos.entryPremium.toFixed(2)} → $${currentPremium.toFixed(2)}
${pct >= 0 ? "📈" : "📉"} ${pctStr}% (${pnlStr}$)`;
}

function formatExitForce(pos, currentPremium) {
  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium * 100);
  const pnl = pos.qty * (currentPremium - pos.entryPremium) * 100;
  const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(1);
  const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(0);
  return `⏰ <b>EXIT: إغلاق إجباري (2:45 PM)</b>
💰 Premium: $${pos.entryPremium.toFixed(2)} → $${currentPremium.toFixed(2)}
${pct >= 0 ? "📈" : "📉"} ${pctStr}% (${pnlStr}$)`;
}

async function formatDailyReport(state) {
  const trades = state._dailyTrades || [];

  // Get today in CDT timezone
  const now = new Date();
  const cdtDate = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const dayName = cdtDate.toLocaleDateString("en-US", { weekday: "long" });
  const monthName = cdtDate.toLocaleDateString("en-US", { month: "long" });
  const day = cdtDate.getDate();
  const year = cdtDate.getFullYear();
  const dateHeader = `${dayName} ${monthName} ${day}, ${year}`;

  // V16.5: Get real values from Alpaca
  let portfolioValue = 0;
  let dailyChange = 0;
  let dailyChangePct = 0;
  try {
    const account = await getAccount();
    portfolioValue = parseFloat(account.portfolio_value);
    const lastEquity = parseFloat(account.last_equity || portfolioValue);
    dailyChange = portfolioValue - lastEquity;
    dailyChangePct = lastEquity > 0 ? (dailyChange / lastEquity * 100) : 0;
  } catch (e) {
    console.error("Failed to fetch account for report:", e.message);
  }

  if (trades.length === 0) {
    return `📊 <b>Daily Report - ${dateHeader}</b>\n\nلا توجد صفقات اليوم\n\n📈 الرصيد: $${portfolioValue.toFixed(0)}`;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = (wins.length / trades.length * 100).toFixed(1);
  const best = trades.reduce((b, t) => t.pnl > b.pnl ? t : b, trades[0]);
  const worst = trades.reduce((w, t) => t.pnl < w.pnl ? t : w, trades[0]);
  // V16.9: Total profit and loss separately
  const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);

  return `📊 <b>Daily Report - ${dateHeader}</b>

💼 الصفقات: ${trades.length}
✅ ربحانة: ${wins.length} (${winRate}%)
❌ خسرانة: ${losses.length}

💰 ربح: +$${totalProfit.toFixed(0)}
💸 خسارة: $${totalLoss.toFixed(0)}
📊 صافي: ${dailyChange >= 0 ? "+" : ""}$${dailyChange.toFixed(0)} (${dailyChangePct >= 0 ? "+" : ""}${dailyChangePct.toFixed(1)}%)

🥇 أفضل: ${best.symbol} ${best.signal} ${(best.pnlPct >= 0 ? "+" : "")}${best.pnlPct.toFixed(1)}%
🥉 أسوأ: ${worst.symbol} ${worst.signal} ${worst.pnlPct.toFixed(1)}%

📈 الرصيد: $${portfolioValue.toFixed(0)}`;
}

// V16.14: STRATEGY ANALYZER - Comprehensive performance analysis
async function analyzeStrategy(state) {
  const trades = state._dailyTrades || [];
  if (trades.length === 0) {
    return "📊 <b>تحليل الاستراتيجية</b>\n\nلا توجد صفقات اليوم للتحليل.";
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const breakevens = trades.filter(t => t.pnl === 0);
  const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = totalLoss > 0 ? (totalProfit / totalLoss).toFixed(2) : "N/A";
  const avgWin = wins.length > 0 ? totalProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
  const winRate = (wins.length / trades.length * 100).toFixed(1);

  // Per-ticker analysis
  const byTicker = {};
  trades.forEach(t => {
    if (!byTicker[t.symbol]) byTicker[t.symbol] = { wins: 0, losses: 0, total: 0, pnl: 0 };
    byTicker[t.symbol].total++;
    byTicker[t.symbol].pnl += t.pnl;
    if (t.pnl > 0) byTicker[t.symbol].wins++;
    else if (t.pnl < 0) byTicker[t.symbol].losses++;
  });

  // Per-reason analysis
  const byReason = {};
  trades.forEach(t => {
    if (!byReason[t.reason]) byReason[t.reason] = { count: 0, pnl: 0 };
    byReason[t.reason].count++;
    byReason[t.reason].pnl += t.pnl;
  });

  // Per-signal analysis (CALL vs PUT)
  const calls = trades.filter(t => t.signal === "CALL");
  const puts = trades.filter(t => t.signal === "PUT");
  const callWins = calls.filter(t => t.pnl > 0).length;
  const putWins = puts.filter(t => t.pnl > 0).length;
  const callWR = calls.length > 0 ? (callWins / calls.length * 100).toFixed(0) : 0;
  const putWR = puts.length > 0 ? (putWins / puts.length * 100).toFixed(0) : 0;

  // Duration analysis
  const quickLosses = losses.filter(t => t.minutes <= 2).length;
  const quickPercent = losses.length > 0 ? (quickLosses / losses.length * 100).toFixed(0) : 0;

  // Time analysis (if entryTime available)
  const byHour = {};
  trades.forEach(t => {
    if (t.entryTime) {
      const hour = new Date(t.entryTime).getUTCHours() - 5; // CDT
      const hourKey = `${hour}:00`;
      if (!byHour[hourKey]) byHour[hourKey] = { wins: 0, losses: 0, pnl: 0 };
      if (t.pnl > 0) byHour[hourKey].wins++;
      else if (t.pnl < 0) byHour[hourKey].losses++;
      byHour[hourKey].pnl += t.pnl;
    }
  });

  // Build issues list
  const issues = [];

  // Check 1: Win rate
  if (parseFloat(winRate) < 30) {
    issues.push({ severity: "CRITICAL", text: `Win Rate ضعيف جداً (${winRate}%) - الاستراتيجية تحتاج مراجعة شاملة` });
  } else if (parseFloat(winRate) < 40) {
    issues.push({ severity: "MAJOR", text: `Win Rate تحت 40% (${winRate}%) - يحتاج تحسين` });
  }

  // Check 2: Profit factor
  if (profitFactor !== "N/A" && parseFloat(profitFactor) < 1) {
    issues.push({ severity: "CRITICAL", text: `Profit Factor < 1 (${profitFactor}) - نخسر أكثر مما نربح` });
  } else if (profitFactor !== "N/A" && parseFloat(profitFactor) < 1.5) {
    issues.push({ severity: "MAJOR", text: `Profit Factor منخفض (${profitFactor}) - الأرباح صغيرة مقارنة بالخسائر` });
  }

  // Check 3: Avg loss > avg win
  if (avgLoss > avgWin * 1.5 && wins.length > 0) {
    issues.push({ severity: "MAJOR", text: `متوسط الخسارة ($${avgLoss.toFixed(0)}) أكبر من متوسط الربح ($${avgWin.toFixed(0)}) - Stop ضيق أو Trailing مبكر` });
  }

  // Check 4: Per-ticker losers
  Object.entries(byTicker).forEach(([symbol, stats]) => {
    if (stats.total >= 3 && stats.wins === 0) {
      issues.push({ severity: "MAJOR", text: `${symbol}: ${stats.total} صفقات كلها خسرانة - تحقق من الإشارات` });
    } else if (stats.total >= 5 && stats.wins / stats.total < 0.2) {
      issues.push({ severity: "MINOR", text: `${symbol}: ${stats.wins}/${stats.total} رابحة فقط - أداء ضعيف` });
    }
  });

  // Check 5: Quick losses (Stop hit too fast)
  if (parseFloat(quickPercent) > 50 && losses.length >= 4) {
    issues.push({ severity: "MAJOR", text: `${quickPercent}% من الخسائر خلال دقيقتين - Stop ضيق جداً أو إشارات سيئة` });
  }

  // Check 6: CALL/PUT imbalance
  if (Math.abs(parseInt(callWR) - parseInt(putWR)) > 30 && calls.length >= 3 && puts.length >= 3) {
    if (parseInt(callWR) > parseInt(putWR)) {
      issues.push({ severity: "MINOR", text: `CALL Win Rate (${callWR}%) أعلى بكثير من PUT (${putWR}%) - السوق صاعد، PUT يفشل` });
    } else {
      issues.push({ severity: "MINOR", text: `PUT Win Rate (${putWR}%) أعلى بكثير من CALL (${callWR}%) - السوق هابط، CALL يفشل` });
    }
  }

  // Check 7: Stop Loss frequency
  const lossCount = byReason["loss"]?.count || 0;
  if (lossCount / trades.length > 0.5) {
    issues.push({ severity: "MAJOR", text: `${lossCount} صفقة خرجت بـ Stop Loss (${(lossCount/trades.length*100).toFixed(0)}%) - فلاتر الجودة ضعيفة` });
  }

  // Check 8: Trailing frequency  
  const trailCount = byReason["trailing"]?.count || 0;
  if (trades.length >= 10 && trailCount === 0) {
    issues.push({ severity: "MAJOR", text: `لا توجد صفقات وصلت Trailing - الاستراتيجية لا تمسك الحركات الكبيرة` });
  } else if (trailCount > 0 && wins.length > 0) {
    const trailWinPct = (trailCount / wins.length * 100).toFixed(0);
    // This is informational, not necessarily an issue
  }

  // Format output
  const sortedTickers = Object.entries(byTicker).sort((a, b) => b[1].pnl - a[1].pnl);
  const sortedHours = Object.entries(byHour).sort((a, b) => b[1].pnl - a[1].pnl);

  let report = `📊 <b>تقرير تحليل الاستراتيجية</b>\n`;
  report += `📅 ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}\n\n`;

  // Performance Summary
  report += `<b>📈 الأداء العام:</b>\n`;
  report += `• الصفقات: ${trades.length}\n`;
  report += `• Win Rate: ${winRate}% (${wins.length}/${trades.length})\n`;
  report += `• Profit Factor: ${profitFactor}\n`;
  report += `• متوسط الربح: +$${avgWin.toFixed(0)}\n`;
  report += `• متوسط الخسارة: -$${avgLoss.toFixed(0)}\n\n`;

  // Per-Ticker
  report += `<b>📊 أداء الأسهم:</b>\n`;
  sortedTickers.forEach(([symbol, stats]) => {
    const wr = stats.total > 0 ? (stats.wins / stats.total * 100).toFixed(0) : 0;
    const emoji = stats.pnl > 0 ? "✅" : stats.pnl < 0 ? "🔴" : "⚪";
    report += `${emoji} ${symbol}: ${stats.wins}/${stats.total} (${wr}%) | ${stats.pnl >= 0 ? "+" : ""}$${stats.pnl.toFixed(0)}\n`;
  });
  report += `\n`;

  // Exit Reasons
  report += `<b>🚪 أسباب الخروج:</b>\n`;
  Object.entries(byReason).forEach(([reason, stats]) => {
    const pct = (stats.count / trades.length * 100).toFixed(0);
    report += `• ${reason}: ${stats.count} (${pct}%) | ${stats.pnl >= 0 ? "+" : ""}$${stats.pnl.toFixed(0)}\n`;
  });
  report += `\n`;

  // CALL vs PUT
  report += `<b>🎯 CALL vs PUT:</b>\n`;
  report += `• CALL: ${callWins}/${calls.length} (${callWR}%)\n`;
  report += `• PUT: ${putWins}/${puts.length} (${putWR}%)\n\n`;

  // Time analysis (if available)
  if (sortedHours.length > 0) {
    report += `<b>⏰ التوقيت:</b>\n`;
    sortedHours.slice(0, 3).forEach(([hour, stats]) => {
      const total = stats.wins + stats.losses;
      const wr = total > 0 ? (stats.wins / total * 100).toFixed(0) : 0;
      report += `• ${hour} (CDT): ${stats.wins}W/${stats.losses}L (${wr}%) | ${stats.pnl >= 0 ? "+" : ""}$${stats.pnl.toFixed(0)}\n`;
    });
    report += `\n`;
  }

  // Issues
  if (issues.length > 0) {
    const critical = issues.filter(i => i.severity === "CRITICAL");
    const major = issues.filter(i => i.severity === "MAJOR");
    const minor = issues.filter(i => i.severity === "MINOR");

    report += `<b>🔍 المشاكل المكتشفة:</b>\n\n`;

    if (critical.length > 0) {
      report += `🔴 <b>CRITICAL (يصلح فوراً):</b>\n`;
      critical.forEach(i => report += `• ${i.text}\n`);
      report += `\n`;
    }
    if (major.length > 0) {
      report += `🟡 <b>MAJOR (الأسبوع القادم):</b>\n`;
      major.forEach(i => report += `• ${i.text}\n`);
      report += `\n`;
    }
    if (minor.length > 0) {
      report += `🟢 <b>MINOR (لاحقاً):</b>\n`;
      minor.forEach(i => report += `• ${i.text}\n`);
      report += `\n`;
    }
  } else {
    report += `<b>✅ لا توجد مشاكل واضحة</b>\n`;
    report += `الأداء ضمن المعدلات المقبولة.\n\n`;
  }

  // Sample size warning
  if (trades.length < 30) {
    report += `\n⚠️ <b>تحذير:</b> ${trades.length} صفقة قليلة للاستنتاج النهائي.\n`;
    report += `نحتاج 30+ صفقة للتأكيد قبل تطبيق أي تعديل.\n`;
  }

  report += `\n📋 الإصدار: v16.14`;

  return report;
}



function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 13 * 60 + 30 && utcMin <= 20 * 60;
}

function decideAction(current, previous, now) {
  const isStrong = current.score >= MIN_SCORE && (current.strengthAr === "قوية" || current.strengthAr === "قوية جداً");

  // Force exit at 2:39 PM if position active
  if (previous && previous.active && isPastForceExitTime(now)) {
    return { action: "force_exit" };
  }

  // No active position
  if (!previous || !previous.active) {
    if (previous && previous.cooldownUntil && now < previous.cooldownUntil) {
      // V16.6: Allow reversal during cooldown if signal is opposite + strong
      if (isStrong && previous.lastSignal && current.signal !== "NEUTRAL" && current.signal !== previous.lastSignal) {
        console.log(`  ${current.symbol}: Reversal allowed during cooldown (${previous.lastSignal} → ${current.signal})`);
        return { action: "new_entry" };
      }
      return { action: "cooldown" };
    }
    if (isFomcDay(now) && !isBeforeFomcCutoff(now)) {
      return { action: "fomc_cutoff" };
    }
    if (!isBeforeNoEntryTime(now)) {
      return { action: "no_entry_time" };
    }
    return isStrong ? { action: "new_entry" } : { action: "none" };
  }

  // V16.2: Block duplicate entry on same symbol + same direction
  if (isStrong && current.signal === previous.signal) {
    return { action: "duplicate" };
  }

  // Active position - check reversal only (stop logic is in processActivePosition)
  if (current.signal !== "NEUTRAL" && current.signal !== previous.signal && isStrong) {
    return { action: "exit_reversal", newSignal: current.signal };
  }

  return { action: "monitor" };
}

// ============================================================
// MAIN ORCHESTRATION (v15 - Auto Trading)
// ============================================================
async function processActivePosition(symbol, r, previous, now, decision, mode = "scan") {
  const pos = { ...previous, symbol };
  const minutesElapsed = decision.minutesElapsed || Math.floor((now - pos.entryTime) / 60000);

  // V16.1: Use Position API (reliable for open positions, no options data subscription needed)
  let currentPremium;
  let position;
  try {
    position = await getPosition(pos.optionSymbol);
  } catch (e) {
    console.error(`  ${symbol}: getPosition error: ${e.message}`);
    position = null;
  }

  if (position) {
    currentPremium = parseFloat(position.current_price);
    console.log(`  ${symbol}: Position found - Current: $${currentPremium}, P&L: ${(parseFloat(position.unrealized_plpc) * 100).toFixed(1)}%`);
  } else {
    // V16.4: Position gone - likely Stop Loss in Alpaca was executed!
    if (pos.stopOrderId) {
      console.log(`  ${symbol}: Position closed - checking if Stop Loss was executed`);
      const stopOrder = await getOrder(pos.stopOrderId);
      if (stopOrder && stopOrder.status === "filled") {
        const exitPrice = parseFloat(stopOrder.filled_avg_price || pos.currentStop);
        console.log(`  ${symbol}: Stop Loss filled @ $${exitPrice}`);
        // Determine reason based on phase
        const currentPhase = calculatePhase(pos.entryPremium, previous.peakPremium || previous.entryPremium, pos.stopConfig);
        const exitReason = currentPhase === "trailing" ? "trailing"
                         : currentPhase === "breakeven" ? "breakeven"
                         : "loss";
        return await executeV16Exit(symbol, pos, exitPrice, exitReason, minutesElapsed, true); // skipClose=true
      }
    }
    // Fallback to getOptionQuote
    const quote = await getOptionQuote(pos.optionSymbol);
    if (quote && quote.mid > 0) {
      currentPremium = quote.mid;
      console.log(`  ${symbol}: Using quote fallback - Premium: $${currentPremium}`);
    } else {
      // CRITICAL: Cannot fetch price - send emergency alert
      console.error(`  ${symbol}: CANNOT FETCH PRICE - Emergency alert sent`);
      await sendTelegram(
        `🚨 <b>تنبيه طوارئ: ${symbol}</b>\nالبوت لا يقدر يجيب السعر الحالي!\n\nالصفقة: ${pos.optionSymbol}\nالدخول: $${pos.entryPremium}\nالكمية: ${pos.qty}\n\n⚠️ يرجى التحقق يدوياً من Alpaca`,
        pos.entryMessageId
      );
      return previous;
    }
  }

  // Update peak
  const peakPremium = Math.max(previous.peakPremium || previous.entryPremium, currentPremium);

  // Calculate phase and stop (V16.15: use position's stopConfig)
  const previousPhase = calculatePhase(pos.entryPremium, previous.peakPremium || previous.entryPremium, pos.stopConfig);
  const currentPhase = calculatePhase(pos.entryPremium, peakPremium, pos.stopConfig);
  const currentStop = calculateStop(pos.entryPremium, peakPremium, pos.stopConfig);

  const pct = ((currentPremium - pos.entryPremium) / pos.entryPremium) * 100;
  console.log(`  ${symbol}: Premium $${currentPremium.toFixed(2)} (${pct.toFixed(1)}%), Peak $${peakPremium.toFixed(2)}, Stop $${currentStop.toFixed(2)}, Phase: ${currentPhase}, Min: ${minutesElapsed}`);

  // FORCE EXIT (2:39 PM)
  if (decision.action === "force_exit") {
    return await executeV16Exit(symbol, pos, currentPremium, "force", minutesElapsed);
  }

  // REVERSAL - only in initial phase
  if (decision.action === "exit_reversal" && currentPhase === "initial") {
    return await executeV16Exit(symbol, pos, currentPremium, "reversal", minutesElapsed);
  }

  // STOP HIT (based on phase)
  if (currentPremium <= currentStop) {
    const exitReason = currentPhase === "trailing" ? "trailing"
                     : currentPhase === "breakeven" ? "breakeven"
                     : "loss";
    return await executeV16Exit(symbol, pos, currentPremium, exitReason, minutesElapsed);
  }

  // PHASE CHANGE - announce + update Stop Loss in Alpaca
  if (currentPhase !== previousPhase) {
    let msg = null;
    if (currentPhase === "breakeven" && !previous.breakEvenAnnounced) {
      msg = formatBreakEven(pos, currentPremium);
    } else if (currentPhase === "trailing" && !previous.trailingAnnounced) {
      msg = formatTrailing(pos, currentPremium, peakPremium, currentStop);
    }
    if (msg) {
      await sendTelegram(msg, pos.entryMessageId);
      console.log(`  ${symbol}: Phase change to ${currentPhase}`);
    }
  }

  // V16.4: Update Stop Loss in Alpaca if stop value changed
  let newStopOrderId = pos.stopOrderId;
  const stopDiff = Math.abs(currentStop - (previous.currentStop || 0));
  if (stopDiff > 0.01 && pos.stopOrderId) {
    console.log(`  ${symbol}: Stop changed $${previous.currentStop?.toFixed(2)} → $${currentStop.toFixed(2)}, updating Alpaca...`);
    const newId = await updateStopLoss(pos, currentStop);
    if (newId) newStopOrderId = newId;
  } else if (currentPhase === "trailing" && peakPremium > (previous.peakPremium || 0)) {
    // In Trailing phase, update stop if Peak rose (even small changes)
    const trailingStop = peakPremium * 0.95;
    const lockedStop = pos.entryPremium * 1.30;
    if (trailingStop > lockedStop && Math.abs(trailingStop - (previous.currentStop || 0)) > 0.01) {
      console.log(`  ${symbol}: Trailing stop rising with peak, updating Alpaca...`);
      const newId = await updateStopLoss(pos, currentStop);
      if (newId) newStopOrderId = newId;
    }
  }

  // MONITORING MESSAGE - only in scan mode (every 5 min)
  if (mode === "scan") {
    const monMsg = formatMonitor(pos, currentPremium, peakPremium, currentStop, minutesElapsed);
    await sendTelegram(monMsg, pos.entryMessageId);
  }

  // Update state
  return {
    ...previous,
    peakPremium,
    currentStop,
    stopPhase: currentPhase,
    stopOrderId: newStopOrderId,
    breakEvenAnnounced: previous.breakEvenAnnounced || currentPhase !== "initial",
    bufferAnnounced: previous.bufferAnnounced || (currentPhase === "buffer" || currentPhase === "trailing"),
    trailingAnnounced: previous.trailingAnnounced || currentPhase === "trailing",
  };
}

async function executeV16Exit(symbol, pos, currentPremium, reason, minutesElapsed, skipClose = false) {
  // V16.4: Cancel Stop Loss order if it exists (avoid double-sell)
  if (pos.stopOrderId && !skipClose) {
    await cancelOrder(pos.stopOrderId);
    await new Promise(r => setTimeout(r, 300));
  }

  // Close position via Market Order (unless Alpaca already did it)
  if (!skipClose) {
    try {
      await closePosition(pos.optionSymbol);
      console.log(`  ${symbol}: Closed position ${pos.optionSymbol}`);
    } catch (e) {
      console.error(`  ${symbol}: Failed to close: ${e.message}`);
    }
  } else {
    console.log(`  ${symbol}: Position already closed by Alpaca Stop Loss`);
  }

  const msg = formatV16Exit(pos, currentPremium, reason, minutesElapsed);
  await sendTelegram(msg, pos.entryMessageId);

  const pnl = pos.qty * (currentPremium - pos.entryPremium) * 100;
  const pnlPct = ((currentPremium - pos.entryPremium) / pos.entryPremium) * 100;

  return {
    active: false,
    // V16.9: Smart cooldown based on exit reason
    cooldownUntil: Date.now() + (
      reason === "trailing" || reason === "profit" ? 2 * 60 * 1000 :    // profit: 2 min
      reason === "breakeven" || reason === "reversal" ? 5 * 60 * 1000 : // BE/reversal: 5 min
      10 * 60 * 1000                                                     // loss/force: 10 min
    ),
    lastSignal: pos.signal,
    _lastTrade: {
      symbol,
      signal: pos.signal,
      entryPremium: pos.entryPremium,
      exitPremium: currentPremium,
      qty: pos.qty,
      pnl,
      pnlPct,
      reason,
      minutes: minutesElapsed,
      // V16.14: Enhanced data for strategy analysis
      entryTime: pos.entryTime || null,
      exitTime: Date.now(),
      entryScore: pos.entryScore || null,
      setup: pos.setup || null,
      strike: pos.strike || null,
      entryPrice: pos.entryPrice || null,
      recovered: pos.recovered || false,
    },
  };
}

// Old executeExit kept for backward compatibility (not used in v16)
async function executeExit_unused(symbol, pos, currentPremium, reason, minutesElapsed) {
  return await executeV16Exit(symbol, pos, currentPremium, reason, minutesElapsed);
}

async function executeEntry(symbol, r, account, now) {
  const meta = META[symbol];

  // V16.7: Check Alpaca for existing positions (prevent duplicates after state reset)
  try {
    const positions = await alpacaCall(`${TRADING_BASE}/positions`);
    const hasExisting = Array.isArray(positions) && positions.some(p =>
      p.symbol && p.symbol.startsWith(symbol)
    );
    if (hasExisting) {
      console.log(`  ${symbol}: Alpaca already has a position - skipping`);
      return null;
    }
  } catch (e) {
    console.error(`  ${symbol}: Failed to check positions: ${e.message}`);
  }

  const contract = await pickOptionContract(symbol, r.signal, r.suggestedStrike, meta.strikeStep);
  if (!contract) {
    console.log(`  ${symbol}: No suitable 0DTE contract found`);
    return null;
  }

  const quote = await getOptionQuote(contract.symbol);
  if (!quote || quote.ask === 0) {
    console.log(`  ${symbol}: No quote for ${contract.symbol}`);
    return null;
  }

  const entryPremium = quote.ask; // use ask for buying
  const portfolioValue = parseFloat(account.portfolio_value); // V16.5: real from Alpaca
  // V16.7: Use 1% since Alpaca portfolio is ~$100K (simulates 10% of $10K budget)
  const qty = calculateQty(portfolioValue, entryPremium, 0.01);

  if (qty < 1) {
    console.log(`  ${symbol}: Not enough buying power`);
    return null;
  }

  // Place market order
  let orderResult;
  try {
    orderResult = await placeOptionOrder(contract.symbol, qty, "buy");
    console.log(`  ${symbol}: BUY order placed - ${contract.symbol} x${qty} @ ~$${entryPremium}`);
  } catch (e) {
    console.error(`  ${symbol}: BUY failed: ${e.message}`);
    await sendTelegram(`⚠️ <b>${symbol}: فشل تنفيذ ${r.signal}</b>\n${e.message.substring(0, 100)}`);
    return null;
  }

  // V16.15: Calculate Hybrid ATR+Score stop config
  const stopConfig = calculateStopConfig(r.price, r.atr5m, r.score);
  console.log(`  ${symbol}: Stop config - Initial -${stopConfig.stopPct}%, BE +${stopConfig.bePct}%, Trail +${stopConfig.trailPct}%`);

  // V16.4: Place Stop Loss in Alpaca for instant protection
  const initialStop = entryPremium * (1 - stopConfig.stopPct / 100);
  let stopOrderId = null;
  await new Promise(r => setTimeout(r, 1500)); // Wait for buy to settle
  try {
    const stopOrder = await placeStopLossOrder(contract.symbol, qty, initialStop);
    stopOrderId = stopOrder.id;
    console.log(`  ${symbol}: Stop Loss placed @ $${initialStop.toFixed(2)} (order ${stopOrderId})`);
  } catch (e) {
    console.error(`  ${symbol}: Stop Loss placement failed: ${e.message}`);
    // Continue without Stop Loss - bot monitoring is backup
  }

  const pos = {
    active: true,
    signal: r.signal,
    entryScore: r.score,
    entryPrice: r.price,
    entryTime: now,
    setup: r.setup || null, // V16.14: store setup name for analysis
    stopConfig, // V16.15: Hybrid ATR+Score stop thresholds
    optionSymbol: contract.symbol,
    strike: contract.strike_price,
    entryPremium,
    qty,
    orderId: orderResult.id,
    stopOrderId, // V16.4: track Stop Loss order
    // v16 fields
    peakPremium: entryPremium,
    currentStop: initialStop,
    stopPhase: "initial",
    breakEvenAnnounced: false,
    bufferAnnounced: false,
    trailingAnnounced: false,
  };

  const msg = formatBuyAlert(r, pos);
  const messageId = await sendTelegram(msg);
  pos.entryMessageId = messageId;

  return pos;
}

async function main() {
  const MODE = process.env.MODE || "scan"; // "scan" or "monitor"
  console.log(`\n=== ${MODE === "monitor" ? "Monitor" : "Scan"} v16 started ${new Date().toISOString()} ===`);
  console.log(`MIN_SCORE = ${MIN_SCORE}`);

  if (!isMarketOpen()) {
    console.log("Market closed, skipping");
    return;
  }

  const state = loadState();
  const now = Date.now();

  // V16.20: FORCE CLOSE ORPHAN POSITIONS - Don't recover stale positions
  // Positions in Alpaca but not in state are from previous days = force close immediately
  try {
    const alpacaPositions = await alpacaCall(`${TRADING_BASE}/positions`);
    if (Array.isArray(alpacaPositions)) {
      for (const pos of alpacaPositions) {
        const match = pos.symbol && pos.symbol.match(/^([A-Z]+)\d/);
        if (!match) continue;
        const symbol = match[1];
        if (!TICKERS.includes(symbol)) continue;

        if (!state[symbol] || !state[symbol].active) {
          console.log(`🚨 ORPHAN ${symbol} detected: ${pos.symbol} - FORCE CLOSING (stale position)`);
          try {
            await closePosition(pos.symbol);
            await sendTelegram(`⚠️ <b>${symbol}</b>: تم إغلاق صفقة يتيمة من اليوم السابق\n📋 ${pos.symbol}`);
          } catch (e) {
            console.error(`Failed to close orphan ${symbol}:`, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error("Orphan check failed:", e.message);
  }

  // MONITOR MODE: only check active positions, no scanning
  if (MODE === "monitor") {
    const activeSymbols = Object.keys(state).filter(s => state[s]?.active === true);
    if (activeSymbols.length === 0) {
      console.log("No active positions, exiting");
      return;
    }
    console.log(`Monitoring ${activeSymbols.length} position(s): ${activeSymbols.join(", ")}`);

    const newState = { ...state };
    for (const symbol of activeSymbols) {
      const previous = state[symbol];
      const decision = isPastForceExitTime(now)
        ? { action: "force_exit" }
        : { action: "monitor" };
      const result = await processActivePosition(symbol, null, previous, now, decision, "monitor");
      if (result._lastTrade) {
        newState._dailyTrades = newState._dailyTrades || [];
        newState._dailyTrades.push(result._lastTrade);
        delete result._lastTrade;
      }
      newState[symbol] = result;
    }
    saveState(newState);
    console.log(`=== Monitor Done ===\n`);
    return;
  }

  // SCAN MODE: full scan
  const newState = {};
  const results = [];

  // Get account info first
  let account;
  try {
    account = await getAccount();
    console.log(`Account: Cash $${account.cash}, Portfolio $${account.portfolio_value}`);
  } catch (e) {
    console.error(`Account fetch failed: ${e.message}`);
    return;
  }

  // Analyze all tickers
  for (const symbol of TICKERS) {
    try {
      const r = await analyzeTicker(symbol);
      results.push(r);
      console.log(`OK ${symbol}: $${r.price} | ${r.signal} ${r.score}% | ${r.setup?.name || "-"}`);
    } catch (e) {
      console.error(`FAIL ${symbol}: ${e.message}`);
      results.push({ symbol, error: e.message });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Initialize daily trades log
  const today = new Date().toISOString().split("T")[0];
  if (state._date !== today) {
    state._dailyTrades = [];
    state._date = today;
    state._reportSent = false;
  }
  newState._date = today;
  newState._dailyTrades = state._dailyTrades || [];
  newState._reportSent = state._reportSent || false;

  // V16.8: Count current open positions for position limit
  let activeCount = 0;
  try {
    const alpacaPositions = await alpacaCall(`${TRADING_BASE}/positions`);
    activeCount = Array.isArray(alpacaPositions) ? alpacaPositions.length : 0;
    console.log(`Current open positions in Alpaca: ${activeCount}`);
  } catch (e) {
    activeCount = Object.keys(state).filter(s => state[s]?.active === true).length;
    console.log(`Using state count (Alpaca fetch failed): ${activeCount}`);
  }

  // V16.18: Limit entries PER SCAN (prevents multi-loss from one bad market move)
  let entriesThisScan = 0;
  const MAX_ENTRIES_PER_SCAN = 2;

  // V16.20: Correlated pairs - block second entry of same pair in same scan
  // SPY+QQQ both broad tech ETFs (95% correlated), one move = both move
  const CORRELATED_PAIRS = {
    "SPY": "QQQ",
    "QQQ": "SPY",
  };
  const enteredThisScan = new Set();

  // Process each ticker
  for (const r of results) {
    if (r.error) {
      const prev = state[r.symbol];
      if (prev) newState[r.symbol] = prev;
      continue;
    }

    const previous = state[r.symbol];
    const decision = decideAction(r, previous, now);
    console.log(`  ${r.symbol}: decision = ${decision.action}`);

    if (decision.action === "new_entry") {
      // V16.8: Max 3 positions unless score is 90%+
      if (activeCount >= 3 && r.score < 90) {
        console.log(`  ${r.symbol}: Max positions limit (${activeCount}/3), score ${r.score}% < 90% - skipping`);
        if (previous) newState[r.symbol] = previous;
        continue;
      }

      // V16.18: Max 2 entries per scan (unless score is 90%+)
      if (entriesThisScan >= MAX_ENTRIES_PER_SCAN && r.score < 90) {
        console.log(`  ${r.symbol}: Already ${entriesThisScan} entries this scan, score ${r.score}% < 90% - skipping`);
        if (previous) newState[r.symbol] = previous;
        continue;
      }

      // V16.20: Correlated pair block - if pair already entered, skip
      const pair = CORRELATED_PAIRS[r.symbol];
      if (pair && enteredThisScan.has(pair)) {
        console.log(`  ${r.symbol}: BLOCKED - correlated pair ${pair} already entered this scan`);
        if (previous) newState[r.symbol] = previous;
        continue;
      }

      const newPos = await executeEntry(r.symbol, r, account, now);
      if (newPos) {
        newState[r.symbol] = newPos;
        activeCount++;
        entriesThisScan++;
        enteredThisScan.add(r.symbol);
      } else if (previous) {
        newState[r.symbol] = previous;
      }
    }
    else if (decision.action === "no_entry_time") {
      console.log(`  ${r.symbol}: No new entries after 2:30 PM`);
      if (previous) newState[r.symbol] = previous;
    }
    else if (decision.action === "fomc_cutoff") {
      console.log(`  ${r.symbol}: 🏦 FOMC DAY - No new entries after 12:30 PM CDT`);
      if (previous) newState[r.symbol] = previous;
    }
    else if (decision.action === "duplicate") {
      console.log(`  ${r.symbol}: Duplicate signal blocked (already have ${previous.signal} position)`);
      if (previous && previous.active) {
        const result = await processActivePosition(r.symbol, r, previous, now, { action: "monitor" }, "scan");
        if (result._lastTrade) {
          newState._dailyTrades.push(result._lastTrade);
          delete result._lastTrade;
        }
        newState[r.symbol] = result;
      } else {
        newState[r.symbol] = previous;
      }
    }
    else if (previous && previous.active) {
      const result = await processActivePosition(r.symbol, r, previous, now, decision, "scan");
      if (result._lastTrade) {
        newState._dailyTrades.push(result._lastTrade);
        delete result._lastTrade;
      }
      newState[r.symbol] = result;
    }
    else if (decision.action === "cooldown") {
      newState[r.symbol] = previous;
    }
    else {
      if (previous) newState[r.symbol] = previous;
    }
  }

  // Daily report at 3:00 PM (sent to channel)
  if (isReportTime(now) && !newState._reportSent) {
    const reportMsg = await formatDailyReport(newState);
    await sendTelegram(reportMsg);
    newState._reportSent = true;
    console.log("Daily report sent");

    // V16.14: Strategy Analysis to PRIVATE chat (not channel)
    try {
      let analysisMsg = await analyzeStrategy(newState);
      // V16.17: Strip HTML tags to avoid parse errors
      analysisMsg = analysisMsg.replace(/<\/?b>/g, "").replace(/<\/?i>/g, "");
      const personalChatId = "810642442"; // Personal chat, NOT channel
      const tgToken = process.env.TG_TOKEN;
      if (tgToken) {
        const resp = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: personalChatId,
            text: analysisMsg,
          }),
        });
        if (resp.ok) {
          console.log("Strategy analysis sent to private chat");
        } else {
          const err = await resp.text();
          console.error("Strategy analysis failed:", err);
        }
      }

      // V16.19: Send state.json as document to private chat for deep AI analysis
      try {
        const stateJson = JSON.stringify(newState, null, 2);
        const today = new Date().toISOString().split("T")[0];
        const formData = new FormData();
        formData.append("chat_id", personalChatId);
        formData.append("caption", `📋 state.json - ${today}\nانسخه لـ Claude للتحليل العميق`);
        formData.append("document", new Blob([stateJson], { type: "application/json" }), `state-${today}.json`);

        const docResp = await fetch(`https://api.telegram.org/bot${tgToken}/sendDocument`, {
          method: "POST",
          body: formData,
        });
        if (docResp.ok) {
          console.log("state.json sent to private chat");
        } else {
          const err = await docResp.text();
          console.error("state.json send failed:", err);
        }
      } catch (e) {
        console.error("Failed to send state.json:", e.message);
      }
    } catch (e) {
      console.error("Failed to send strategy analysis:", e.message);
    }
  }

  saveState(newState);
  console.log(`=== Scan Done ===\n`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  sendTelegram(`Bot error: ${e.message}`).catch(() => {});
  process.exit(1);
});
