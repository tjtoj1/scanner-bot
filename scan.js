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
  const atmStrike = Math.round(price / meta.strikeStep) * meta.strikeStep;

  return {
    symbol, price: parseFloat(price.toFixed(2)), pct, volRatio,
    rsi5m, rsi15m,
    macd5m: macd5m?.bias, macd15m: macd15m?.bias,
    vwap: vwap5m, vwapBias: price > vwap5m ? "above" : "below",
    gamma, setup, signal, strengthAr, score, reasons,
    suggestedStrike: atmStrike, riskNote: meta.risk, posSize: meta.posSize,
    bullScore: bull.score, bearScore: bear.score,
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

function isReportTime(now) {
  // 3:00 PM CDT = 20:00 UTC, fire once
  const d = now ? new Date(now) : new Date();
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin >= 20 * 60 && utcMin < 20 * 60 + 10;
}

// ============================================================
// V16: PHASED TRAILING STOP SYSTEM
// ============================================================
function calculatePhase(entryPremium, peakPremium) {
  const peakPct = ((peakPremium - entryPremium) / entryPremium) * 100;
  if (peakPct >= 30) return "trailing";
  if (peakPct >= 10) return "breakeven";
  return "initial";
}

function calculateStop(entryPremium, peakPremium) {
  const phase = calculatePhase(entryPremium, peakPremium);
  switch (phase) {
    case "trailing":  return Math.max(entryPremium * 1.30, peakPremium * 0.95); // Lock +30% or Peak-5%
    case "breakeven": return entryPremium;                                       // Entry price
    default:          return entryPremium * 0.70;                                // -30%
  }
}

function getPhaseLabel(phase) {
  switch (phase) {
    case "trailing":  return "Trailing (+30% Min / Peak - 5%)";
    case "breakeven": return "Break-Even";
    default:          return "Initial (-30%)";
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
  const phase = calculatePhase(pos.entryPremium, peakPremium);
  const emoji = getPhaseEmoji(phase);
  const phaseLabel = getPhaseLabel(phase);
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

  return `📊 <b>Daily Report - ${dateHeader}</b>

💼 الصفقات: ${trades.length}
✅ ربحانة: ${wins.length} (${winRate}%)
❌ خسرانة: ${losses.length}

💰 صافي: ${dailyChange >= 0 ? "+" : ""}$${dailyChange.toFixed(0)} (${dailyChangePct >= 0 ? "+" : ""}${dailyChangePct.toFixed(1)}%)
🥇 أفضل: ${best.symbol} ${best.signal} ${(best.pnlPct >= 0 ? "+" : "")}${best.pnlPct.toFixed(1)}%
🥉 أسوأ: ${worst.symbol} ${worst.signal} ${worst.pnlPct.toFixed(1)}%

📈 الرصيد: $${portfolioValue.toFixed(0)}`;
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
        const currentPhase = calculatePhase(pos.entryPremium, previous.peakPremium || previous.entryPremium);
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

  // Calculate phase and stop
  const previousPhase = calculatePhase(pos.entryPremium, previous.peakPremium || previous.entryPremium);
  const currentPhase = calculatePhase(pos.entryPremium, peakPremium);
  const currentStop = calculateStop(pos.entryPremium, peakPremium);

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
    cooldownUntil: reason === "reversal" ? Date.now() + 5 * 60 * 1000 : Date.now() + 5 * 60 * 1000,
    lastSignal: pos.signal, // V16.6: preserve for reversal check during cooldown
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

  // V16.4: Place Stop Loss in Alpaca for instant protection
  const initialStop = entryPremium * 0.70; // -30%
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
      const newPos = await executeEntry(r.symbol, r, account, now);
      if (newPos) {
        newState[r.symbol] = newPos;
      } else if (previous) {
        newState[r.symbol] = previous;
      }
    }
    else if (decision.action === "no_entry_time") {
      console.log(`  ${r.symbol}: No new entries after 2:30 PM`);
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

  // Daily report at 3:00 PM
  if (isReportTime(now) && !newState._reportSent) {
    const reportMsg = await formatDailyReport(newState);
    await sendTelegram(reportMsg);
    newState._reportSent = true;
    console.log("Daily report sent");
  }

  saveState(newState);
  console.log(`=== Scan Done ===\n`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  sendTelegram(`Bot error: ${e.message}`).catch(() => {});
  process.exit(1);
});
