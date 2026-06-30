// ============================================================
// 0DTE SPY MASTER SYSTEM v17.0
// Window-Based Strategy with Support/Resistance + Pullback Entry
// ============================================================

import fs from "fs";

const ALPACA_KEY = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const PERSONAL_CHAT = "810642442";

if (!ALPACA_KEY || !ALPACA_SECRET || !TG_TOKEN || !TG_CHAT) {
  console.log("Missing env vars");
  process.exit(1);
}

const DATA_BASE = "https://data.alpaca.markets/v2";
const OPTIONS_BASE = "https://data.alpaca.markets/v1beta1/options";
const TRADING_BASE = "https://paper-api.alpaca.markets/v2";

// ============================================================
// CONFIG
// ============================================================
const TICKERS = ["SPY", "QQQ", "IWM", "GLD"];

// Per-ticker config (strikeStep, position size factor)
const TICKER_CONFIG = {
  SPY: { strikeStep: 1, sizeFactor: 1.0 },
  QQQ: { strikeStep: 1, sizeFactor: 1.0 },
  IWM: { strikeStep: 1, sizeFactor: 0.8 },  // smaller size (higher volatility)
  GLD: { strikeStep: 1, sizeFactor: 0.7 },  // smaller size (less liquid in 0DTE)
};

// Trading Windows (CDT timezone, in UTC for comparison)
// Each window has: name, start time, end time, strategy type, risk params
const WINDOWS = [
  {
    name: "ORB_Pullback",
    startUTC: { h: 13, m: 35 },  // 8:35 AM CDT
    endUTC: { h: 14, m: 30 },    // 9:30 AM CDT
    strategy: "pullback",
    targetPct: 75,
    stopPct: 40,
    timeExitMin: 25,             // exit after 25 min if open
    riskPct: 0.5,                // 0.5% portfolio risk
  },
  {
    name: "MidMorning_VWAP",
    startUTC: { h: 15, m: 0 },   // 10:00 AM CDT
    endUTC: { h: 16, m: 0 },     // 11:00 AM CDT
    strategy: "vwap_touch",
    targetPct: 60,
    stopPct: 35,
    timeExitMin: 25,
    riskPct: 0.4,
  },
  // 11:00 AM - 12:30 PM CDT = LUNCH LULL = NO TRADES
  {
    name: "Afternoon_Resume",
    startUTC: { h: 17, m: 30 },  // 12:30 PM CDT
    endUTC: { h: 18, m: 30 },    // 1:30 PM CDT
    strategy: "trend_resume",
    targetPct: 60,
    stopPct: 35,
    timeExitMin: 25,
    riskPct: 0.4,
  },
  {
    name: "Late_Day_Fade",
    startUTC: { h: 18, m: 30 },  // 1:30 PM CDT
    endUTC: { h: 19, m: 30 },    // 2:30 PM CDT
    strategy: "fade",
    targetPct: 50,
    stopPct: 30,
    timeExitMin: 20,
    riskPct: 0.3,
  },
  {
    name: "MOC_Scalp",
    startUTC: { h: 19, m: 30 },  // 2:30 PM CDT
    endUTC: { h: 19, m: 50 },    // 2:50 PM CDT
    strategy: "moc",
    targetPct: 40,
    stopPct: 25,
    timeExitMin: 10,
    riskPct: 0.3,
  },
];

const FORCE_EXIT_TIME = { h: 19, m: 58 }; // 2:58 PM CDT
const REPORT_TIME = { h: 20, m: 0 };       // 3:00 PM CDT

// Risk Management Layer 2 - Trade Management
const QUICK_EXIT_PCT = 30;    // -30% in first minute → exit
const PROFIT_PARTIAL_1 = 30;  // +30% → sell 50%
const PROFIT_BE_PCT = 50;     // +50% → move stop to entry (BE)
const PROFIT_PARTIAL_2 = 75;  // +75% → sell 25% more
const PROFIT_TRAIL_PCT = 100; // +100% → trailing stop on last 25%

