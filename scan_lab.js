// ============================================================
// BOT LAB — SELF-TUNING MOMENTUM/BREAKOUT STRATEGY (experimental)
// Uses ALPACA_KEY_3 / ALPACA_SECRET_3 (separate paper account, $10k)
// Independent of v21 — does not read/write any v21 file.
//
// Strategy (initial, see strategy_lab.json for live params):
//   1. Trend regime from EMA(fast) vs EMA(slow) on 15-min bars.
//   2. Entry: last closed bar breaks the prior N-bar high/low in the
//      direction of the regime, confirmed by a volume surge.
//   3. Exit: hard stop, 2-tier profit ladder + trailing stop,
//      regime flip (trend invalidated), force exit, daily loss breaker.
//   4. Once/day after close, a bounded rule-based tuner may adjust ONE
//      strategy_lab.json param if the cumulative sample supports it
//      (never touches this file's logic, never exceeds PARAM_BOUNDS).
//
// Hard safety limits below are fixed constants — the self-tuner can
// only ever modify strategy_lab.json params, and every param is
// clamped against PARAM_BOUNDS on load and after any adjustment.
// ============================================================
import fs from "fs";

const ALPACA_KEY    = process.env.ALPACA_KEY_3;
const ALPACA_SECRET = process.env.ALPACA_SECRET_3;
const TG_TOKEN       = process.env.TG_TOKEN;
const PERSONAL_CHAT  = "810642442";
const MODE           = process.env.MODE || "scan";
const TRADING_BASE   = "https://paper-api.alpaca.markets/v2";
const DATA_BASE      = "https://data.alpaca.markets/v2";
const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type": "application/json",
};

// Every network call in this file goes through here — a stalled
// connection (no response, no error) used to hang this process
// forever, which hung the whole Railway runner loop since it just
// awaits this child process's exit. 15s is generous for these APIs;
// on timeout the fetch simply rejects like any other network error,
// so existing try/catch blocks handle it exactly as before.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── HARD SAFETY LIMITS (fixed — never modified by self-tuning) ────
const ALLOWED_TICKERS    = ["SPY", "QQQ", "IWM", "NVDA", "TSLA", "AMZN"];
const MAX_DAILY_LOSS     = 1000;  // $ — halts new entries + flattens open positions
const MAX_TRADE_BUDGET   = 1000;  // $ per trade, hard ceiling
const MAX_OPEN_POSITIONS = 3;
const MAX_DTE            = 2;     // days — never trade an expiry further out
const MARKET_OPEN_UTC    = 13 * 60 + 30; // 8:30 AM CDT
const MARKET_CLOSE_UTC   = 20 * 60 + 30; // 3:30 PM CDT
const FORCE_EXIT_UTC     = 19 * 60 + 55; // 2:55 PM CDT
const LAST_ENTRY_UTC     = FORCE_EXIT_UTC - 25; // 2:30 PM CDT

// Bounds the daily self-tuner may adjust learnable params within —
// separate guardrail from the hard limits above, prevents drift.
const PARAM_BOUNDS = {
  emaFast:             [5, 15],
  emaSlow:             [15, 40],
  breakoutLookback:    [5, 20],
  volAvgLookback:      [10, 30],
  volumeMultiplier:    [1.1, 2.0],
  tradeBudget:         [100, MAX_TRADE_BUDGET],
  stopLossPct:         [-40, -15],
  takeProfit1Pct:      [8, 25],
  takeProfit1LockPct:  [2, 10],
  takeProfit2Pct:      [15, 40],
  takeProfit2LockPct:  [5, 20],
  trailingPct:         [5, 15],
};
const MIN_SAMPLE_FOR_LEARNING = 20;   // cumulative closed trades required before any tuning
const MAX_PARAM_STEP_FRACTION = 0.15; // one daily change moves a param by at most 15% of its value