// FOMC dates 2026
const FOMC_DATES = ["2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];

// ============================================================
// STATE
// ============================================================
function loadState() {
  try {
    return JSON.parse(fs.readFileSync("state.json", "utf8"));
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
}

// ============================================================
// TIME HELPERS
// ============================================================
function nowUTC() {
  const d = new Date();
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

function utcToMinutes(t) {
  return t.h * 60 + t.m;
}

function isInWindow(now, window) {
  const currentMin = utcToMinutes(now);
  const startMin = utcToMinutes(window.startUTC);
  const endMin = utcToMinutes(window.endUTC);
  return currentMin >= startMin && currentMin < endMin;
}

function getCurrentWindow() {
  const now = nowUTC();
  for (const w of WINDOWS) {
    if (isInWindow(now, w)) return w;
  }
  return null;
}

function isPastForceExit() {
  const now = nowUTC();
  return utcToMinutes(now) >= utcToMinutes(FORCE_EXIT_TIME);
}

function isReportTime() {
  const now = nowUTC();
  const cur = utcToMinutes(now);
  const target = utcToMinutes(REPORT_TIME);
  return cur >= target && cur < target + 10;
}

function isFomcDay() {
  const today = new Date().toISOString().split("T")[0];
  return FOMC_DATES.includes(today);
}

function isFomcCutoff() {
  if (!isFomcDay()) return false;
  const now = nowUTC();
  // On FOMC days, no entries after 12:30 PM CDT = 17:30 UTC
  return utcToMinutes(now) >= 17 * 60 + 30;
}

// ============================================================
// INDICATORS
// ============================================================
function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function vwap(bars) {
  let cumPV = 0, cumVol = 0;
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    cumPV += typical * b.v;
    cumVol += b.v;
  }
  return cumVol === 0 ? 0 : cumPV / cumVol;
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].h, low = bars[i].l, prevClose = bars[i - 1].c;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ============================================================
// SUPPORT/RESISTANCE CALCULATOR (NEW in v17)
// ============================================================
async function calculateSupportResistance(symbol) {
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Get yesterday's full session for PDH/PDL/PDC
  // V17.2: Fetch 7 days to handle holidays/weekends
  const yesterdayBars = await getBars(symbol, "1Day", 7);
  let pdc = null, pdh = null, pdl = null;
  if (yesterdayBars && yesterdayBars.length >= 1) {
    // Find the most recent COMPLETED trading day (not today)
    const todayStr = new Date().toISOString().split("T")[0];
    const previousDays = yesterdayBars.filter(b => !b.t.startsWith(todayStr));
    if (previousDays.length >= 1) {
      const lastTradingDay = previousDays[previousDays.length - 1];
      pdc = lastTradingDay.c;
      pdh = lastTradingDay.h;
      pdl = lastTradingDay.l;
    }
  }

  // Get pre-market bars (4 AM CDT - 8:30 AM CDT = 9-13:30 UTC)
  // Alpaca extended hours returns these
  const preMarketBars = await getBars(symbol, "5Min", 1, true);
  let pmh = null, pml = null;
  if (preMarketBars && preMarketBars.length > 0) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
    const marketOpen = new Date();
    marketOpen.setUTCHours(13, 30, 0, 0); // 8:30 AM CDT = 13:30 UTC

    const pmBars = preMarketBars.filter(b => {
      const t = new Date(b.t);
      return t < marketOpen && t.toISOString().split("T")[0] === today;
    });

    if (pmBars.length > 0) {
      pmh = Math.max(...pmBars.map(b => b.h));
      pml = Math.min(...pmBars.map(b => b.l));
    }
  }

  // Daily Pivot Points (from yesterday's H/L/C)
  let pivot = null, r1 = null, s1 = null;
  if (pdh && pdl && pdc) {
    pivot = (pdh + pdl + pdc) / 3;
    r1 = 2 * pivot - pdl;
    s1 = 2 * pivot - pdh;
  }

  return {
    pmh,    // Pre-Market High
    pml,    // Pre-Market Low
    pdc,    // Previous Day Close
    pdh,    // Previous Day High
    pdl,    // Previous Day Low
    pivot,  // Daily Pivot
    r1,     // Resistance 1
    s1,     // Support 1
  };
}

// Check if price is near a key level (within tolerance)
function isNearLevel(price, level, tolerancePct = 0.15) {
  if (!level) return false;
  const dist = Math.abs(price - level) / level * 100;
  return dist <= tolerancePct;
}

// Find nearest support level below current price
function findNearestSupport(price, sr) {
  const levels = [sr.pml, sr.pdc, sr.pdl, sr.s1, sr.pivot].filter(l => l && l < price);
  if (levels.length === 0) return null;
  return Math.max(...levels); // closest support is the highest one below
}

// Find nearest resistance level above current price
function findNearestResistance(price, sr) {
  const levels = [sr.pmh, sr.pdc, sr.pdh, sr.r1, sr.pivot].filter(l => l && l > price);
  if (levels.length === 0) return null;
  return Math.min(...levels);
}

// ============================================================
// DATA HELPERS
// ============================================================
async function getBars(symbol, timeframe, daysBack = 1, includeExtended = false) {
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&limit=1000${includeExtended ? "&adjustment=raw" : ""}`;
  try {
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
    });
    const data = await res.json();
    return data.bars || [];
  } catch (e) {
    console.error(`getBars ${symbol} ${timeframe}: ${e.message}`);
    return [];
  }
}

async function getLatestPrice(symbol) {
  try {
    const res = await fetch(`${DATA_BASE}/stocks/${symbol}/trades/latest`, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
    });
    const data = await res.json();
    return data.trade?.p || null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// VIX FETCHER
// ============================================================
async function getVIX() {
  try {
    const bars = await getBars("VIXY", "1Day", 2);
    if (bars.length === 0) return null;
    return bars[bars.length - 1].c;
  } catch (e) {
    return null;
  }
}

// ============================================================
// PULLBACK DETECTOR (Core of new strategy)
// ============================================================
function detectPullback(bars1m, bars5m, vwapVal, ema9Val) {
  if (bars1m.length < 5 || bars5m.length < 5) return null;

  const last1m = bars1m[bars1m.length - 1];
  const prev1m = bars1m[bars1m.length - 2];
  const beforePrev1m = bars1m[bars1m.length - 3];

  const trend5m = bars5m.slice(-3);
  const trendUp = trend5m[2].c > trend5m[0].c;
  const trendDown = trend5m[2].c < trend5m[0].c;

  // BULLISH PULLBACK PATTERN:
  // 1. 5m trend is up
  // 2. Recent 1m candles pulled back close to VWAP or EMA9
  // 3. Last candle shows bounce (green close, lower wick rejection)
  if (trendUp) {
    const minLow = Math.min(prev1m.l, beforePrev1m.l);
    const nearVWAP = minLow <= vwapVal * 1.001 && minLow >= vwapVal * 0.998;
    const nearEMA = minLow <= ema9Val * 1.001 && minLow >= ema9Val * 0.998;
    if (nearVWAP || nearEMA) {
      // Check current bar is bouncing
      const isBouncing = last1m.c > last1m.o && last1m.c > prev1m.c;
      const wickRejection = (last1m.c - last1m.l) > (last1m.h - last1m.c) * 1.5;
      if (isBouncing || wickRejection) {
        return { direction: "CALL", level: nearVWAP ? "VWAP" : "EMA9", strength: wickRejection ? "strong" : "normal" };
      }
    }
  }

  // BEARISH PULLBACK PATTERN:
  if (trendDown) {
    const maxHigh = Math.max(prev1m.h, beforePrev1m.h);
    const nearVWAP = maxHigh >= vwapVal * 0.999 && maxHigh <= vwapVal * 1.002;
    const nearEMA = maxHigh >= ema9Val * 0.999 && maxHigh <= ema9Val * 1.002;
    if (nearVWAP || nearEMA) {
      const isFalling = last1m.c < last1m.o && last1m.c < prev1m.c;
      const wickRejection = (last1m.h - last1m.c) > (last1m.c - last1m.l) * 1.5;
      if (isFalling || wickRejection) {
        return { direction: "PUT", level: nearVWAP ? "VWAP" : "EMA9", strength: wickRejection ? "strong" : "normal" };
      }
    }
  }

  return null;
}

// ============================================================
// STRATEGY: Window-Specific Analysis
// ============================================================
async function analyzeStrategy(window, sr, indicators) {
  const { price, bars1m, bars5m, vwap5m, ema9, rsi5m, atrVal, vix } = indicators;

  // VIX filter (15-25 ideal)
  if (vix && (vix < 12 || vix > 30)) {
    return { signal: "NEUTRAL", reason: `VIX ${vix.toFixed(1)} outside 12-30 range` };
  }

  // FOMC cutoff
  if (isFomcCutoff()) {
    return { signal: "NEUTRAL", reason: "FOMC cutoff active" };
  }

  // Detect pullback
  const pullback = detectPullback(bars1m, bars5m, vwap5m, ema9);
  if (!pullback) {
    return { signal: "NEUTRAL", reason: "No valid pullback detected" };
  }

  // Window-specific logic
  switch (window.strategy) {
    case "pullback":
    case "vwap_touch":
    case "trend_resume":
      // Need S/R confluence
      if (pullback.direction === "CALL") {
        const support = findNearestSupport(price, sr);
        if (!support) return { signal: "NEUTRAL", reason: "No support level identified" };
        const distFromSupport = (price - support) / support * 100;
        if (distFromSupport > 0.3) {
          return { signal: "NEUTRAL", reason: `Too far from support ${support.toFixed(2)} (${distFromSupport.toFixed(2)}%)` };
        }
        // Check not at resistance
        const resistance = findNearestResistance(price, sr);
        if (resistance) {
          const distToRes = (resistance - price) / price * 100;
          if (distToRes < 0.1) {
            return { signal: "NEUTRAL", reason: `Too close to resistance ${resistance.toFixed(2)}` };
          }
        }
        // RSI check
        if (rsi5m > 70) {
          return { signal: "NEUTRAL", reason: `RSI ${rsi5m.toFixed(1)} > 70 (overbought)` };
        }
        return {
          signal: "CALL",
          reason: `Pullback bounce at ${pullback.level}, near support ${support.toFixed(2)}`,
          support, resistance, pullback,
        };
      } else { // PUT
        const resistance = findNearestResistance(price, sr);
        if (!resistance) return { signal: "NEUTRAL", reason: "No resistance level identified" };
        const distFromRes = (resistance - price) / price * 100;
        if (distFromRes > 0.3) {
          return { signal: "NEUTRAL", reason: `Too far from resistance ${resistance.toFixed(2)} (${distFromRes.toFixed(2)}%)` };
        }
        const support = findNearestSupport(price, sr);
        if (support) {
          const distToSup = (price - support) / price * 100;
          if (distToSup < 0.1) {
            return { signal: "NEUTRAL", reason: `Too close to support ${support.toFixed(2)}` };
          }
        }
        if (rsi5m < 30) {
          return { signal: "NEUTRAL", reason: `RSI ${rsi5m.toFixed(1)} < 30 (oversold)` };
        }
        return {
          signal: "PUT",
          reason: `Pullback rejection at ${pullback.level}, near resistance ${resistance.toFixed(2)}`,
          resistance, support, pullback,
        };
      }

    case "fade":
      // Late-day reversal: go OPPOSITE of morning trend
      // If morning trend was up, look for PUT setup near resistance
      // If morning trend was down, look for CALL setup near support
      // (logic similar but with reversed trend assumption)
      if (pullback.direction === "PUT") {
        const resistance = findNearestResistance(price, sr);
        if (!resistance || (resistance - price) / price * 100 > 0.3) {
          return { signal: "NEUTRAL", reason: "Fade: no nearby resistance" };
        }
        return { signal: "PUT", reason: `Late-day fade: rejection at resistance`, resistance, pullback };
      }
      if (pullback.direction === "CALL") {
        const support = findNearestSupport(price, sr);
        if (!support || (price - support) / support * 100 > 0.3) {
          return { signal: "NEUTRAL", reason: "Fade: no nearby support" };
        }
        return { signal: "CALL", reason: `Late-day fade: bounce at support`, support, pullback };
      }
      break;

    case "moc":
      // Quick scalp - direction = strongest trend
      // ATM strike, quick exit
      if (pullback.strength === "strong") {
        if (pullback.direction === "CALL") {
          const support = findNearestSupport(price, sr);
          return { signal: "CALL", reason: "MOC scalp: strong pullback bounce", support, pullback };
        } else {
          const resistance = findNearestResistance(price, sr);
          return { signal: "PUT", reason: "MOC scalp: strong pullback rejection", resistance, pullback };
        }
      }
      return { signal: "NEUTRAL", reason: "MOC: pullback not strong enough" };
  }

  return { signal: "NEUTRAL", reason: "No matching strategy logic" };
}

// ============================================================
// ALPACA HELPERS
// ============================================================
async function alpacaCall(url, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Alpaca ${method} ${url.split("/").slice(-2).join("/")}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getAccount() {
  return await alpacaCall(`${TRADING_BASE}/account`);
}

async function getPosition(optionSymbol) {
  try {
    return await alpacaCall(`${TRADING_BASE}/positions/${optionSymbol}`);
  } catch (e) {
    return null;
  }
}

async function closePosition(optionSymbol, qty = null) {
  if (qty) {
    // V17.8: Add position_intent=sell_to_close to avoid uncovered short interpretation
    return await alpacaCall(`${TRADING_BASE}/orders`, "POST", {
      symbol: optionSymbol,
      qty: qty,
      side: "sell",
      type: "market",
      time_in_force: "day",
      position_intent: "sell_to_close",
    });
  }
  return await alpacaCall(`${TRADING_BASE}/positions/${optionSymbol}`, "DELETE");
}

async function placeOptionOrder(optionSymbol, qty, side) {
  return await alpacaCall(`${TRADING_BASE}/orders`, "POST", {
    symbol: optionSymbol,
    qty,
    side,
    type: "market",
    time_in_force: "day",
  });
}

async function placeStopLossOrder(optionSymbol, qty, stopPrice) {
  return await alpacaCall(`${TRADING_BASE}/orders`, "POST", {
    symbol: optionSymbol,
    qty,
    side: "sell",
    type: "stop",
    stop_price: stopPrice.toFixed(2),
    time_in_force: "day",
    position_intent: "sell_to_close",
  });
}

async function cancelOrder(orderId) {
  try {
    return await alpacaCall(`${TRADING_BASE}/orders/${orderId}`, "DELETE");
  } catch (e) {
    return null;
  }
}

// ============================================================
// OPTION HELPERS
// ============================================================
async function getOptionContracts(symbol, expirationDate, type, strikeMin, strikeMax) {
  const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date=${expirationDate}&type=${type === "CALL" ? "call" : "put"}&strike_price_gte=${strikeMin}&strike_price_lte=${strikeMax}&status=active&limit=20`;
  try {
    const data = await alpacaCall(url);
    return data?.option_contracts || [];
  } catch (e) {
    return [];
  }
}

async function pickOptionContract(symbol, signal, atmStrike) {
  const today = new Date().toISOString().split("T")[0];
  // v17: Use ATM strike (highest gamma for quick moves)
  // For SPY, strikeStep is $1, so just use atmStrike rounded
  const min = atmStrike - 0.5;
  const max = atmStrike + 0.5;
  const contracts = await getOptionContracts(symbol, today, signal, min, max);
  if (contracts.length === 0) {
    // Try wider
    const wideContracts = await getOptionContracts(symbol, today, signal, atmStrike - 2, atmStrike + 2);
    if (wideContracts.length === 0) return null;
    wideContracts.sort((a, b) => Math.abs(a.strike_price - atmStrike) - Math.abs(b.strike_price - atmStrike));
    return wideContracts[0];
  }
  contracts.sort((a, b) => Math.abs(a.strike_price - atmStrike) - Math.abs(b.strike_price - atmStrike));
  return contracts[0];
}

async function getOptionQuote(optionSymbol) {
  try {
    const res = await fetch(`${OPTIONS_BASE}/quotes/latest?symbols=${optionSymbol}`, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
    });
    const data = await res.json();
    const q = data.quotes?.[optionSymbol];
    if (!q) return null;
    return (q.ap + q.bp) / 2;
  } catch (e) {
    return null;
  }
}

function calculateQty(portfolioValue, premium, riskPct, stopPct) {
  // Risk-based position sizing
  // Max loss per contract = premium * (stopPct/100) * 100
  // We want total loss to equal portfolio * riskPct
  const targetLoss = portfolioValue * (riskPct / 100);
  const lossPerContract = premium * (stopPct / 100) * 100;
  const qty = Math.floor(targetLoss / lossPerContract);
  return Math.max(qty, 1);
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegram(text, chatId = null, replyTo = null) {
  const chat = chatId || TG_CHAT;
  try {
    const body = { chat_id: chat, text, parse_mode: "HTML" };
    if (replyTo) {
      body.reply_to_message_id = replyTo;
      body.allow_sending_without_reply = true; // don't fail if original was deleted
    }
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.result?.message_id || null;
  } catch (e) {
    console.error("Telegram error:", e.message);
    return null;
  }
}

// ============================================================
// MAIN: SCAN MODE
// ============================================================
async function runScan() {
  console.log(`=== Scan v17 started ${new Date().toISOString()} ===`);

  const state = loadState();
  const today = new Date().toISOString().split("T")[0];

  // Reset daily state on new day
  if (state._date !== today) {
    state._date = today;
    state._dailyTrades = [];
    state._reportSent = false;
    state._dailyLosses = 0;
    state._dailyTrades_count = 0;
    state._consecLosses = 0;
    saveState(state);
  }

  // Account check
  let account;
  try {
    account = await getAccount();
    console.log(`Account: Cash $${parseFloat(account.cash).toFixed(2)}, Portfolio $${parseFloat(account.portfolio_value).toFixed(2)}`);
  } catch (e) {
    console.log("Account fetch failed, skipping");
    return;
  }
  const portfolio = parseFloat(account.portfolio_value);

  // V17.5: ALPACA-STATE RECONCILIATION (Source of Truth = Alpaca)
  // Prevents orphan positions caused by state.json race conditions
  try {
    const alpacaPositions = await alpacaCall(`${TRADING_BASE}/positions`);
    const alpacaSymbols = new Set();

    if (Array.isArray(alpacaPositions)) {
      for (const pos of alpacaPositions) {
        // Extract underlying ticker from option symbol (e.g. SPY260626C00750000 → SPY)
        const match = pos.symbol && pos.symbol.match(/^([A-Z]+)\d/);
        if (!match) continue;
        const ticker = match[1];
        if (!TICKERS.includes(ticker)) continue;
        alpacaSymbols.add(ticker);

        // Case 1: Alpaca has position, state doesn't know → ADOPT
        if (!state[ticker]?.active) {
          // V17.9: Skip recovery for recently-opened positions (last 30 min)
          // 30 min covers: race conditions + active bot management (Time Exit = 25 min)
          // Only adopt truly orphaned positions (e.g. from previous session)
          if (pos.created_at) {
            const positionAge = Date.now() - new Date(pos.created_at).getTime();
            if (positionAge < 30 * 60 * 1000) {
              console.log(`⏭ Skipping ${ticker} recovery - position opened ${Math.round(positionAge/60000)}m ago (still actively managed)`);
              continue;
            }
          }
          // V17.9: Skip if ticker has recent cooldown (was just closed by this bot)
          if (state[ticker]?.cooldownUntil && (Date.now() - state[ticker].cooldownUntil) < 60 * 60 * 1000) {
            console.log(`⏭ Skipping ${ticker} recovery - recent cooldown indicates bot activity`);
            continue;
          }
          // V17.10: Skip if this exact option symbol was already recovered/traded today
          // Prevents double-recovery of same position due to Alpaca settlement delays
          const alreadyTradedToday = (state._dailyTrades || []).some(
            t => t.symbol === ticker && (t.window === "RECOVERED" || t.setup === "Recovered from Alpaca")
          );
          if (alreadyTradedToday) {
            console.log(`⏭ Skipping ${ticker} recovery - already recovered/traded today`);
            continue;
          }

          console.log(`🔄 RECONCILE: Adopting orphan ${ticker} position ${pos.symbol}`);
          const isCall = pos.symbol.includes("C0");
          const entryPremium = parseFloat(pos.avg_entry_price);
          const qty = parseInt(pos.qty);
          const strikeMatch = pos.symbol.match(/[CP](\d{8})$/);
          const strike = strikeMatch ? parseInt(strikeMatch[1]) / 1000 : null;

          state[ticker] = {
            active: true,
            signal: isCall ? "CALL" : "PUT",
            window: "RECOVERED",
            optionSymbol: pos.symbol,
            strike: strike ? String(strike) : null,
            entryPremium,
            qty,
            entryTime: pos.created_at ? new Date(pos.created_at).getTime() : Date.now() - (5 * 60 * 1000),
            orderId: null,
            stopOrderId: null,
            currentStop: entryPremium * 0.6, // 40% stop
            peakPremium: entryPremium,
            targetPct: 60,
            stopPct: 40,
            timeExitMin: 25,
            entryMessageId: null,
            reason: "Recovered from Alpaca",
            partial1Done: false,
            bePromoted: false,
            partial2Done: false,
            trailing: false,
            remainingQty: qty,
            quickExitWindow: false,
            recovered: true,
          };
          await sendTelegram(`🔄 <b>${ticker}</b> Position Recovered\nFound orphan in Alpaca, now tracking.\nEntry: $${entryPremium.toFixed(2)} × ${qty}`);
        }
      }
    }

    // Case 2: State says active, Alpaca doesn't have it → MARK CLOSED
    for (const ticker of TICKERS) {
      if (state[ticker]?.active && !alpacaSymbols.has(ticker)) {
        console.log(`🔄 RECONCILE: ${ticker} closed in Alpaca but state was active`);
        // Will be handled by processActivePosition - it detects missing position
      }
    }
  } catch (e) {
    console.error("Reconciliation failed:", e.message);
  }

  // Daily risk limits

  // Check current window
  const window = getCurrentWindow();
  if (!window) {
    console.log("Not in a trading window, Scan does nothing (Monitor handles positions)");
    saveState(state);
    return;
  }
  console.log(`Current window: ${window.name}`);

  // V17.5: Scan does NOT monitor positions - Monitor workflow handles that exclusively
  // This prevents duplicate Telegram messages from Scan+Monitor running together
  // Scan only handles: New entries + Daily report
  saveState(state);

  // Count active positions (from current state, just adopted from Alpaca)
  const activeCount = TICKERS.filter(s => state[s]?.active).length;
  if (activeCount >= 2) {
    console.log(`Max 2 active positions (${activeCount} open), skipping new entries`);
    return;
  }

  // Get VIX once
  const vix = await getVIX();

  // Loop over tickers for new entries
  for (const symbol of TICKERS) {
    if (state[symbol]?.active) continue;

    // Cooldown check
    if (state[symbol]?.cooldownUntil && Date.now() < state[symbol].cooldownUntil) {
      const remaining = Math.round((state[symbol].cooldownUntil - Date.now()) / 60000);
      console.log(`${symbol}: cooldown active (${remaining} min remaining)`);
      continue;
    }

    console.log(`\n--- Analyzing ${symbol} ---`);

    // Fetch market data
    const price = await getLatestPrice(symbol);
    if (!price) {
      console.log(`${symbol}: cannot fetch price`);
      continue;
    }

    const bars1m = await getBars(symbol, "1Min", 1);
    const bars5m = await getBars(symbol, "5Min", 2);
    if (bars1m.length < 20 || bars5m.length < 20) {
      console.log(`${symbol}: insufficient bar data`);
      continue;
    }

    const todayBars1m = bars1m.filter(b => b.t.startsWith(today));
    const todayBars5m = bars5m.filter(b => b.t.startsWith(today));

    const closes1m = todayBars1m.map(b => b.c);
    const closes5m = todayBars5m.map(b => b.c);
    const vwap5m = vwap(todayBars5m);
    const ema9 = ema(closes1m, 9);
    const rsi5m = rsi(closes5m, 14);
    const atrVal = atr(bars5m, 14);

    console.log(`${symbol}: $${price.toFixed(2)} | VWAP: $${vwap5m?.toFixed(2)} | EMA9: $${ema9?.toFixed(2)} | RSI: ${rsi5m.toFixed(1)}`);

    // S/R
    const sr = await calculateSupportResistance(symbol);
    console.log(`${symbol} S/R: PMH=${sr.pmh?.toFixed(2)} PML=${sr.pml?.toFixed(2)} PDC=${sr.pdc?.toFixed(2)} PDH=${sr.pdh?.toFixed(2)} PDL=${sr.pdl?.toFixed(2)}`);

    // Analyze
    const indicators = { price, bars1m: todayBars1m, bars5m: todayBars5m, vwap5m, ema9, rsi5m, atrVal, vix };
    const result = await analyzeStrategy(window, sr, indicators);
    console.log(`${symbol}: ${result.signal} | ${result.reason}`);

    if (result.signal === "NEUTRAL") continue;

    // ENTRY
    const cfg = TICKER_CONFIG[symbol] || { strikeStep: 1, sizeFactor: 1.0 };
    const atmStrike = Math.round(price);
    const contract = await pickOptionContract(symbol, result.signal, atmStrike);
    if (!contract) {
      console.log(`${symbol}: no suitable option contract`);
      continue;
    }

    const premium = await getOptionQuote(contract.symbol);
    if (!premium || premium < 0.10) {
      console.log(`${symbol}: premium too low (${premium})`);
      continue;
    }

    const baseQty = calculateQty(portfolio, premium, window.riskPct, window.stopPct);
    const tickerQty = Math.max(1, Math.floor(baseQty * cfg.sizeFactor));
    // V17.5: Force even quantity so Partial Sell (50%) works correctly
    // If qty is odd (e.g. 5), round down to nearest even (4) so 50% sell = exactly 2
    const qty = tickerQty >= 2 ? Math.max(2, tickerQty - (tickerQty % 2)) : 1;

    console.log(`${symbol}: Entering ${contract.symbol} qty ${qty} @ $${premium.toFixed(2)}`);

    try {
      const order = await placeOptionOrder(contract.symbol, qty, "buy");
      const stopPrice = premium * (1 - window.stopPct / 100);
      let stopOrderId = null;
      try {
        const stopOrder = await placeStopLossOrder(contract.symbol, qty, stopPrice);
        stopOrderId = stopOrder.id;
      } catch (e) {
        console.error(`${symbol}: stop loss order failed: ${e.message}`);
      }

      const msg = `✅ <b>BUY ${symbol} ${result.signal} $${contract.strike_price} 0DTE</b>
💰 Entry: $${premium.toFixed(2)} × ${qty}
🎯 Target: +${window.targetPct}% ($${(premium * (1 + window.targetPct / 100)).toFixed(2)})
🛑 Stop: -${window.stopPct}% ($${stopPrice.toFixed(2)})
🪟 Window: ${window.name}
📍 ${result.reason}`;
      const msgId = await sendTelegram(msg);

      state[symbol] = {
        active: true,
        signal: result.signal,
        window: window.name,
        optionSymbol: contract.symbol,
        strike: contract.strike_price,
        entryPremium: premium,
        qty,
        entryTime: Date.now(),
        orderId: order.id,
        stopOrderId,
        currentStop: stopPrice,
        peakPremium: premium,
        targetPct: window.targetPct,
        stopPct: window.stopPct,
        timeExitMin: window.timeExitMin,
        entryMessageId: msgId,
        reason: result.reason,
        partial1Done: false,
        bePromoted: false,
        partial2Done: false,
        trailing: false,
        remainingQty: qty,
        quickExitWindow: true,
      };
      state._dailyTrades_count = (state._dailyTrades_count || 0) + 1;
      saveState(state);

      // Break after 1 entry per scan (avoid burst entries)
      break;
    } catch (e) {
      console.error(`${symbol}: entry failed: ${e.message}`);
    }
  }

  saveState(state);
}

// ============================================================
// MONITOR MODE: Process active position
// ============================================================
async function processActivePosition(state, account, symbol) {
  const pos = state[symbol];
  if (!pos || !pos.active) return;

  // Force exit time
  if (isPastForceExit()) {
    console.log(`${symbol}: Past force exit time, closing position`);
    await exitPosition(state, pos, symbol, "force_exit", "إغلاق إجباري (2:58 PM)");
    return;
  }

  // Get current premium
  const alpacaPos = await getPosition(pos.optionSymbol);
  if (!alpacaPos) {
    console.log(`${symbol}: Position closed in Alpaca - recording exit`);
    // V17.3: When Alpaca closes position (stop hit, etc), still record trade and notify
    await exitPosition(state, pos, symbol, "stop_hit", "Stop ضرب (Alpaca)");
    return;
  }

  const currentPremium = parseFloat(alpacaPos.current_price);
  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium * 100;
  const elapsedMin = (Date.now() - pos.entryTime) / 60000;

  console.log(`${symbol}: Premium $${currentPremium.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%), Elapsed ${elapsedMin.toFixed(1)} min`);

  // Update peak
  if (currentPremium > pos.peakPremium) {
    pos.peakPremium = currentPremium;
  }

  // V17.5: SOFTWARE STOP LOSS - Faster + Danger Zone
  // Triggers stop earlier if price approaches stop level (within 5%)
  // This protects against slippage where actual fill is worse than stop price
  const dangerZone = pos.currentStop * 1.05; // 5% above stop = warning zone
  if (currentPremium <= pos.currentStop) {
    console.log(`${symbol}: Software stop triggered: $${currentPremium.toFixed(2)} <= $${pos.currentStop.toFixed(2)}`);
    await exitPosition(state, pos, symbol, "stop_hit", `وقف الخسارة (-${pos.stopPct}%)`);
    return;
  }
  // Pre-emptive exit if in danger zone AND price is falling fast
  if (currentPremium <= dangerZone && pos.lastPremium && currentPremium < pos.lastPremium * 0.95) {
    console.log(`${symbol}: Danger zone exit - price dropping fast near stop`);
    await exitPosition(state, pos, symbol, "stop_hit", `وقف الخسارة (هبوط سريع)`);
    return;
  }
  pos.lastPremium = currentPremium;

  // ===========================================
  // LAYER 2: TRADE MANAGEMENT
  // ===========================================

  // Quick Exit: -30% in first minute
  if (pos.quickExitWindow && elapsedMin <= 1 && pnlPct <= -QUICK_EXIT_PCT) {
    console.log(`${symbol}: Quick exit triggered: ${pnlPct.toFixed(1)}% in ${elapsedMin.toFixed(1)} min`);
    await exitPosition(state, pos, symbol, "quick_exit", "خروج سريع (دقيقة 1)");
    return;
  }

  // Disable quick exit window after 1 minute
  if (elapsedMin > 1 && pos.quickExitWindow) {
    pos.quickExitWindow = false;
  }

  // Profit Partial 1: +30% → sell 50%
  if (!pos.partial1Done && pnlPct >= PROFIT_PARTIAL_1) {
    const sellQty = Math.floor(pos.remainingQty / 2);
    if (sellQty >= 1) {
      console.log(`${symbol}: Profit partial 1 (+30%): selling ${sellQty} of ${pos.remainingQty}`);
      try {
        // V17.6: Cancel stop order first to free up contracts for sale
        if (pos.stopOrderId) {
          try { await cancelOrder(pos.stopOrderId); } catch (e) { /* ignore */ }
          pos.stopOrderId = null;
        }
        // Sell partial using POST orders (works for long calls/puts)
        await closePosition(pos.optionSymbol, sellQty);
        pos.remainingQty -= sellQty;
        pos.partial1Done = true;
        // Re-place stop order for remaining quantity
        if (pos.remainingQty > 0) {
          try {
            const newStop = await placeStopLossOrder(pos.optionSymbol, pos.remainingQty, pos.currentStop);
            pos.stopOrderId = newStop.id;
          } catch (e) {
            console.error(`${symbol}: re-stop failed: ${e.message}`);
          }
        }
        await sendTelegram(`💰 <b>${symbol}</b> +30% Partial Profit
بعنا ${sellQty} عقود (نص الصفقة)
السعر: $${currentPremium.toFixed(2)}
الباقي: ${pos.remainingQty} عقود`, null, pos.entryMessageId);
      } catch (e) {
        console.error(`${symbol}: partial sell failed: ${e.message}`);
      }
    }
  }

  // Profit BE Stop: +50% → move stop to entry
  if (!pos.bePromoted && pnlPct >= PROFIT_BE_PCT) {
    console.log(`${symbol}: Promoting to BE stop`);
    try {
      if (pos.stopOrderId) await cancelOrder(pos.stopOrderId);
      const newStop = await placeStopLossOrder(pos.optionSymbol, pos.remainingQty, pos.entryPremium);
      pos.stopOrderId = newStop.id;
      pos.currentStop = pos.entryPremium;
      pos.bePromoted = true;
      await sendTelegram(`🛡 <b>${symbol}</b> +50% Break-Even Activated
Stop → $${pos.entryPremium.toFixed(2)} (entry)
P&L: +${pnlPct.toFixed(1)}%`, null, pos.entryMessageId);
    } catch (e) {
      console.error(`${symbol}: BE promotion failed: ${e.message}`);
    }
  }

  // Profit Partial 2: +75%
  if (pos.partial1Done && !pos.partial2Done && pnlPct >= PROFIT_PARTIAL_2) {
    const sellQty = Math.max(1, Math.floor(pos.remainingQty / 2));
    if (sellQty < pos.remainingQty) {
      console.log(`${symbol}: Profit partial 2 (+75%): selling ${sellQty}`);
      try {
        // V17.6: Cancel stop before partial sell
        if (pos.stopOrderId) {
          try { await cancelOrder(pos.stopOrderId); } catch (e) { /* ignore */ }
          pos.stopOrderId = null;
        }
        await closePosition(pos.optionSymbol, sellQty);
        pos.remainingQty -= sellQty;
        pos.partial2Done = true;
        // Re-place stop for remaining
        if (pos.remainingQty > 0) {
          try {
            const newStop = await placeStopLossOrder(pos.optionSymbol, pos.remainingQty, pos.currentStop);
            pos.stopOrderId = newStop.id;
          } catch (e) {
            console.error(`${symbol}: re-stop after partial 2 failed: ${e.message}`);
          }
        }
        await sendTelegram(`💰 <b>${symbol}</b> +75% Partial Profit
بعنا ${sellQty} إضافية
الباقي: ${pos.remainingQty} للتريلينج`, null, pos.entryMessageId);
      } catch (e) {
        console.error(`${symbol}: partial 2 sell failed: ${e.message}`);
      }
    }
  }

  // Trailing at +100%
  if (pnlPct >= PROFIT_TRAIL_PCT && !pos.trailing) {
    pos.trailing = true;
    console.log(`${symbol}: Trailing stop activated`);
  }
  if (pos.trailing) {
    const trailStop = pos.peakPremium * 0.85;
    if (trailStop > pos.currentStop) {
      try {
        if (pos.stopOrderId) await cancelOrder(pos.stopOrderId);
        const newStop = await placeStopLossOrder(pos.optionSymbol, pos.remainingQty, trailStop);
        pos.stopOrderId = newStop.id;
        pos.currentStop = trailStop;
        console.log(`${symbol}: Trailing stop updated to $${trailStop.toFixed(2)}`);
      } catch (e) {
        console.error(`${symbol}: trail update failed: ${e.message}`);
      }
    }
  }

  // Time exit
  if (elapsedMin >= pos.timeExitMin) {
    console.log(`${symbol}: Time exit triggered (${elapsedMin.toFixed(1)} min >= ${pos.timeExitMin})`);
    await exitPosition(state, pos, symbol, "time_exit", `خروج وقتي (${pos.timeExitMin} دقيقة)`);
    return;
  }

  state[symbol] = pos;
}

async function exitPosition(state, pos, symbol, reason, reasonAr) {
  try {
    if (pos.stopOrderId) {
      await cancelOrder(pos.stopOrderId);
    }
    if (pos.remainingQty > 0) {
      await closePosition(pos.optionSymbol);
    }
  } catch (e) {
    console.error(`${symbol}: exit close failed: ${e.message}`);
  }

  const exitPremium = await getOptionQuote(pos.optionSymbol) || pos.currentStop || pos.entryPremium * 0.7;
  const pnl = (exitPremium - pos.entryPremium) * pos.qty * 100;
  const pnlPct = (exitPremium - pos.entryPremium) / pos.entryPremium * 100;
  const minutes = Math.round((Date.now() - pos.entryTime) / 60000);

  state._dailyTrades = state._dailyTrades || [];
  state._dailyTrades.push({
    symbol,
    signal: pos.signal,
    window: pos.window,
    entryPremium: pos.entryPremium,
    exitPremium,
    qty: pos.qty,
    pnl,
    pnlPct,
    reason,
    minutes,
    entryTime: pos.entryTime,
    exitTime: Date.now(),
    strike: pos.strike,
    setup: pos.reason,
  });

  if (pnl < 0) {
    state._dailyLosses = (state._dailyLosses || 0) + Math.abs(pnl);
    state._consecLosses = (state._consecLosses || 0) + 1;
  } else {
    state._consecLosses = 0;
  }

  const icon = pnl > 0 ? "✅" : pnl < 0 ? "🛑" : "⏸";
  await sendTelegram(`${icon} <b>EXIT ${symbol}</b> (${reasonAr})
💰 $${pos.entryPremium.toFixed(2)} → $${exitPremium.toFixed(2)}
📊 ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)})
⏱ ${minutes} دقيقة | 🪟 ${pos.window}`, null, pos.entryMessageId);

  state[symbol] = {
    active: false,
    cooldownUntil: Date.now() + 10 * 60 * 1000,
    lastSignal: pos.signal,
  };
}

// ============================================================
// DAILY REPORT
// ============================================================
async function sendDailyReport(state, portfolio) {
  if (state._reportSent) return;
  if (!isReportTime()) return;

  // V17.5: Skip on weekends (market closed)
  const dayOfWeek = new Date().getUTCDay(); // 0=Sunday, 6=Saturday
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    state._reportSent = true; // mark as sent to skip
    return;
  }

  const trades = state._dailyTrades || [];

  // V17.5: Skip if no trades today
  if (trades.length === 0) {
    state._reportSent = true;
    console.log("Daily report skipped: no trades today");
    return;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const breakevens = trades.filter(t => t.pnl === 0);
  const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const net = totalProfit + totalLoss;
  const wr = trades.length > 0 ? (wins.length / trades.length * 100) : 0;

  // V17.5: Fetch REAL PnL from Alpaca portfolio history (truth source)
  let realDailyPnL = null;
  let realPortfolio = portfolio;
  try {
    const account = await getAccount();
    realPortfolio = parseFloat(account.portfolio_value);
    const lastEquity = parseFloat(account.last_equity || account.equity || portfolio);
    realDailyPnL = realPortfolio - lastEquity;
  } catch (e) {
    console.error("Could not fetch Alpaca real PnL:", e.message);
  }

  const best = trades.length > 0 ? trades.reduce((a, b) => a.pnlPct > b.pnlPct ? a : b) : null;
  const worst = trades.length > 0 ? trades.reduce((a, b) => a.pnlPct < b.pnlPct ? a : b) : null;

  const dateStr = new Date().toDateString();
  let msg = `📊 <b>Daily Report - ${dateStr}</b>

💼 الصفقات: ${trades.length}
✅ ربحانة: ${wins.length} (${wr.toFixed(1)}%)
❌ خسرانة: ${losses.length}
⏸ تعادل: ${breakevens.length}

💰 ربح (تقدير): +$${totalProfit.toFixed(0)}
💸 خسارة (تقدير): $${totalLoss.toFixed(0)}
📊 صافي (تقدير): ${net >= 0 ? "+" : ""}$${net.toFixed(0)}`;

  // V17.5: Show ACTUAL Alpaca PnL if available
  if (realDailyPnL !== null) {
    msg += `\n\n💎 <b>الواقع من Alpaca:</b>
${realDailyPnL >= 0 ? "✅ +" : "❌ "}$${realDailyPnL.toFixed(0)} (${(realDailyPnL/realPortfolio*100).toFixed(2)}%)`;
  }

  if (best) msg += `\n\n🥇 أفضل: ${best.signal} ${best.pnlPct >= 0 ? "+" : ""}${best.pnlPct.toFixed(1)}% (${best.window})`;
  if (worst) msg += `\n🥉 أسوأ: ${worst.signal} ${worst.pnlPct.toFixed(1)}% (${worst.window})`;

  msg += `\n\n📈 الرصيد: $${realPortfolio.toFixed(0)}`;

  await sendTelegram(msg);
  state._reportSent = true;
}

// ============================================================
// MODE DISPATCH
// ============================================================
const mode = process.env.MODE || "scan";

(async () => {
  try {
    if (mode === "monitor") {
      const state = loadState();
      const account = await getAccount();
      let hasActive = false;
      for (const symbol of TICKERS) {
        if (state[symbol]?.active) {
          hasActive = true;
          await processActivePosition(state, account, symbol);
        }
      }
      if (!hasActive) {
        console.log("No active positions to monitor");
      }
      saveState(state);
      // Also check daily report
      if (isReportTime() && !state._reportSent) {
        await sendDailyReport(state, parseFloat(account.portfolio_value));
        saveState(state);
      }
    } else {
      await runScan();
      // Send report if time
      const state = loadState();
      const account = await getAccount();
      if (isReportTime() && !state._reportSent) {
        await sendDailyReport(state, parseFloat(account.portfolio_value));
        saveState(state);
      }
    }
  } catch (e) {
    console.error("Fatal error:", e.message);
    process.exit(1);
  }
})();