const DEFAULT_STRATEGY = {
  version: 1,
  name: "momentum_breakout_ema",
  description: "EMA fast/slow trend regime + rolling N-bar breakout with volume confirmation, on 15-min bars.",
  params: {
    emaFast: 9, emaSlow: 21, breakoutLookback: 10, volAvgLookback: 20,
    volumeMultiplier: 1.3, tradeBudget: 500, stopLossPct: -30,
    takeProfit1Pct: 15, takeProfit1LockPct: 5, takeProfit2Pct: 25,
    takeProfit2LockPct: 12, trailingPct: 8,
  },
  changelog: [],
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function utcMin() { const n = new Date(); return n.getUTCHours() * 60 + n.getUTCMinutes(); }
function isMarketOpen()   { const m = utcMin(); return m >= MARKET_OPEN_UTC && m < MARKET_CLOSE_UTC; }
function isPastLastEntry(){ return utcMin() >= LAST_ENTRY_UTC; }
function isForceExit()    { return utcMin() >= FORCE_EXIT_UTC; }
function getToday() { return new Date().toISOString().split("T")[0]; }

function loadStrategy() {
  let s;
  try { s = JSON.parse(fs.readFileSync("strategy_lab.json", "utf8")); }
  catch { s = JSON.parse(JSON.stringify(DEFAULT_STRATEGY)); }
  if (!s.params) s.params = { ...DEFAULT_STRATEGY.params };
  if (!s.changelog) s.changelog = [];
  for (const k of Object.keys(PARAM_BOUNDS)) {
    if (typeof s.params[k] !== "number") s.params[k] = DEFAULT_STRATEGY.params[k];
    s.params[k] = clamp(s.params[k], PARAM_BOUNDS[k][0], PARAM_BOUNDS[k][1]);
  }
  s.params.tradeBudget = Math.min(s.params.tradeBudget, MAX_TRADE_BUDGET);
  return s;
}
function saveStrategy(s) { fs.writeFileSync("strategy_lab.json", JSON.stringify(s, null, 2)); }

function loadState() {
  try { return JSON.parse(fs.readFileSync("state_lab.json", "utf8")); }
  catch { return {}; }
}
function saveState(s) { fs.writeFileSync("state_lab.json", JSON.stringify(s, null, 2)); }

async function tg(text, replyTo = null) {
  try {
    const body = { chat_id: PERSONAL_CHAT, text: `🧪 LAB: ${text}`, parse_mode: "HTML" };
    if (replyTo) { body.reply_to_message_id = replyTo; body.allow_sending_without_reply = true; }
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const d = await res.json();
    return d.result?.message_id || null;
  } catch (e) { console.error("TG:", e.message); return null; }
}

async function alpaca(path, method = "GET", body = null) {
  const res = await fetchWithTimeout(`${TRADING_BASE}${path}`, {
    method, headers: HEADERS, body: body ? JSON.stringify(body) : null
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
}

// Alpaca's actual open position is the source of truth for how many
// contracts we're allowed to sell — never local state, which can be
// stale or wrong (e.g. lost across a Railway restart before git push
// persistence was fixed). Returns:
//   > 0  → that many contracts held long, safe to sell up to this amount
//   0    → no position at Alpaca (already flat / never really opened)
//   null → couldn't determine (network/parse error) — caller must NOT
//          fall back to local state and must NOT place any sell order
async function getOwnedQty(optionSymbol) {
  try {
    const d = await alpaca(`/positions/${optionSymbol}`);
    if (d && typeof d.qty !== "undefined") {
      const qty = parseFloat(d.qty);
      return Number.isFinite(qty) && qty > 0 ? qty : 0;
    }
    if (d && d.code === 40410000) return 0; // "position does not exist"
    console.error(`getOwnedQty(${optionSymbol}): unexpected response`, d);
    return null;
  } catch (e) {
    console.error(`getOwnedQty(${optionSymbol}) failed:`, e.message);
    return null;
  }
}

async function getBars(symbol, tf = "15Min", daysBack = 5) {
  try {
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&limit=300&adjustment=raw`;
    const res = await fetchWithTimeout(url, { headers: HEADERS });
    const text = await res.text();
    try { return JSON.parse(text).bars || []; }
    catch { console.error(`${symbol} getBars parse error:`, text.slice(0, 100)); return []; }
  } catch (e) { console.error(`${symbol} getBars error:`, e.message); return []; }
}

async function getLatestPrice(symbol) {
  try {
    const r = await fetchWithTimeout(`${DATA_BASE}/stocks/${symbol}/quotes/latest`, { headers: HEADERS });
    const d = await r.json();
    return d.quote ? (d.quote.ap + d.quote.bp) / 2 : null;
  } catch { return null; }
}

async function getQuote(optSym) {
  try {
    const res = await fetchWithTimeout(`https://data.alpaca.markets/v1beta1/options/quotes/latest?symbols=${optSym}`, { headers: HEADERS });
    const d = await res.json();
    const q = d.quotes?.[optSym];
    return q ? (q.ap + q.bp) / 2 : null;
  } catch { return null; }
}

// ─── NEAREST EXPIRY WITHIN MAX_DTE (hard cap, not learnable) ───────
async function getNearExpiry(symbol) {
  try {
    const today = getToday();
    const maxDate = new Date(Date.now() + MAX_DTE * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date_gte=${today}&expiration_date_lte=${maxDate}&status=active&limit=50&type=call`;
    const res = await fetchWithTimeout(url, { headers: HEADERS });
    const d = await res.json();
    const dates = [...new Set((d?.option_contracts || []).map(c => c.expiration_date))].sort();
    return dates[0] || null;
  } catch (e) { console.error(`${symbol} getNearExpiry error:`, e.message); return null; }
}

async function findOption(symbol, signal, spotPrice) {
  const expiry = await getNearExpiry(symbol);
  if (!expiry) return null;
  const type = signal === "CALL" ? "call" : "put";
  for (const delta of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
    const strike = Math.round(spotPrice) + delta;
    try {
      const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date=${expiry}&type=${type}&strike_price_gte=${strike-0.5}&strike_price_lte=${strike+0.5}&status=active&limit=5`;
      const res = await fetchWithTimeout(url, { headers: HEADERS });
      const d = await res.json();
      const contracts = d?.option_contracts || [];
      if (!contracts.length) continue;
      const contract = contracts.sort((a, b) => Math.abs(a.strike_price - spotPrice) - Math.abs(b.strike_price - spotPrice))[0];
      const premium = await getQuote(contract.symbol);
      if (premium && premium > 0.05) return { symbol: contract.symbol, strike: contract.strike_price, premium, expiry };
    } catch (e) { console.log(`  strike ${strike}: ${e.message}`); }
  }
  return null;
}

function calcQty(premium, tradeBudget) {
  const budget = Math.min(tradeBudget, MAX_TRADE_BUDGET);
  return Math.max(1, Math.floor(budget / (premium * 100)));
}

// ─── ENTRY-SNAPSHOT INDICATORS (VWAP + RSI, for later analysis only) ──
// Computed from bars already fetched for computeSignal() — no extra
// network call. Never used in any entry/exit decision; purely recorded
// on the trade for the weekly deep-dive analysis planned later (e.g.
// price-vs-VWAP trend filter, RSI context).
//
// Session VWAP: cumulative (typical price × volume) over TODAY's bars
// only, up to and including the last CLOSED bar (mirrors how
// computeSignal already treats "the last closed bar" as the decision
// point).
function computeVWAP(bars) {
  const today = getToday();
  const todayBars = bars.filter(b => new Date(b.t).toISOString().split("T")[0] === today);
  if (!todayBars.length) return null;
  const closedTodayBars = todayBars.length > 1 ? todayBars.slice(0, -1) : todayBars;
  let cumPV = 0, cumV = 0;
  for (const b of closedTodayBars) {
    cumPV += (b.h + b.l + b.c) / 3 * b.v;
    cumV += b.v;
  }
  return cumV > 0 ? +(cumPV / cumV).toFixed(4) : null;
}

// RSI(14), Wilder smoothing, over the full multi-day closes series
// (not reset daily — a daily reset would leave too few bars early in
// the session). Ends at the last CLOSED bar, same convention as above.
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

// ─── INDICATORS ──────────────────────────────────────────────
function computeEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// ─── SIGNAL: EMA REGIME + ROLLING BREAKOUT + VOLUME ─────────────
function computeSignal(bars, params) {
  const minBars = params.emaSlow + Math.max(params.breakoutLookback, params.volAvgLookback) + 2;
  if (bars.length < minBars) return null;

  const closedBars = bars.slice(0, -1); // drop the currently-forming bar
  if (closedBars.length < minBars - 1) return null;
  const lastClosed = closedBars[closedBars.length - 1];

  const closes = closedBars.map(b => b.c);
  const emaFast = computeEMA(closes, params.emaFast);
  const emaSlow = computeEMA(closes, params.emaSlow);
  if (emaFast === null || emaSlow === null) return null;

  const priorBars = closedBars.slice(0, -1); // bars before the last closed bar
  const breakoutWindow = priorBars.slice(-params.breakoutLookback);
  const volWindow = priorBars.slice(-params.volAvgLookback);
  if (breakoutWindow.length < params.breakoutLookback || volWindow.length < params.volAvgLookback) return null;

  const breakoutHigh = Math.max(...breakoutWindow.map(b => b.h));
  const breakoutLow  = Math.min(...breakoutWindow.map(b => b.l));
  const avgVol = volWindow.reduce((a, b) => a + b.v, 0) / volWindow.length;
  const volRatio = avgVol > 0 ? lastClosed.v / avgVol : 0;
  const volumeOk = volRatio >= params.volumeMultiplier;

  const regime = emaFast > emaSlow ? "bullish" : emaFast < emaSlow ? "bearish" : "flat";

  let signal = null;
  if (regime === "bullish" && lastClosed.c > breakoutHigh && volumeOk) signal = "CALL";
  if (regime === "bearish" && lastClosed.c < breakoutLow && volumeOk) signal = "PUT";

  return { signal, regime, emaFast, emaSlow, breakoutHigh, breakoutLow, volRatio, lastClose: lastClosed.c, lastVolume: lastClosed.v, barTime: lastClosed.t };
}

function computeRegime(bars, params) {
  const closedBars = bars.slice(0, -1);
  const closes = closedBars.map(b => b.c);
  const emaFast = computeEMA(closes, params.emaFast);
  const emaSlow = computeEMA(closes, params.emaSlow);
  if (emaFast === null || emaSlow === null) return null;
  return emaFast > emaSlow ? "bullish" : emaFast < emaSlow ? "bearish" : "flat";
}

// ─── DAILY REALIZED P&L / OPEN POSITION COUNT ───────────────────
function getTodayRealizedPnl() {
  const today = getToday();
  let total = 0;
  try {
    const lines = fs.readFileSync("outcomes_lab.jsonl", "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { const r = JSON.parse(line); if (r.day === today) total += r.pnl; } catch {}
    }
  } catch {}
  return total;
}
function countOpenPositions(state) {
  return ALLOWED_TICKERS.filter(sym => state[sym]?.active).length;
}

// ─── LOG TRADE OUTCOME (with entry-condition snapshot) ──────────
// exitStockPrice is optional (undefined for any call site that doesn't
// have it) — falls back to null so old-style callers never break.
function logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice) {
  try {
    const tradeId = `${symbol}_${pos.entryTime}`;
    let existing = "";
    try { existing = fs.readFileSync("outcomes_lab.jsonl", "utf8"); } catch {}
    if (existing.includes(`"tradeId":"${tradeId}"`)) {
      console.log(`logTrade: skipped duplicate ${tradeId}`);
      return false;
    }
    const pnlPct = (exitPremium - pos.entryPremium) / pos.entryPremium * 100;
    const pnl = Math.round((exitPremium - pos.entryPremium) * pos.qty * 100);
    const record = {
      day: getToday(), symbol, signal: pos.signal, optionSymbol: pos.optionSymbol, strike: pos.strike,
      tradeId, entryPremium: pos.entryPremium, exitPremium: +exitPremium.toFixed(2), qty: pos.qty,
      pnl, pnlPct: +pnlPct.toFixed(1), win: pnl > 0, reason, fillSource,
      entryTime: new Date(pos.entryTime).toISOString(), exitTime: new Date().toISOString(),
      entryConditions: pos.entryConditions || null,
      strategyVersion: pos.strategyVersion || null,
      // Exit-snapshot indicator, for the weekly deep-dive analysis —
      // null on any trade closed before this field existed.
      exitStockPrice: exitStockPrice ?? null,
    };
    fs.appendFileSync("outcomes_lab.jsonl", JSON.stringify(record) + "\n");
    console.log(`logged: ${symbol} ${pos.signal} ${pnlPct.toFixed(1)}% (${reason})`);
    return true;
  } catch (e) { console.error("logTrade failed:", e.message); return false; }
}

function closeMessageText(reason, symbol, pos, pnlPct, pnl) {
  const sign = pnl >= 0 ? "+" : "";
  const tail = `${pnlPct.toFixed(1)}% | ${sign}$${pnl}`;
  switch (reason) {
    case "force_exit":         return `🔔 <b>خروج إجباري ${symbol}</b>\n${pos.signal} | ${tail}`;
    case "hard_stop":          return `🛑 <b>وقف خسارة ${symbol}</b>\n${tail}`;
    case "ladder_stop":        return `💰 <b>وقف ربح ${symbol}</b>\n${tail}`;
    case "regime_flip":        return `🔄 <b>${symbol} انعكاس الاتجاه</b>\n${tail}`;
    case "daily_loss_breaker": return `🚨 <b>${symbol} إغلاق طارئ — تجاوز حد الخسارة اليومي</b>\n${tail}`;
    case "alpaca_stop":
    case "alpaca_stop_est":    return `🛑 <b>${symbol} أُقفلت (Alpaca)</b>\n${tail}`;
    default:                   return `${symbol} أُغلقت (${reason})\n${tail}`;
  }
}

// ─── UNIFIED POSITION CLOSE ──────────────────────────────────
async function closePosition(state, symbol, pos, exitPremium, reason, fillSource, skipSell = false) {
  // One extra lightweight quote fetch here — only when a position is
  // actually closing, not every monitor cycle — same call already used
  // once per trade at entry (getLatestPrice). Recorded for later
  // analysis only; getLatestPrice already returns null on failure, so
  // this never blocks or fails the actual close below.
  const exitStockPrice = await getLatestPrice(symbol);
  let soldQty = pos.qty;
  if (!skipSell) {
    // Never trust local state's qty for how much to sell — verify against
    // Alpaca first. This is the fix for the AMZN incident: a stale/lost
    // local qty led to a sell order for more contracts than were actually
    // held, flipping a long option position into an unintended short.
    //
    // Checked BEFORE touching the existing protective stop order, on
    // purpose: that stop order is the last line of defense for exactly
    // the moment this check can't reach Alpaca (persistent network
    // failure) — cancelling it before confirming a replacement can be
    // placed would strip the position's only protection at the worst
    // possible time. On `null`, leave it completely alone and retry
    // next cycle.
    const ownedQty = await getOwnedQty(pos.optionSymbol);

    if (ownedQty === null) {
      console.error(`${symbol}: could not verify owned qty at Alpaca — leaving existing stop order in place, skipping sell this cycle (${reason})`);
      await tg(`⚠️ <b>${symbol}: تعذّر التحقق من الكمية في Alpaca</b>\nلم يُرسل أمر بيع (${reason})، ووقف الخسارة الحالي في Alpaca بقي كما هو دون تعديل. ستتم إعادة المحاولة الدورة القادمة.`, pos.msgId);
      return;
    }

    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE").catch(() => {});

    if (ownedQty === 0) {
      console.warn(`${symbol}: no position at Alpaca (already flat) — clearing local state without selling (${reason})`);
      await tg(`ℹ️ <b>${symbol}: لا يوجد مركز فعلي في Alpaca</b>\nتم تنظيف الحالة المحلية بدون إرسال أمر بيع (${reason}).`, pos.msgId);
      logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice);
      delete state[symbol];
      saveState(state);
      return;
    }

    if (pos.qty > ownedQty) {
      console.warn(`${symbol}: requested sell qty ${pos.qty} > owned ${ownedQty} — selling owned qty only (${reason})`);
      await tg(`⚠️ <b>${symbol}: فرق في الكمية</b>\nالمطلوب بيعه ${pos.qty} لكن المملوك فعلياً في Alpaca ${ownedQty} — تم بيع ${ownedQty} فقط.`, pos.msgId);
      soldQty = ownedQty;
    }

    const order = await alpaca("/orders", "POST", {
      symbol: pos.optionSymbol, qty: String(soldQty), side: "sell",
      type: "market", time_in_force: "day"
    });
    if (!order.id) {
      console.error(`${symbol}: close sell order failed (${reason}):`, order);
      await tg(`⚠️ <b>فشل إغلاق ${symbol}</b>\nأمر البيع لم يُنفَّذ (${reason}) — يحتاج تدخلاً يدوياً.`, pos.msgId);
      return;
    }
  }
  const pnl = Math.round((exitPremium - pos.entryPremium) * soldQty * 100);
  const pnlPct = (exitPremium - pos.entryPremium) / pos.entryPremium * 100;
  logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice);
  await tg(closeMessageText(reason, symbol, pos, pnlPct, pnl), pos.msgId);
  delete state[symbol];
  saveState(state);
}

// ─── PERIODIC UPDATE MESSAGE ─────────────────────────────────
function progressBar(pnlPct, maxPct = 100) {
  const filled = Math.max(0, Math.min(10, Math.round((pnlPct / maxPct) * 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function buildUpdateMsg(symbol, pos, pnlPct, currentPremium) {
  const bar = progressBar(pnlPct);
  const sign = pnlPct >= 0 ? "+" : "";
  const pnl = Math.round((currentPremium - pos.entryPremium) * pos.qty * 100);
  const elapsed = Math.round((Date.now() - pos.entryTime) / 60000);
  const emoji = pnlPct >= 20 ? "🚀" : pnlPct >= 10 ? "📈" : pnlPct >= 0 ? "🟢" : pnlPct >= -15 ? "🟡" : "🔴";
  const tp1 = pos.ladder1 ? "✅" : `+${pos.takeProfit1Pct}%`;
  const tp2 = pos.ladder2 ? "✅" : `+${pos.takeProfit2Pct}%`;
  return `${symbol} ${pos.signal} $${pos.strike} ${emoji}\n${bar} ${sign}${pnlPct.toFixed(1)}% | ${sign}$${pnl} | ${elapsed}m\nTP1 ${tp1} | TP2 ${tp2} | SL ${pos.stopLossPct}%\n$${currentPremium.toFixed(2)}/عقد`;
}

async function updateStopOrder(pos, newStopPrice) {
  try {
    // A stop order is a sell path too — it just executes later, when
    // triggered. Same guard as closePosition(), checked BEFORE touching
    // the existing stop order: if we can't verify the real position, the
    // current (older, wider) stop order must be left completely alone
    // rather than cancelled with no replacement — this call only runs
    // when a profit ladder already fired and flipped pos.ladder1/2 to
    // true, so a failure here means monitorPosition() won't retry this
    // specific tightening again; the ONLY thing still protecting the
    // position broker-side is whatever stop order is currently live.
    const ownedQty = await getOwnedQty(pos.optionSymbol);
    if (ownedQty === null) {
      console.error(`updateStopOrder(${pos.optionSymbol}): could not verify owned qty at Alpaca — leaving existing stop order in place`);
      return;
    }

    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE");

    if (ownedQty === 0) {
      console.warn(`updateStopOrder(${pos.optionSymbol}): no position at Alpaca — skipping stop update`);
      pos.stopOrderId = null;
      return;
    }
    let stopQty = pos.qty;
    if (stopQty > ownedQty) {
      console.warn(`updateStopOrder(${pos.optionSymbol}): requested qty ${stopQty} > owned ${ownedQty} — using owned qty`);
      await tg(`⚠️ <b>${pos.optionSymbol}: فرق كمية في أمر الوقف</b>\nالمطلوب ${stopQty} لكن المملوك ${ownedQty} — استُخدم ${ownedQty}.`, pos.msgId);
      stopQty = ownedQty;
    }

    const stopOrder = await alpaca("/orders", "POST", {
      symbol: pos.optionSymbol, qty: String(stopQty), side: "sell",
      type: "stop", time_in_force: "day", stop_price: String(Math.max(0.01, newStopPrice))
    });
    pos.stopOrderId = stopOrder.id || null;
  } catch (e) { console.error("updateStopOrder failed:", e.message); }
}

// ─── MONITOR OPEN POSITION ──────────────────────────────────
async function monitorPosition(state, strategy, symbol) {
  const pos = state[symbol];
  if (!pos?.active) return;

  const currentPremium = await getQuote(pos.optionSymbol);
  if (!currentPremium) return;
  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium * 100;

  // Daily loss circuit breaker — flatten immediately
  if (getTodayRealizedPnl() <= -MAX_DAILY_LOSS) {
    await closePosition(state, symbol, pos, currentPremium, "daily_loss_breaker", "order_fill");
    return;
  }

  if (isForceExit()) {
    await closePosition(state, symbol, pos, currentPremium, "force_exit", "order_fill");
    return;
  }

  if (pnlPct <= pos.stopLossPct) {
    await closePosition(state, symbol, pos, currentPremium, "hard_stop", "order_fill");
    return;
  }

  // Profit ladder
  let ladderJustFired = false;
  if (pnlPct >= pos.takeProfit2Pct && !pos.ladder2) {
    pos.ladder2 = true; pos.ladder1 = true;
    pos.stopPct = pos.takeProfit2LockPct; pos.trailPct = pos.trailingPct;
    pos.peakPct = Math.max(pos.peakPct || 0, pnlPct);
    const newStop = +(pos.entryPremium * (1 + pos.takeProfit2LockPct / 100)).toFixed(2);
    await updateStopOrder(pos, newStop);
    await tg(`${symbol} مستوى 2: +${pnlPct.toFixed(1)}% | وقف +${pos.takeProfit2LockPct}% + تريلينق ${pos.trailingPct}%`, pos.msgId);
    ladderJustFired = true;
  }
  if (pnlPct >= pos.takeProfit1Pct && !pos.ladder1) {
    pos.ladder1 = true; pos.stopPct = pos.takeProfit1LockPct;
    pos.peakPct = Math.max(pos.peakPct || 0, pnlPct);
    const newStop = +(pos.entryPremium * (1 + pos.takeProfit1LockPct / 100)).toFixed(2);
    await updateStopOrder(pos, newStop);
    await tg(`${symbol} مستوى 1: +${pnlPct.toFixed(1)}% | وقف +${pos.takeProfit1LockPct}%`, pos.msgId);
    ladderJustFired = true;
  }
  if (pos.trailPct) pos.peakPct = Math.max(pos.peakPct || 0, pnlPct);

  // Current effective stop floor — the ladder-tightened floor once
  // profit-locking has kicked in, otherwise the original hard stop.
  // Reused below for both the close check and the near-stop warning.
  const currentStopFloor = pos.stopPct !== undefined
    ? (pos.trailPct ? pos.peakPct - pos.trailPct : pos.stopPct)
    : pos.stopLossPct;

  if (pos.stopPct !== undefined && pnlPct <= currentStopFloor) {
    await closePosition(state, symbol, pos, currentPremium, "ladder_stop", "order_fill");
    return;
  }

  // Regime flip — trend thesis invalidated
  const bars = await getBars(symbol, "15Min", 5);
  const regimeNow = computeRegime(bars, strategy.params);
  if (regimeNow) {
    const against = (pos.signal === "CALL" && regimeNow === "bearish") || (pos.signal === "PUT" && regimeNow === "bullish");
    if (against) {
      await closePosition(state, symbol, pos, currentPremium, "regime_flip", "order_fill");
      return;
    }
  }

  // ── EVENT-DRIVEN UPDATES (position still open this cycle) ───
  // Replaces the old fixed 2-minute interval, which sent a message every
  // cycle regardless of whether anything happened. Now: silence unless
  // something noteworthy occurred.

  // Near-stop warning — once, the first time price comes within 5 points
  // of whichever stop currently protects the position. Never repeats.
  if (!pos.nearStopWarned && (pnlPct - currentStopFloor) <= 5) {
    pos.nearStopWarned = true;
    await tg(`⚠️ <b>${symbol} قريب من الوقف</b>\n${pnlPct.toFixed(1)}% | الوقف الحالي عند ${currentStopFloor.toFixed(1)}%`, pos.msgId);
  }

  // ±10% premium bands from entry — one message per NEW band crossed,
  // tracked via pos.lastReportedThreshold so re-entering an
  // already-reported band (price oscillating near a boundary) stays
  // silent. Skipped if a ladder message above already covered this exact
  // crossing (takeProfit1Pct/takeProfit2Pct can land on the same band).
  const thresholdLevel = Math.trunc(pnlPct / 10) * 10;
  if (thresholdLevel !== 0 && thresholdLevel !== pos.lastReportedThreshold) {
    pos.lastReportedThreshold = thresholdLevel;
    if (!ladderJustFired) {
      await tg(buildUpdateMsg(symbol, pos, pnlPct, currentPremium), pos.msgId);
    }
  }

  saveState(state);
}

// ─── SCAN FOR NEW ENTRIES ───────────────────────────────────
async function scanEntry(state, strategy, symbol, liveInAlpaca) {
  if (state[symbol]?.active) return;
  if (liveInAlpaca.has(symbol)) return;
  if (isPastLastEntry()) return;

  if (countOpenPositions(state) >= MAX_OPEN_POSITIONS) {
    console.log(`Max open positions (${MAX_OPEN_POSITIONS}) reached — skip ${symbol}`);
    return;
  }
  if (getTodayRealizedPnl() <= -MAX_DAILY_LOSS) {
    console.log(`Daily loss cap hit — no new entries today`);
    return;
  }

  const bars = await getBars(symbol, "15Min", 5);
  const sig = computeSignal(bars, strategy.params);
  if (!sig || !sig.signal) return;

  // Entry-snapshot indicators for later analysis only (see
  // computeVWAP/computeRSI above) — reuses bars, no extra fetch.
  const closedBars = bars.length > 1 ? bars.slice(0, -1) : bars;
  const vwapAtEntry = computeVWAP(bars);
  const rsiAtEntry = computeRSI(closedBars.map(b => b.c));

  const spot = await getLatestPrice(symbol);
  if (!spot) return;

  // ── COMBO-BASED POSITION SIZING ──────────────────────────────
  // Replaces global-parameter tuning (see runComboLearning() /
  // computeCombos() below): sizes THIS trade by how its own
  // (symbol × trend-direction[× RSI]) combo has actually performed,
  // instead of a single param that would scale every trade at once.
  // calcQty() already clamps to MAX_TRADE_BUDGET internally, so this can
  // never exceed the hard cap even at the ×1.5 tier.
  const trendDir = trendDirection(spot, vwapAtEntry, sig.signal);
  const { comboKey, sizeMultiplier } = lookupComboMultiplier(strategy.combos, symbol, trendDir, rsiAtEntry);
  const effectiveBudget = strategy.params.tradeBudget * sizeMultiplier;

  const opt = await findOption(symbol, sig.signal, spot);
  if (!opt) { console.log(`${symbol}: no option within ${MAX_DTE} DTE`); return; }

  const qty = calcQty(opt.premium, effectiveBudget);
  const order = await alpaca("/orders", "POST", { symbol: opt.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day" });
  if (!order.id) { console.log(`${symbol}: entry order failed`, order); return; }

  const hardStopPrice = +(opt.premium * (1 + strategy.params.stopLossPct / 100)).toFixed(2);
  let stopOrderId = null;
  try {
    const stopOrder = await alpaca("/orders", "POST", {
      symbol: opt.symbol, qty: String(qty), side: "sell", type: "stop",
      time_in_force: "day", stop_price: String(Math.max(0.01, hardStopPrice))
    });
    stopOrderId = stopOrder.id || null;
  } catch (e) { console.error(`${symbol}: stop order failed:`, e.message); }

  const msgId = await tg(`<b>${symbol} ${sig.signal} $${opt.strike}</b> (exp ${opt.expiry})\n💰 $${opt.premium.toFixed(2)} × ${qty} = $${(opt.premium*qty*100).toFixed(0)}\nنظام: ${strategy.name} | نطاق: ${sig.regime} | حجم×${sig.volRatio.toFixed(2)}`);

  state[symbol] = {
    active: true, signal: sig.signal, optionSymbol: opt.symbol, strike: opt.strike,
    entryPremium: opt.premium, qty, entryTime: Date.now(), msgId, stopOrderId, hardStopPrice,
    stopLossPct: strategy.params.stopLossPct,
    takeProfit1Pct: strategy.params.takeProfit1Pct, takeProfit1LockPct: strategy.params.takeProfit1LockPct,
    takeProfit2Pct: strategy.params.takeProfit2Pct, takeProfit2LockPct: strategy.params.takeProfit2LockPct,
    trailingPct: strategy.params.trailingPct,
    strategyVersion: strategy.version,
    entryConditions: {
      spot, regime: sig.regime, emaFast: +sig.emaFast.toFixed(4), emaSlow: +sig.emaSlow.toFixed(4),
      breakoutHigh: sig.breakoutHigh, breakoutLow: sig.breakoutLow, volRatio: +sig.volRatio.toFixed(2),
      lastClose: sig.lastClose, lastVolume: sig.lastVolume, barTime: sig.barTime, entryTimeUTC: new Date().toISOString(),
      vwapAtEntry, rsiAtEntry, signalType: "breakout",
      trendDir, comboKey, sizeMultiplier,
    },
  };
  saveState(state);
  console.log(`✅ LAB ENTRY: ${symbol} ${sig.signal} $${opt.strike} @ $${opt.premium.toFixed(2)} × ${qty} (combo ${comboKey || "n/a"} ×${sizeMultiplier})`);
}

// ─── RICH EXPLANATORY NOTIFICATION (sent for every self-adjustment) ──
// Formats up to 3 example trades as "SYMBOL: +/-X% (regime, volRatio)". Picks
// from win/loss rather than matching r.reason exactly — outcomes_lab.jsonl
// reason labels (e.g. "alpaca_stop") don't always line up 1:1 with the
// byReason buckets runDailyLearning groups by, so this stays meaningful
// regardless of which exact reason string produced the trade.
function fmtExamples(records) {
  if (!records.length) return "  (لا تتوفر أمثلة كافية في العينة)";
  return records.slice(0, 3).map(r => {
    const ec = r.entryConditions || {};
    const ctx = [ec.regime, ec.volRatio != null ? `حجم×${ec.volRatio}` : null].filter(Boolean).join("، ");
    return `  • ${r.symbol}: ${r.pnlPct > 0 ? "+" : ""}${r.pnlPct}%${ctx ? ` (${ctx})` : ""}`;
  }).join("\n");
}

function buildTemplate2(change, old, next, n, wr, netPnl, records, today) {
  const losers = records.filter(r => !r.win).slice().sort((a, b) => a.pnlPct - b.pnlPct);
  const winners = records.filter(r => r.win).slice().sort((a, b) => b.pnlPct - a.pnlPct);

  let observed, cause, whatChanged, expected;

  if (change.param === "volumeMultiplier") {
    observed = `${change.reason}\nأسوأ الأمثلة من الصفقات الخاسرة:\n${fmtExamples(losers)}`;
    cause = "الدخول يحدث عند تأكيد حجم ضعيف نسبياً، ما يزيد احتمال الدخول في اختراقات كاذبة تصطدم بوقف الخسارة بسرعة — تحقّقت هذه الفرضية فعلياً من بيانات حجم صفقات الوقف قبل هذا التعديل.";
    whatChanged = `رفع عتبة تأكيد الحجم (volumeMultiplier) من ${old} إلى ${next} — يتطلب حجم تداول أقوى نسبياً قبل قبول أي إشارة دخول، لتصفية الإشارات الضعيفة.`;
    expected = "عدد صفقات أقل لكن بجودة دخول أعلى، وانخفاض تدريجي متوقع في نسبة الخروج عبر وقف الخسارة. سيُقاس الأثر الفعلي (لا افتراضاً) في دورة التعلم القادمة قبل أي تعديل آخر على نفس البارامتر.";
  } else if (change.param === "takeProfit2Pct") {
    observed = `${change.reason}\nأفضل الأمثلة من الصفقات الرابحة:\n${fmtExamples(winners)}`;
    cause = "تحركات قوية ومتجهة يبدو أنها تُقطع مبكراً عند هدف الربح الثاني الحالي — تحقّقت هذه الفرضية فعلياً من أن أغلب الصفقات الرابحة عبر السلم وصلت قرب سقف الهدف الحالي قبل هذا التعديل.";
    whatChanged = `رفع هدف الربح الثاني (takeProfit2Pct) من ${old} إلى ${next} — يمنح الصفقات الرابحة مساحة أكبر للاستمرار قبل الإغلاق الجزئي.`;
    expected = "متوسط ربح أعلى محتمل للصفقات الرابحة القوية، مع احتمال تقلب أكبر إن انعكس السعر قبل بلوغ الهدف الجديد. سيُقاس الأثر الفعلي في دورة التعلم القادمة قبل أي تعديل آخر على نفس البارامتر.";
  } else if (change.param === "stopLossPct") {
    observed = `${change.reason}\nأسوأ الأمثلة من العينة الكاملة:\n${fmtExamples(losers)}`;
    cause = "الخسائر الكبيرة تصل فعلياً قرب مستوى الوقف الحالي (تحقّق من البيانات) بدل الانعكاس قبله بكثير — أي الوقف هو القيد الفعلي على حجم الخسارة، وليس افتراضاً.";
    whatChanged = `تضييق وقف الخسارة (stopLossPct) من ${old} إلى ${next} — يقلل حجم الخسارة لكل صفقة خاسرة.`;
    expected = "انخفاض متوقع في متوسط حجم الخسارة لكل صفقة، دون بالضرورة تحسّن فوري في نسبة الربح نفسها. سيُقاس الأثر الفعلي في دورة التعلم القادمة قبل أي تعديل آخر على نفس البارامتر.";
  } else if (change.param === "emaSlow") {
    observed = `${change.reason}\nأسوأ الأمثلة من الصفقات الخاسرة عبر الوقف الصلب:\n${fmtExamples(losers)}`;
    cause = "نسبة كبيرة من صفقات وقف الخسارة الصلب دخلت عند نطاق ضعيف/متردد (فارق ضئيل بين المتوسطين المتحركين السريع والبطيء وقت الدخول) — تحقّقت هذه الفرضية فعلياً من بيانات فارق EMA المسجَّلة، وليست افتراضاً.";
    whatChanged = `توسيع EMA البطيء (emaSlow) من ${old} إلى ${next} — يتطلب فصلاً أوضح بين الاتجاه الصاعد والهابط قبل قبول أي إشارة، لتفادي الدخول عند نطاقات متذبذبة.`;
    expected = "إشارات أقل لكن أكثر وضوحاً في اتجاه النطاق، وانخفاض متوقع في نسبة الدخول عند نطاقات ضعيفة. سيُقاس الأثر الفعلي في دورة التعلم القادمة قبل أي تعديل آخر على نفس البارامتر.";
  } else if (change.param === "breakoutLookback") {
    observed = `${change.reason}\nأسوأ الأمثلة من الصفقات الخاسرة عبر الوقف الصلب:\n${fmtExamples(losers)}`;
    cause = "نسبة كبيرة من صفقات وقف الخسارة الصلب دخلت عند اختراق هامشي بالكاد تجاوز المستوى — تحقّقت هذه الفرضية فعلياً من مسافة الإغلاق عن المستوى وقت الدخول، وليست افتراضاً.";
    whatChanged = `رفع نافذة الاختراق (breakoutLookback) من ${old} إلى ${next} — يتطلب اختراقاً أوضح (نطاقاً أطول) قبل قبول الإشارة، لتفادي الاختراقات الهامشية.`;
    expected = "إشارات أقل لكن أكثر حسماً، وانخفاض متوقع في نسبة الاختراقات الهامشية التي ترتد بسرعة. سيُقاس الأثر الفعلي في دورة التعلم القادمة قبل أي تعديل آخر على نفس البارامتر.";
  } else {
    observed = `${change.reason}`;
    cause = "—";
    whatChanged = `${change.param}: ${old} → ${next}.`;
    expected = "سيُقاس الأثر الفعلي في دورة التعلم القادمة قبل أي تعديل آخر على نفس البارامتر.";
  }

  return `🧪 <b>تعديل استراتيجية تلقائي</b> (${today})\nالبارامتر: <b>${change.param}</b>: ${old} → ${next}\n\n📊 ما لوحظ:\n${observed}\n\n🔍 السبب المحتمل (مُتحقَّق منه بالبيانات):\n${cause}\n\n⚙️ التغيير ولماذا:\n${whatChanged}\n\n📈 الأثر المتوقع:\n${expected}\n\nصافي $${netPnl} على العينة الكاملة (${n} صفقة).`;
}

// ─── LEARNING MEMORY: metrics, effect evaluation, hypothesis verification ──
// Design summary (measure → verify → diversify → remember):
//   1. Before proposing anything new, evaluate the most recent PENDING
//      changelog entry against fresh post-change data. No new change is
//      proposed until either that evaluation completes or there simply
//      isn't a pending one — this is what stops the same param from being
//      re-adjusted on stale/repeated evidence.
//   2. Every candidate hypothesis is checked against actual per-trade data
//      (e.g. was the losing trade's volume really near the threshold?)
//      before being accepted — not assumed from an aggregate ratio alone.
//   3. A param with MAX_FAILED_ATTEMPTS consecutive non-improvements is
//      excluded from consideration until a later change (or an explicit
//      correction) resets it, so the tuner is forced to diversify instead
//      of fixating.
//   4. Every changelog entry now carries metricName/metricBefore/
//      metricAfter/effect — a persistent ledger of what was tried and
//      whether it actually worked, read back by steps 1 and 3 above.
// PARAM_BOUNDS / MAX_PARAM_STEP_FRACTION / MIN_SAMPLE_FOR_LEARNING above
// are untouched — this only changes which change (if any) gets proposed.
const MIN_POST_CHANGE_SAMPLE = 15;    // trades needed after a change before judging its effect
const HYPOTHESIS_PASS_FRACTION = 0.4; // >=40% of the flagged trades must actually support the hypothesis
const MAX_FAILED_ATTEMPTS = 2;        // exclude a param after this many consecutive non-improvements
const IMPROVEMENT_THRESHOLDS = {
  hardStopRatio: 0.05, // must drop by >=5 percentage points to count as "improved"
  avgLadderWin:  1,    // avg ladder-win pnlPct must rise by >=1 point
  avgLossSize:   1,    // avg loss pnlPct must rise (become less negative) by >=1 point
};
// Bucket by *functional* stop type, not the literal reason string.
// "alpaca_stop"/"alpaca_stop_est" fire when Alpaca's own resting stop
// order fills before our live monitorPosition() poll catches the same
// breach itself (see the reconciliation pass in the main loop below) —
// by construction the only resting stop order at any moment is either
// the original hard stop-loss or the ladder-tightened stop after a
// profit lock, so a loss through that path is functionally a hard stop
// and a win is functionally a ladder stop, same as when
// monitorPosition() catches the breach itself and logs "hard_stop" /
// "ladder_stop" directly. Without this, hard_stop/ladder_stop stayed
// almost always empty and no tuning rule below could ever fire.
function tuningBucket(r) {
  if (r.reason === "alpaca_stop" || r.reason === "alpaca_stop_est") return r.win ? "ladder_stop" : "hard_stop";
  return r.reason;
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function computeMetric(metricName, records) {
  if (!records.length) return null;
  if (metricName === "hardStopRatio") {
    const hs = records.filter(r => tuningBucket(r) === "hard_stop").length;
    return hs / records.length;
  }
  if (metricName === "avgLadderWin") {
    const wins = records.filter(r => tuningBucket(r) === "ladder_stop" && r.win);
    return wins.length ? wins.reduce((a, r) => a + r.pnlPct, 0) / wins.length : null;
  }
  if (metricName === "avgLossSize") {
    const losses = records.filter(r => !r.win);
    return losses.length ? losses.reduce((a, r) => a + r.pnlPct, 0) / losses.length : null;
  }
  return null;
}

// hardStopRatio: lower is better. avgLadderWin/avgLossSize: higher (less
// negative, for avgLossSize) is better.
function classifyEffect(metricName, before, after) {
  if (before == null || after == null) return "pending";
  const threshold = IMPROVEMENT_THRESHOLDS[metricName] ?? 0;
  const better = metricName === "hardStopRatio" ? before - after : after - before;
  if (better >= threshold) return "improved";
  if (-better >= threshold) return "worsened";
  return "no_improvement";
}

function fmtMetric(metricName, value) {
  if (value == null) return "—";
  return metricName === "hardStopRatio" ? `${(value * 100).toFixed(0)}%` : `${value.toFixed(1)}%`;
}

// A "correction" entry (type: "correction") or an "improved" result resets
// the streak — only consecutive no_improvement/worsened entries count.
function countConsecutiveFailures(changelog, param) {
  let count = 0;
  for (let i = changelog.length - 1; i >= 0; i--) {
    const entry = changelog[i];
    if (entry.param !== param) continue;
    if (entry.type === "correction" || entry.effect === "improved") break;
    if (entry.effect === "no_improvement" || entry.effect === "worsened") { count++; continue; }
    break; // pending / inconclusive / undefined (legacy entry) — stop conservatively
  }
  return count;
}

// Evaluates the most recent PENDING changelog entry, if any. Returns
// false when a new change should NOT be proposed this cycle (either
// evaluation is still waiting on more post-change data). Returns true
// when it's safe to proceed to candidate-building — either nothing was
// pending, or an evaluation just completed.
async function evaluatePendingChange(strategy, records) {
  const changelog = strategy.changelog;
  if (!changelog.length) return true;
  const last = changelog[changelog.length - 1];
  if (last.effect && last.effect !== "pending") return true;

  if (!last.appliedAt || !last.metricName) {
    // Legacy entry from before this redesign — no precise timestamp to
    // isolate "trades after", so it can never be measured. Mark it
    // inconclusive (not "improved") so it stops blocking new decisions
    // without being silently counted as a success.
    last.effect = "inconclusive";
    saveStrategy(strategy);
    return true;
  }

  const appliedAtMs = new Date(last.appliedAt).getTime();
  const after = records.filter(r => new Date(r.exitTime).getTime() > appliedAtMs);
  if (after.length < MIN_POST_CHANGE_SAMPLE) {
    console.log(`Learning: waiting for more post-change data for ${last.param} (${after.length}/${MIN_POST_CHANGE_SAMPLE}) — no new change today.`);
    return false;
  }

  const metricAfter = computeMetric(last.metricName, after);
  const effect = classifyEffect(last.metricName, last.metricBefore, metricAfter);
  last.metricAfter = metricAfter != null ? +metricAfter.toFixed(4) : null;
  last.tradesAfter = after.length;
  last.effect = effect;
  saveStrategy(strategy);

  const verdictAr = { improved: "تحسّن ✅", no_improvement: "لم يتحسّن ⚠️", worsened: "تراجع ❌" }[effect] || effect;
  await tg(`📋 <b>تقييم التعديل السابق</b> (${last.param}: ${last.oldValue} → ${last.newValue})\nالمقياس (${last.metricName}): ${fmtMetric(last.metricName, last.metricBefore)} → ${fmtMetric(last.metricName, metricAfter)}\nالنتيجة: ${verdictAr} (على ${after.length} صفقة بعد التعديل)`);
  return true;
}

// ─── LEGACY: DAILY SELF-TUNING (global-parameter, rule-based) ──
// No longer auto-invoked (see main loop below, which now calls
// runComboLearning() instead) — replaced by the combo-based position
// sizing system further down. A global-parameter change here (e.g. the
// emaSlow widening on 2026-09-01) affects every single trade at once and
// can throttle entries to zero across the board while evidence
// accumulates, which is exactly what combo-based sizing avoids: a
// combo's size is scaled individually, trading never stops entirely.
// Kept intact, unused, as a manual fallback (call it by hand if ever
// needed) — not deleted, not wired into the main loop.
async function runDailyLearning(state, strategy) {
  const today = getToday();
  if (state._lastLearnedDay === today) return;
  state._lastLearnedDay = today;
  saveState(state);

  let records = [];
  try {
    records = fs.readFileSync("outcomes_lab.jsonl", "utf8").split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { records = []; }

  const n = records.length;
  console.log(`Daily learning: ${n} cumulative closed trades`);
  if (n < MIN_SAMPLE_FOR_LEARNING) {
    console.log(`Sample too small (${n} < ${MIN_SAMPLE_FOR_LEARNING}) — no change today.`);
    return;
  }

  const wins = records.filter(r => r.win).length;
  const wr = wins / n;
  const netPnl = records.reduce((a, r) => a + r.pnl, 0);

  // Step 1: evaluate the previous change's actual effect before proposing
  // anything new. If there's a pending entry still waiting on more
  // post-change data, stop here — no new change today.
  const canProceed = await evaluatePendingChange(strategy, records);
  if (!canProceed) return;

  const byReason = {};
  for (const r of records) {
    const bucket = tuningBucket(r);
    byReason[bucket] = byReason[bucket] || { n: 0, wins: 0, pnl: 0, records: [] };
    byReason[bucket].n++;
    if (r.win) byReason[bucket].wins++;
    byReason[bucket].pnl += r.pnl;
    byReason[bucket].records.push(r);
  }
  const hardStop = byReason["hard_stop"];
  const ladder = byReason["ladder_stop"];

  // Step 2: build every data-justified candidate, each gated behind a
  // verification check against actual per-trade evidence — not accepted
  // on the aggregate ratio alone.
  const candidates = [];

  if (hardStop && hardStop.n >= MIN_SAMPLE_FOR_LEARNING * 0.5 && (hardStop.n / n) > 0.4) {
    const withVol = hardStop.records.filter(r => r.entryConditions?.volRatio != null);
    const threshold = strategy.params.volumeMultiplier;
    const nearThreshold = withVol.filter(r => r.entryConditions.volRatio <= threshold * 1.3);
    const passFraction = withVol.length ? nearThreshold.length / withVol.length : 0;
    if (passFraction >= HYPOTHESIS_PASS_FRACTION) {
      candidates.push({
        param: "volumeMultiplier", direction: +1, metricName: "hardStopRatio",
        metricBefore: hardStop.n / n, evidence: passFraction,
        reason: `${hardStop.n}/${n} صفقة (${(hardStop.n/n*100).toFixed(0)}%) خرجت عبر وقف الخسارة الصلب، و${(passFraction*100).toFixed(0)}% منها كان حجمها قريباً فعلاً من العتبة الحالية (${threshold}×) — رفع العتبة لتقليل الإشارات الضعيفة.`,
      });
    } else {
      const median = medianOf(withVol.map(r => r.entryConditions.volRatio));
      console.log(`Learning: volumeMultiplier hypothesis rejected — only ${(passFraction*100).toFixed(0)}% of hard_stop losers near threshold (median volRatio ${median?.toFixed(2)} vs threshold ${threshold}×) — volume is not the driver.`);
    }
  }

  if (ladder && ladder.n >= MIN_SAMPLE_FOR_LEARNING * 0.3 && (ladder.wins / ladder.n) > 0.6 && wr > 0.5) {
    const ladderWins = ladder.records.filter(r => r.win);
    const ceiling = strategy.params.takeProfit2Pct;
    const nearCeiling = ladderWins.filter(r => r.pnlPct >= ceiling * 0.85);
    const passFraction = ladderWins.length ? nearCeiling.length / ladderWins.length : 0;
    if (passFraction >= HYPOTHESIS_PASS_FRACTION) {
      candidates.push({
        param: "takeProfit2Pct", direction: +1, metricName: "avgLadderWin",
        metricBefore: computeMetric("avgLadderWin", records), evidence: passFraction,
        reason: `${ladder.wins}/${ladder.n} من صفقات سلم الأرباح رابحة (${(ladder.wins/ladder.n*100).toFixed(0)}%)، و${(passFraction*100).toFixed(0)}% منها وصلت قرب سقف هدف الربح الثاني الحالي (${ceiling}%) — رفعه للاستفادة من الاتجاهات القوية.`,
      });
    } else {
      console.log(`Learning: takeProfit2Pct hypothesis rejected — only ${(passFraction*100).toFixed(0)}% of ladder wins near the ${ceiling}% ceiling.`);
    }
  }

  if (wr < 0.4) {
    const losses = records.filter(r => !r.win);
    const stopLevel = strategy.params.stopLossPct;
    const nearStop = losses.filter(r => r.pnlPct <= stopLevel * 0.85);
    const passFraction = losses.length ? nearStop.length / losses.length : 0;
    if (passFraction >= HYPOTHESIS_PASS_FRACTION) {
      candidates.push({
        param: "stopLossPct", direction: +1, metricName: "avgLossSize",
        metricBefore: computeMetric("avgLossSize", records), evidence: passFraction,
        reason: `نسبة الربح الكلية ${(wr*100).toFixed(0)}% على ${n} صفقة أقل من 40%، و${(passFraction*100).toFixed(0)}% من الخسائر وصلت فعلياً قرب مستوى الوقف الحالي (${stopLevel}%) — تضييقه لتقليل حجم الخسارة لكل صفقة.`,
      });
    } else {
      console.log(`Learning: stopLossPct hypothesis rejected — only ${(passFraction*100).toFixed(0)}% of losses reach near the ${stopLevel}% stop (most reverse well before it).`);
    }
  }

  if (hardStop && hardStop.n >= MIN_SAMPLE_FOR_LEARNING * 0.4) {
    const withEma = hardStop.records.filter(r => r.entryConditions?.emaFast != null && r.entryConditions?.emaSlow != null);
    const weakGap = withEma.filter(r => Math.abs(r.entryConditions.emaFast - r.entryConditions.emaSlow) / r.entryConditions.emaSlow < 0.0015);
    const passFraction = withEma.length ? weakGap.length / withEma.length : 0;
    if (passFraction >= HYPOTHESIS_PASS_FRACTION) {
      candidates.push({
        param: "emaSlow", direction: +1, metricName: "hardStopRatio",
        metricBefore: hardStop.n / n, evidence: passFraction,
        reason: `${(passFraction*100).toFixed(0)}% من صفقات وقف الخسارة الصلب دخلت عند نطاق ضعيف/متردد (فارق EMA سريع/بطيء أقل من 0.15%) — توسيع emaSlow لتطلّب فصلاً أوضح بين الاتجاهين.`,
      });
    }
  }

  if (hardStop && hardStop.n >= MIN_SAMPLE_FOR_LEARNING * 0.4) {
    const withLevels = hardStop.records.filter(r => r.entryConditions?.breakoutHigh != null && r.entryConditions?.lastClose != null);
    const marginal = withLevels.filter(r => {
      const ec = r.entryConditions;
      const level = r.signal === "CALL" ? ec.breakoutHigh : ec.breakoutLow;
      return level > 0 && Math.abs(ec.lastClose - level) / level < 0.001;
    });
    const passFraction = withLevels.length ? marginal.length / withLevels.length : 0;
    if (passFraction >= HYPOTHESIS_PASS_FRACTION) {
      candidates.push({
        param: "breakoutLookback", direction: +1, metricName: "hardStopRatio",
        metricBefore: hardStop.n / n, evidence: passFraction,
        reason: `${(passFraction*100).toFixed(0)}% من صفقات وقف الخسارة الصلب دخلت عند اختراق هامشي بالكاد تجاوز المستوى — رفع نافذة الاختراق (breakoutLookback) لتطلّب اختراقاً أوضح.`,
      });
    }
  }

  // Step 3: diversify — drop any param on cooldown after repeated
  // non-improvement, then take the strongest surviving evidence.
  const eligible = candidates.filter(c => countConsecutiveFailures(strategy.changelog, c.param) < MAX_FAILED_ATTEMPTS);
  if (!eligible.length) {
    if (candidates.length) console.log(`Learning: ${candidates.length} candidate(s) found but all on cooldown after repeated non-improvement — no change today.`);
    else console.log("No clear data-justified change today.");
    return;
  }
  eligible.sort((a, b) => b.evidence - a.evidence);
  const change = eligible[0];

  const [lo, hi] = PARAM_BOUNDS[change.param];
  const old = strategy.params[change.param];
  const step = Math.max(Math.abs(old) * MAX_PARAM_STEP_FRACTION, change.param.toLowerCase().includes("pct") ? 1 : 0.05);
  let next = clamp(+(old + change.direction * step).toFixed(3), lo, hi);

  if (next === old) { console.log(`${change.param} already at bound (${old}) — no change applied.`); return; }

  // Step 4: remember — every entry now carries the metric baseline that
  // evaluatePendingChange() will compare against once enough post-change
  // trades accumulate.
  strategy.params[change.param] = next;
  strategy.changelog.push({
    date: today, appliedAt: new Date().toISOString(),
    param: change.param, oldValue: old, newValue: next, reason: change.reason,
    sampleSize: n, winRate: +(wr * 100).toFixed(1), netPnl,
    metricName: change.metricName,
    metricBefore: change.metricBefore != null ? +change.metricBefore.toFixed(4) : null,
    metricAfter: null, tradesAfter: null, effect: "pending",
  });
  saveStrategy(strategy);

  await tg(buildTemplate2(change, old, next, n, wr, netPnl, records, today));
  console.log(`Applied change: ${change.param} ${old} -> ${next}`);
}

// ─── COMBO-BASED POSITION SIZING (active learning system) ──────
// Replaces the global-parameter tuner above. Instead of changing one
// param for every trade, this learns which (symbol × trend-direction)
// combinations perform well or poorly and scales ONLY that combo's
// position size accordingly — a weak combo trades smaller, never zero,
// so the experiment (and data collection) never stalls the way a global
// param change could.
//
// Design:
//   depth 2: symbol × trend ("with"/"against" VWAP) — 12 combos max.
//   depth 3: once a depth-2 combo has proven itself (big enough sample,
//     a clear tier), it "deepens" into 3 RSI-bucketed sub-combos, tested
//     independently — but only for that one proven combo, never all 12
//     at once, so this never explodes combinatorially.
//   Combo stats are recomputed from scratch from outcomes_lab.jsonl every
//   cycle (same pattern as the legacy tuner above) — outcomes_lab.jsonl
//   stays the single source of truth; strategy.combos is a derived,
//   persisted cache read synchronously at trade entry.
const MIN_COMBO_SAMPLE = 8;      // trades needed before a combo is judged at all
const DEEPEN_MIN_SAMPLE = 16;    // trades needed before a combo may split into a 3rd factor
const COMBO_TIER_MARGIN_PP = 8;  // avg pnlPct must differ from the overall average by this many points
const COMBO_SIZE_MULTIPLIER = { above_avg: 1.5, average: 1.0, below_avg: 0.5, insufficient: 1.0 };

// CALL above VWAP / PUT below VWAP = "with" the trend the entry is
// betting on; the opposite = "against". Same convention analyze.js (the
// old v20 report) used. Returns null when vwapAtEntry isn't recorded yet
// (older trades, or a session with too little intraday data) — callers
// treat null as "can't classify, default size".
function trendDirection(spot, vwapAtEntry, signal) {
  if (spot == null || vwapAtEntry == null) return null;
  const aboveVwap = spot > vwapAtEntry;
  if (signal === "CALL") return aboveVwap ? "with" : "against";
  return aboveVwap ? "against" : "with";
}

function rsiBucket(rsi) {
  if (rsi == null) return null;
  if (rsi < 40) return "<40";
  if (rsi > 60) return ">60";
  return "40-60";
}

// Rebuilds every combo's stats from the full outcomes history. Only
// trades with both spot and vwapAtEntry recorded can be classified —
// trades from before that field existed are simply excluded, not
// mis-bucketed.
function computeCombos(records, previousCombos) {
  const withTrend = records
    .map(r => ({ r, trend: trendDirection(r.entryConditions?.spot, r.entryConditions?.vwapAtEntry, r.signal) }))
    .filter(x => x.trend);

  const overallAvgPnlPct = withTrend.length
    ? withTrend.reduce((a, x) => a + x.r.pnlPct, 0) / withTrend.length
    : null;

  function tierFor(n, avgPnlPct) {
    if (n < MIN_COMBO_SAMPLE || avgPnlPct == null || overallAvgPnlPct == null) return "insufficient";
    const diff = avgPnlPct - overallAvgPnlPct;
    if (diff >= COMBO_TIER_MARGIN_PP) return "above_avg";
    if (diff <= -COMBO_TIER_MARGIN_PP) return "below_avg";
    return "average";
  }

  function makeEntry(key, factors, depth, parentKey, subset) {
    const n = subset.length;
    const wins = subset.filter(x => x.r.win).length;
    const pnl = subset.reduce((a, x) => a + x.r.pnl, 0);
    const avgPnlPct = n ? subset.reduce((a, x) => a + x.r.pnlPct, 0) / n : null;
    const tier = tierFor(n, avgPnlPct);
    const prev = previousCombos?.[key];
    return {
      factors, depth, parentKey: parentKey || null,
      n, wins, pnl: Math.round(pnl),
      avgPnlPct: avgPnlPct != null ? +avgPnlPct.toFixed(2) : null,
      tier, previousTier: prev?.tier ?? null,
      sizeMultiplier: COMBO_SIZE_MULTIPLIER[tier],
      deepened: prev?.deepened || false,
      lastUpdated: new Date().toISOString(),
    };
  }

  const combos = {};
  for (const symbol of ALLOWED_TICKERS) {
    for (const trend of ["with", "against"]) {
      const key = `${symbol}|trend:${trend}`;
      const subset = withTrend.filter(x => x.r.symbol === symbol && x.trend === trend);
      const entry = makeEntry(key, { symbol, trend }, 2, null, subset);
      combos[key] = entry;

      // Deepening is a one-way ratchet: once split, a combo stays split
      // even if its tier later drifts back toward "average" on new data.
      const alreadyDeepened = previousCombos?.[key]?.deepened;
      const shouldDeepen = alreadyDeepened ||
        (entry.n >= DEEPEN_MIN_SAMPLE && entry.tier !== "average" && entry.tier !== "insufficient");
      if (shouldDeepen) {
        entry.deepened = true;
        for (const bucket of ["<40", "40-60", ">60"]) {
          const childKey = `${key}|rsi:${bucket}`;
          const childSubset = subset.filter(x => rsiBucket(x.r.entryConditions?.rsiAtEntry) === bucket);
          combos[childKey] = makeEntry(childKey, { symbol, trend, rsi: bucket }, 3, key, childSubset);
        }
      }
    }
  }

  return { combos, overallAvgPnlPct };
}

// Entry-time lookup: most specific proven match wins. A deepened parent
// whose matching child isn't yet at MIN_COMBO_SAMPLE falls back to the
// parent's own multiplier (its evidence is still better than nothing) —
// never resets to 1.0 just because the child is still young.
function lookupComboMultiplier(combos, symbol, trendDir, rsiAtEntry) {
  if (!combos || !trendDir) return { comboKey: null, sizeMultiplier: 1.0 };
  const parentKey = `${symbol}|trend:${trendDir}`;
  const parent = combos[parentKey];

  if (parent?.deepened) {
    const bucket = rsiBucket(rsiAtEntry);
    const childKey = bucket ? `${parentKey}|rsi:${bucket}` : null;
    const child = childKey ? combos[childKey] : null;
    if (child && child.n >= MIN_COMBO_SAMPLE) {
      return { comboKey: childKey, sizeMultiplier: child.sizeMultiplier };
    }
  }
  if (parent && parent.n >= MIN_COMBO_SAMPLE) {
    return { comboKey: parentKey, sizeMultiplier: parent.sizeMultiplier };
  }
  return { comboKey: parentKey, sizeMultiplier: 1.0 };
}

const COMBO_TIER_AR = { above_avg: "أعلى من المتوسط", average: "متوسط", below_avg: "أقل من المتوسط" };
const COMBO_TREND_AR = { with: "مع الترند", against: "ضد الترند" };

function buildComboTemplate(combo, overallAvgPnlPct) {
  const label = combo.depth === 3
    ? `${combo.factors.symbol} × ${COMBO_TREND_AR[combo.factors.trend]} × RSI ${combo.factors.rsi}`
    : `${combo.factors.symbol} × ${COMBO_TREND_AR[combo.factors.trend]}`;
  const prevMultiplier = combo.previousTier ? COMBO_SIZE_MULTIPLIER[combo.previousTier] : 1.0;
  const wr = combo.n ? Math.round(combo.wins / combo.n * 100) : 0;
  const diff = overallAvgPnlPct != null && combo.avgPnlPct != null ? combo.avgPnlPct - overallAvgPnlPct : null;
  const tierAr = COMBO_TIER_AR[combo.tier] || combo.tier;
  // "average" only ever reaches here via a downgrade from above_avg/below_avg
  // (see the sizeMultiplier-change gate in runComboLearning below) — never
  // claim a clear margin for it, since by definition it doesn't have one.
  const causeAr = combo.tier === "above_avg"
    ? `يتفوّق على أداء LAB العام بفارق واضح (≥${COMBO_TIER_MARGIN_PP}pp)`
    : combo.tier === "below_avg"
    ? `أضعف من أداء LAB العام بفارق واضح (≥${COMBO_TIER_MARGIN_PP}pp)`
    : `عاد قريباً من أداء LAB العام (الفارق تحت ${COMBO_TIER_MARGIN_PP}pp الآن)`;

  return `🧪 <b>تعلّم توليفة</b>: ${label}\n`
    + `الحجم: ×${prevMultiplier} → <b>×${combo.sizeMultiplier}</b> (${tierAr})\n`
    + `العيّنة: ${combo.n} صفقة | WR ${wr}% | متوسط الربح ${combo.avgPnlPct}%`
    + (diff != null ? ` (المتوسط العام ${overallAvgPnlPct.toFixed(1)}%، فارق ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp)` : "") + `\n`
    + `السبب: أداء هذه التوليفة ${causeAr}.`;
}

// Runs once per day (after force-exit, same timing the legacy tuner
// used). Rebuilds every combo from outcomes_lab.jsonl and notifies only
// on an actual SIZE change ("رفع/خفض حجمها" per spec) — not merely a tier
// label change. insufficient -> average is a real first judgment but a
// 1.0x -> 1.0x no-op, so it stays silent; only a multiplier that actually
// moves is worth a message, and this also naturally skips "still
// insufficient data" (which never has a multiplier to change from 1.0).
async function runComboLearning(state, strategy) {
  const today = getToday();
  if (state._lastComboLearnedDay === today) return;
  state._lastComboLearnedDay = today;
  saveState(state);

  let records = [];
  try {
    records = fs.readFileSync("outcomes_lab.jsonl", "utf8").split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { records = []; }

  const { combos, overallAvgPnlPct } = computeCombos(records, strategy.combos);

  const changed = Object.values(combos).filter(c => {
    const prevMultiplier = c.previousTier ? COMBO_SIZE_MULTIPLIER[c.previousTier] : 1.0;
    return c.tier !== "insufficient" && c.sizeMultiplier !== prevMultiplier;
  });
  for (const combo of changed) {
    await tg(buildComboTemplate(combo, overallAvgPnlPct));
  }

  strategy.combos = combos;
  saveStrategy(strategy);
  console.log(`Combo learning: ${Object.keys(combos).length} combo(s) tracked, ${changed.length} tier change(s) today.`);
}

// ─── MAIN ───────────────────────────────────────────────────
(async () => {
  console.log(`=== LAB bot started ${new Date().toISOString()} ===`);
  if (!isMarketOpen()) { console.log("Market closed"); process.exit(0); }

  const state = loadState();
  const strategy = loadStrategy();
  const today = getToday();

  if (state._lastDay !== today) {
    state._lastDay = today;
    saveState(state);
  }

  // Reconcile with Alpaca
  const liveInAlpaca = new Set();
  try {
    const positions = await alpaca("/positions");
    if (Array.isArray(positions)) {
      for (const p of positions) {
        const match = p.symbol?.match(/^([A-Z]+)\d/);
        if (match && ALLOWED_TICKERS.includes(match[1])) {
          const sym = match[1];
          liveInAlpaca.add(sym);
          if (!state[sym]?.active) state[sym] = { ...state[sym], active: true };
          if (!state[sym].optionSymbol || !state[sym].entryPremium) {
            await tg(`⚠️ <b>${sym}</b>: صفقة نشطة في Alpaca (${p.symbol}) لكن بيانات المتابعة المحلية ناقصة — تحتاج مراجعة يدوية.`, null);
          }
        }
      }
      for (const sym of ALLOWED_TICKERS) {
        if (!liveInAlpaca.has(sym) && state[sym]?.active) {
          const pos = state[sym];
          if (pos.optionSymbol && pos.entryPremium) {
            const exitPrem = await getQuote(pos.optionSymbol);
            if (exitPrem !== null) await closePosition(state, sym, pos, exitPrem, "alpaca_stop", "order_fill", true);
            else await closePosition(state, sym, pos, pos.entryPremium * 0.65, "alpaca_stop_est", "quote_estimate", true);
          } else { delete state[sym]; }
        }
      }
    }
    saveState(state);
  } catch (e) { console.error("Reconcile failed:", e.message); }

  // Daily loss breaker — one-time alert
  const dailyPnlNow = getTodayRealizedPnl();
  if (dailyPnlNow <= -MAX_DAILY_LOSS && state._lossBreakerAlerted !== today) {
    state._lossBreakerAlerted = today;
    saveState(state);
    await tg(`🚨 <b>تم بلوغ حد الخسارة اليومي</b> ($${Math.abs(dailyPnlNow)} ≥ $${MAX_DAILY_LOSS}) — إيقاف كل الدخول الجديد وإغلاق كل الصفقات المفتوحة لبقية اليوم.`);
  }

  if (MODE === "monitor") {
    for (const sym of ALLOWED_TICKERS) {
      if (state[sym]?.active) await monitorPosition(state, strategy, sym);
    }
    if (!isPastLastEntry()) {
      for (const sym of ALLOWED_TICKERS) {
        if (!state[sym]?.active && !liveInAlpaca.has(sym)) await scanEntry(state, strategy, sym, liveInAlpaca);
      }
    }
    if (utcMin() >= FORCE_EXIT_UTC + 5) {
      await runComboLearning(state, strategy);
    }
  } else {
    for (const sym of ALLOWED_TICKERS) {
      if (!state[sym]?.active && !liveInAlpaca.has(sym)) await scanEntry(state, strategy, sym, liveInAlpaca);
    }
  }
  saveState(state);
  console.log("Done.");
})();
