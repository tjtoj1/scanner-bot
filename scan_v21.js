// ============================================================
// BOT v21 — OPENING RANGE BREAKOUT (ORB) STRATEGY
// Uses ALPACA_KEY_2 / ALPACA_SECRET_2 (new paper account)
// Logic:
//   1. First 15 minutes (8:35-8:50 AM CDT) = build the range (high/low)
//   2. After 8:50: if price breaks above range + high volume → CALL
//                  if price breaks below range + high volume → PUT
//   3. Stop: 15-min candle closes back THROUGH the range on opposite side + low volume
//   4. Profit ladder: +10% → stop at +5% | +20% → stop +10% + 10% trail
//   5. Daily target: 3-5% of portfolio → stop new entries
//   6. Max 4 trades/day | $500 per trade
// ============================================================
import fs from "fs";
import { computeHalfTrend } from "./halftrend.js";

const ALPACA_KEY    = process.env.ALPACA_KEY_2;
const ALPACA_SECRET = process.env.ALPACA_SECRET_2;
const TG_TOKEN      = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const MODE          = process.env.MODE || "scan";
const TRADING_BASE  = "https://paper-api.alpaca.markets/v2";
const DATA_BASE     = "https://data.alpaca.markets/v2";

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

// 0DTE tickers (daily expiry)
const TICKERS_0DTE  = ["SPY", "QQQ", "IWM"];
// Non-0DTE tickers (use next available expiry after today)
const TICKERS_NEXT  = ["NVDA", "TSLA", "AMZN"];
const TICKERS       = [...TICKERS_0DTE, ...TICKERS_NEXT];

// Config
const TRADE_BUDGET      = 500;   // $ per trade
const MAX_DAILY_TRADES  = 4;
const DAILY_TARGET_MIN  = 0.03;  // 3% of portfolio
const DAILY_TARGET_MAX  = 0.05;  // 5% of portfolio
const VOL_SURGE_RATIO   = 1.2;   // high volume threshold
const LADDER_1_PCT      = 10;
const LADDER_1_STOP     = 5;
const LADDER_2_PCT      = 20;
const LADDER_2_STOP     = 10;
const TRAIL_PCT         = 10;
const HARD_STOP_PCT     = -35;

// Range building window: 8:30-8:45 AM CDT = 13:30-13:45 UTC
const RANGE_START_UTC   = 13 * 60 + 30;
const RANGE_END_UTC     = 13 * 60 + 45;
const LAST_ENTRY_UTC    = 19 * 60 + 30; // 2:30 PM CDT
const FORCE_EXIT_UTC    = 19 * 60 + 55; // 2:55 PM CDT

function utcMin() {
  const n = new Date();
  return n.getUTCHours() * 60 + n.getUTCMinutes();
}
function isMarketOpen() { const m=utcMin(); return m>=RANGE_START_UTC && m<20*60+30; }
function isRangeBuilding() { const m=utcMin(); return m>=RANGE_START_UTC && m<RANGE_END_UTC; }
function isPastLastEntry() { return utcMin() >= LAST_ENTRY_UTC; }
function isForceExit() { return utcMin() >= FORCE_EXIT_UTC; }
function getToday() { return new Date().toISOString().split("T")[0]; }

// Get next available expiry after today (for NVDA/TSLA/AMZN)
async function getNextExpiry(symbol) {
  try {
    const today = getToday();
    const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date_gte=${today}&status=active&limit=50&type=call`;
    const res = await fetchWithTimeout(url, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const d = await res.json();
    const contracts = d?.option_contracts || [];
    // Get unique expiry dates sorted
    const dates = [...new Set(contracts.map(c => c.expiration_date))].sort();
    // Find first expiry AFTER today
    const next = dates.find(d => d > today);
    return next || today;
  } catch(e) {
    console.error(`${symbol} getNextExpiry error:`, e.message);
    return getToday();
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync("state_v21.json","utf8")); }
  catch { return {}; }
}
function saveState(s) { fs.writeFileSync("state_v21.json", JSON.stringify(s,null,2)); }

async function tg(text, replyTo=null) {
  try {
    const body = { chat_id: PERSONAL_CHAT, text, parse_mode:"HTML" };
    if (replyTo) { body.reply_to_message_id=replyTo; body.allow_sending_without_reply=true; }
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
    });
    const d = await res.json();
    return d.result?.message_id || null;
  } catch(e) { console.error("TG:", e.message); return null; }
}

async function alpaca(path, method="GET", body=null) {
  const res = await fetchWithTimeout(`${TRADING_BASE}${path}`, {
    method, headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
      "Content-Type": "application/json"
    }, body: body ? JSON.stringify(body) : null
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

async function getBars(symbol, tf="15Min", daysBack=1) {
  try {
    const start = new Date(Date.now()-daysBack*24*60*60*1000).toISOString();
    const url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&limit=100&adjustment=raw`;
    const res = await fetchWithTimeout(url, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const text = await res.text();
    try { return JSON.parse(text).bars || []; }
    catch { console.error(`${symbol} getBars parse error:`, text.slice(0,100)); return []; }
  } catch(e) { console.error(`${symbol} getBars error:`, e.message); return []; }
}

async function getLatestPrice(symbol) {
  try {
    const r = await fetchWithTimeout(`${DATA_BASE}/stocks/${symbol}/quotes/latest`, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const d = await r.json();
    return d.quote ? (d.quote.ap + d.quote.bp) / 2 : null;
  } catch { return null; }
}

async function findOption(symbol, signal, spotPrice) {
  // 0DTE for ETFs, next available expiry for individual stocks
  const expiry = TICKERS_0DTE.includes(symbol)
    ? getToday()
    : await getNextExpiry(symbol);

  const type = signal === "CALL" ? "call" : "put";
  console.log(`${symbol}: ${type} expiry ${expiry}`);

  for (const delta of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
    const strike = Math.round(spotPrice) + delta;
    try {
      const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date=${expiry}&type=${type}&strike_price_gte=${strike-0.5}&strike_price_lte=${strike+0.5}&status=active&limit=5`;
      const res = await fetchWithTimeout(url, {
        headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
      });
      const d = await res.json();
      const contracts = d?.option_contracts || [];
      if (!contracts.length) continue;
      const contract = contracts.sort((a,b)=>Math.abs(a.strike_price-spotPrice)-Math.abs(b.strike_price-spotPrice))[0];
      const premium = await getQuote(contract.symbol);
      if (premium && premium > 0.05) return { symbol: contract.symbol, strike: contract.strike_price, premium, expiry };
    } catch(e) { console.log(`  strike ${strike}: ${e.message}`); }
  }
  return null;
}

async function getQuote(optSym) {
  try {
    const res = await fetchWithTimeout(`https://data.alpaca.markets/v1beta1/options/quotes/latest?symbols=${optSym}`, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const d = await res.json();
    const q = d.quotes?.[optSym];
    return q ? (q.ap + q.bp) / 2 : null;
  } catch { return null; }
}

function calcQty(premium) {
  return Math.max(1, Math.floor(TRADE_BUDGET / (premium * 100)));
}

// ─── BUILD OPENING RANGE FROM BARS ─────────────────────────
// Computes the 8:30-8:45 AM range from actual 15-min bar data
// This works even if the bot wasn't running during that window
async function buildRange(state, symbol) {
  const today = getToday();
  if (!state.range) state.range = {};

  // Already built for today?
  if (state.range[symbol]?.day === today &&
      state.range[symbol].high !== null &&
      state.range[symbol].low !== null) {
    console.log(`${symbol}: range already built H=${state.range[symbol].high?.toFixed(2)} L=${state.range[symbol].low?.toFixed(2)}`);
    return;
  }

  // Get today's 15-min bars
  const bars = await getBars(symbol, "15Min", 1);
  if (!bars.length) { console.log(`${symbol}: no bars available`); return; }

  // Filter bars from TODAY 8:30-8:45 AM CDT (13:30-13:45 UTC)
  const rangeBars = bars.filter(b => {
    const t = new Date(b.t);
    const barDate = t.toISOString().split("T")[0];
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    return barDate === today && m >= RANGE_START_UTC && m < RANGE_END_UTC;
  });

  // If no range bars yet (before 8:45), use all TODAY's bars so far
  const todayBars = rangeBars.length > 0 ? rangeBars : bars.filter(b => {
    const t = new Date(b.t);
    const barDate = t.toISOString().split("T")[0];
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    return barDate === today && m >= RANGE_START_UTC;
  });

  if (!todayBars.length) {
    console.log(`${symbol}: no bars in range window yet`);
    return;
  }

  const high = Math.max(...todayBars.map(b => b.h));
  const low  = Math.min(...todayBars.map(b => b.l));

  state.range[symbol] = { day: today, high, low };
  console.log(`${symbol}: range built from ${todayBars.length} bar(s) → H=${high.toFixed(2)} L=${low.toFixed(2)}`);
}

// ─── DETECT BREAKOUT ────────────────────────────────────────
async function checkBreakout(state, symbol) {
  const range = state.range?.[symbol];
  if (!range || !range.high || !range.low) {
    console.log(`${symbol}: no range built yet`);
    return null;
  }
  if (range.day !== getToday()) {
    console.log(`${symbol}: range from different day`);
    return null;
  }

  const bars = await getBars(symbol, "15Min", 1);
  if (bars.length < 2) return null;

  const lastClosed = bars[bars.length - 2];
  const priorBars  = bars.slice(-22, -2);
  const avgVol     = priorBars.length ? priorBars.reduce((a,b)=>a+b.v,0)/priorBars.length : 0;
  const volSurge   = avgVol > 0 ? lastClosed.v / avgVol : 0;
  const highVolume  = volSurge >= VOL_SURGE_RATIO;

  console.log(`${symbol}: range [${range.low.toFixed(2)}-${range.high.toFixed(2)}] | last close=${lastClosed.c.toFixed(2)} | vol×${volSurge.toFixed(2)}`);

  if (lastClosed.c > range.high && highVolume) {
    return { signal: "CALL", level: range.high, volSurge };
  }
  if (lastClosed.c < range.low && highVolume) {
    return { signal: "PUT", level: range.low, volSurge };
  }
  return null;
}

// ─── LOG TRADE OUTCOME ───────────────────────────────────────
function logTrade(pos, symbol, exitPremium, reason, fillSource) {
  try {
    const tradeId = `${symbol}_${pos.entryTime}`;
    let existing = "";
    try { existing = fs.readFileSync("outcomes_v21.jsonl", "utf8"); } catch {}
    if (existing.includes(`"tradeId":"${tradeId}"`)) {
      console.log(`logTrade: skipped duplicate ${tradeId}`);
      return false;
    }
    const pnlPct = (exitPremium - pos.entryPremium) / pos.entryPremium * 100;
    const pnl = Math.round((exitPremium - pos.entryPremium) * pos.qty * 100);
    const record = {
      day: getToday(),
      symbol,
      signal: pos.signal,
      optionSymbol: pos.optionSymbol,
      strike: pos.strike,
      tradeId,
      entryPremium: pos.entryPremium,
      exitPremium: +exitPremium.toFixed(2),
      qty: pos.qty,
      pnl,
      pnlPct: +pnlPct.toFixed(1),
      win: pnl > 0,
      reason,
      fillSource,
      entryTime: new Date(pos.entryTime).toISOString(),
      exitTime: new Date().toISOString(),
      level: pos.level,
    };
    fs.appendFileSync("outcomes_v21.jsonl", JSON.stringify(record) + "\n");
    console.log(`logged: ${symbol} ${pos.signal} ${pnlPct.toFixed(1)}% (${reason})`);
    return true;
  } catch(e) { console.error("logTrade failed:", e.message); return false; }
}

// ─── CLOSE MESSAGE TEXT ──────────────────────────────────────
function closeMessageText(reason, symbol, pos, pnlPct, pnl) {
  const sign = pnl >= 0 ? "+" : "";
  const tail = `${pnlPct.toFixed(1)}% | ${sign}$${pnl}`;
  switch (reason) {
    case "force_exit":      return `🔔 <b>خروج إجباري ${symbol}</b>\n${pos.signal} | ${tail}`;
    case "hard_stop":       return `🛑 <b>وقف خسارة ${symbol}</b>\n${tail}`;
    case "ladder_stop":     return `💰 <b>وقف ربح ${symbol}</b>\n${tail}`;
    case "structural_stop": return `🔄 <b>وقف بنيوي ${symbol}</b>\nالاختراق فشل (حجم عادي) | ${tail}`;
    case "alpaca_stop":
    case "alpaca_stop_est": return `🛑 <b>${symbol} أُقفلت (Alpaca)</b>\n${tail}`;
    default:                return `${symbol} أُغلقت (${reason})\n${tail}`;
  }
}

// ─── UNIFIED POSITION CLOSE ──────────────────────────────────
// skipSell=true is for the Alpaca-reconcile path, where the broker
// already closed the position — no cancel/sell needed, just record it.
async function closePosition(state, symbol, pos, exitPremium, reason, fillSource, skipSell = false) {
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

    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE").catch(()=>{});

    if (ownedQty === 0) {
      console.warn(`${symbol}: no position at Alpaca (already flat) — clearing local state without selling (${reason})`);
      await tg(`ℹ️ <b>${symbol}: لا يوجد مركز فعلي في Alpaca</b>\nتم تنظيف الحالة المحلية بدون إرسال أمر بيع (${reason}).`, pos.msgId);
      logTrade(pos, symbol, exitPremium, reason, fillSource);
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
  logTrade(pos, symbol, exitPremium, reason, fillSource);
  await tg(closeMessageText(reason, symbol, pos, pnlPct, pnl), pos.msgId);
  delete state[symbol];
  saveState(state);
}

// ─── UPDATE STOP ORDER ──────────────────────────────────────
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

    // Cancel old stop order
    if (pos.stopOrderId) {
      await alpaca(`/orders/${pos.stopOrderId}`, "DELETE");
      console.log(`Stop order ${pos.stopOrderId} cancelled`);
    }

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

    // Place new stop order
    const stopOrder = await alpaca("/orders", "POST", {
      symbol: pos.optionSymbol, qty: String(stopQty), side: "sell",
      type: "stop", time_in_force: "day",
      stop_price: String(Math.max(0.01, newStopPrice))
    });
    pos.stopOrderId = stopOrder.id || null;
    console.log(`New stop placed @ $${newStopPrice.toFixed(2)} (order ${pos.stopOrderId})`);
  } catch(e) { console.error("updateStopOrder failed:", e.message); }
}

// ─── PROGRESS BAR ────────────────────────────────────────────
function progressBar(pnlPct, tp1Pct=LADDER_1_PCT*3.3, maxPct=100) {
  const filled = Math.max(0, Math.min(10, Math.round((pnlPct / maxPct) * 10)));
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return bar;
}

function buildUpdateMsg(symbol, pos, pnlPct, currentPremium, ht) {
  const bar = progressBar(pnlPct);
  const sign = pnlPct >= 0 ? "+" : "";
  const pnl = Math.round((currentPremium - pos.entryPremium) * pos.qty * 100);
  const elapsed = Math.round((Date.now() - pos.entryTime) / 60000);

  // TP status
  const tp1Done = pos.ladder1 ? "✅" : `$${pos.tp1Stock?.toFixed(2) || "—"}`;
  const tp2Done = pos.ladder2 ? "✅" : `$${pos.tp2Stock?.toFixed(2) || "—"}`;
  const tp3 = `$${pos.tp3Stock?.toFixed(2) || "—"}`;

  const emoji = pnlPct >= 20 ? "🚀" : pnlPct >= 10 ? "📈" : pnlPct >= 0 ? "🟢" : pnlPct >= -15 ? "🟡" : "🔴";

  return `${symbol} ${pos.signal} $${pos.strike} ${emoji}
${bar} ${sign}${pnlPct.toFixed(1)}% | ${sign}$${pnl} | ${elapsed}m
TP1 ${tp1Done} | TP2 ${tp2Done} | TP3 ${tp3}
SL $${pos.slStock?.toFixed(2) || "—"} | $${currentPremium.toFixed(2)}/عقد`;
}

// ─── MONITOR OPEN POSITION ──────────────────────────────────
async function monitorPosition(state, symbol) {
  const pos = state[symbol];
  if (!pos?.active) return;

  const currentPremium = await getQuote(pos.optionSymbol);
  if (!currentPremium) return;

  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium * 100;
  const elapsed = Math.round((Date.now() - pos.entryTime) / 60000);
  console.log(`${symbol} [v21]: ${pos.signal} | ${pnlPct.toFixed(1)}% | ${elapsed}m`);

  // Force exit
  if (isForceExit()) {
    await closePosition(state, symbol, pos, currentPremium, "force_exit", "order_fill");
    return;
  }

  // Hard stop
  if (pnlPct <= HARD_STOP_PCT) {
    await closePosition(state, symbol, pos, currentPremium, "hard_stop", "order_fill");
    return;
  }

  // Profit ladder
  let ladderJustFired = false;
  if (pnlPct >= LADDER_2_PCT && !pos.ladder2) {
    pos.ladder2=true; pos.ladder1=true;
    pos.stopPct=LADDER_2_STOP; pos.trailPct=TRAIL_PCT;
    pos.peakPct=Math.max(pos.peakPct||0, pnlPct);
    // Update stop order to lock in +10%
    const newStop = +(pos.entryPremium * (1 + LADDER_2_STOP/100)).toFixed(2);
    await updateStopOrder(pos, newStop);
    await tg(`📈 <b>${symbol} مستوى 2</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_2_STOP}% + تريلينق ${TRAIL_PCT}%`, pos.msgId);
    ladderJustFired = true;
  }
  if (pnlPct >= LADDER_1_PCT && !pos.ladder1) {
    pos.ladder1=true; pos.stopPct=LADDER_1_STOP;
    pos.peakPct=Math.max(pos.peakPct||0, pnlPct);
    // Update stop order to lock in +5%
    const newStop = +(pos.entryPremium * (1 + LADDER_1_STOP/100)).toFixed(2);
    await updateStopOrder(pos, newStop);
    await tg(`📊 <b>${symbol} مستوى 1</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_1_STOP}%`, pos.msgId);
    ladderJustFired = true;
  }
  if (pos.trailPct) pos.peakPct = Math.max(pos.peakPct||0, pnlPct);

  // Current effective stop floor — the ladder-tightened floor once
  // profit-locking has kicked in, otherwise the original hard stop.
  // Reused below for both the close check and the near-stop warning.
  const currentStopFloor = pos.stopPct !== undefined
    ? (pos.trailPct ? pos.peakPct - pos.trailPct : pos.stopPct)
    : HARD_STOP_PCT;

  // Trail/ladder stop exit
  if (pos.stopPct !== undefined && pnlPct <= currentStopFloor) {
    await closePosition(state, symbol, pos, currentPremium, "ladder_stop", "order_fill");
    return;
  }

  // Structural stop: 15-min candle closes back inside/through range on low volume
  const bars = await getBars(symbol, "15Min", 1);
  if (bars.length >= 2) {
    const last = bars[bars.length-2];
    const priorBars = bars.slice(-22,-2);
    const avgVol = priorBars.length ? priorBars.reduce((a,b)=>a+b.v,0)/priorBars.length : 0;
    const lowVolume = avgVol > 0 && last.v < avgVol * VOL_SURGE_RATIO;
    const range = state.range?.[symbol];
    if (range) {
      const failedBreakout =
        (pos.signal==="CALL" && last.c < range.high && lowVolume) ||
        (pos.signal==="PUT"  && last.c > range.low  && lowVolume);
      if (failedBreakout) {
        await closePosition(state, symbol, pos, currentPremium, "structural_stop", "order_fill");
        return;
      }
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
  // crossing (LADDER_1_PCT/LADDER_2_PCT can land on the same band).
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
async function scanEntry(state, symbol, portfolio, liveInAlpaca) {
  if (state[symbol]?.active) return;
  if (liveInAlpaca.has(symbol)) return;
  if (isPastLastEntry()) return;
  if (isRangeBuilding()) return;

  // Daily trade limit
  const today = getToday();
  const todayTrades = (state._dailyTrades || []).filter(t => t.day === today).length;
  if (todayTrades >= MAX_DAILY_TRADES) {
    console.log(`${symbol}: max daily trades (${MAX_DAILY_TRADES}) reached`);
    return;
  }

  // Daily profit target (3-5%)
  const acct = await fetchWithTimeout(`${TRADING_BASE}/account`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
  }).then(r=>r.json());
  const lastEquity = parseFloat(acct.last_equity);
  const dailyPnl = portfolio - lastEquity;
  const targetMax = portfolio * DAILY_TARGET_MAX;
  if (isFinite(lastEquity) && lastEquity > portfolio*0.5 && dailyPnl >= targetMax) {
    console.log(`${symbol}: daily target reached ($${dailyPnl.toFixed(0)} ≥ $${targetMax.toFixed(0)})`);
    return;
  }

  // Check breakout
  const breakout = await checkBreakout(state, symbol);
  if (!breakout) return;

  const spot = await getLatestPrice(symbol);
  if (!spot) return;

  // ── HALFTREND FILTER ────────────────────────────────────────
  const bars15m = await getBars(symbol, "15Min", 3); // 3 days for enough history
  const ht = bars15m.length >= 120 ? computeHalfTrend(bars15m) : null;

  if (ht) {
    // Filter: CALL needs bullish trend (trend=0), PUT needs bearish (trend=1)
    const htOk = (breakout.signal === "CALL" && ht.trend === 0) ||
                 (breakout.signal === "PUT"  && ht.trend === 1);
    if (!htOk) {
      console.log(`${symbol}: HalfTrend مخالف (trend=${ht.trend}) — تجاهل إشارة ${breakout.signal}`);
      return;
    }
    console.log(`${symbol}: HalfTrend ✅ (trend=${ht.trend === 0 ? "صاعد" : "هابط"})`);
  }

  const opt = await findOption(symbol, breakout.signal, spot);
  if (!opt || opt.premium < 0.05) { console.log(`${symbol}: no option found`); return; }

  const qty = calcQty(opt.premium);
  const order = await alpaca("/orders","POST",{symbol:opt.symbol,qty:String(qty),side:"buy",type:"market",time_in_force:"day"});
  if (!order.id) { console.log(`${symbol}: order failed`, order); return; }

  // HalfTrend targets (on stock price)
  let targetsMsg = "";
  if (ht && ht.atr2) {
    const dist = ht.atr2 * 3; // baseRiskMult=3
    if (breakout.signal === "CALL") {
      targetsMsg = `\n🎯 أهداف السهم (HalfTrend):\n  TP1: $${(spot + dist).toFixed(2)}\n  TP2: $${(spot + dist*2).toFixed(2)}\n  TP3: $${(spot + dist*3).toFixed(2)}\n🛑 SL السهم: $${(spot - dist).toFixed(2)}`;
    } else {
      targetsMsg = `\n🎯 أهداف السهم (HalfTrend):\n  TP1: $${(spot - dist).toFixed(2)}\n  TP2: $${(spot - dist*2).toFixed(2)}\n  TP3: $${(spot - dist*3).toFixed(2)}\n🛑 SL السهم: $${(spot + dist).toFixed(2)}`;
    }
  }

  const expiryLabel = TICKERS_0DTE.includes(symbol) ? "0DTE" : `exp ${new Date(opt.expiry).toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}`;
  const entryBar = progressBar(0);
  // Build clean entry message
  const tp1 = ht?.atr2 ? (breakout.signal==="CALL" ? spot+ht.atr2*3 : spot-ht.atr2*3) : null;
  const tp2 = ht?.atr2 ? (breakout.signal==="CALL" ? spot+ht.atr2*6 : spot-ht.atr2*6) : null;
  const tp3 = ht?.atr2 ? (breakout.signal==="CALL" ? spot+ht.atr2*9 : spot-ht.atr2*9) : null;
  const sl  = ht?.atr2 ? (breakout.signal==="CALL" ? spot-ht.atr2*3 : spot+ht.atr2*3) : null;

  const tpLine = tp1 ? `TP1 $${tp1.toFixed(2)} | TP2 $${tp2.toFixed(2)} | TP3 $${tp3.toFixed(2)}` : "";
  const slLine = sl  ? `🛑 $${sl.toFixed(2)}` : "";

  const msgId = await tg(`<b>${symbol} ${breakout.signal} $${opt.strike} 🚀</b> (${expiryLabel})
💰 $${opt.premium.toFixed(2)} × ${qty} = $${(opt.premium*qty*100).toFixed(0)}
█████░░░░░ +0%
${tpLine}
${slLine}`);

  // Place hard stop loss order at -35%
  const hardStopPrice = +(opt.premium * (1 + HARD_STOP_PCT/100)).toFixed(2);
  let stopOrderId = null;
  try {
    const stopOrder = await alpaca("/orders", "POST", {
      symbol: opt.symbol, qty: String(qty), side: "sell",
      type: "stop", time_in_force: "day",
      stop_price: String(Math.max(0.01, hardStopPrice))
    });
    stopOrderId = stopOrder.id || null;
    console.log(`${symbol}: hard stop placed @ $${hardStopPrice.toFixed(2)} (order ${stopOrderId})`);
  } catch(e) { console.error(`${symbol}: stop order failed:`, e.message); }

  state[symbol] = {
    active: true, signal: breakout.signal,
    optionSymbol: opt.symbol, strike: opt.strike,
    entryPremium: opt.premium, qty,
    entryTime: Date.now(), level: breakout.level, msgId,
    stopOrderId, hardStopPrice,
    // HalfTrend stock price targets
    tp1Stock: ht?.atr2 ? (breakout.signal === "CALL" ? spot + ht.atr2*3 : spot - ht.atr2*3) : null,
    tp2Stock: ht?.atr2 ? (breakout.signal === "CALL" ? spot + ht.atr2*6 : spot - ht.atr2*6) : null,
    tp3Stock: ht?.atr2 ? (breakout.signal === "CALL" ? spot + ht.atr2*9 : spot - ht.atr2*9) : null,
    slStock:  ht?.atr2 ? (breakout.signal === "CALL" ? spot - ht.atr2*3 : spot + ht.atr2*3) : null,
  };
  if (!state._dailyTrades) state._dailyTrades = [];
  state._dailyTrades.push({ day: today, symbol, signal: breakout.signal, pnl: 0 });
  saveState(state);
  console.log(`✅ v21 ENTRY: ${symbol} ${breakout.signal} $${opt.strike} @ $${opt.premium.toFixed(2)} × ${qty}`);
}

// ─── MAIN ───────────────────────────────────────────────────
(async () => {
  console.log(`=== v21 ORB Bot started ${new Date().toISOString()} ===`);
  if (!isMarketOpen()) { console.log("Market closed"); process.exit(0); }

  const state = loadState();
  const today = getToday();

  // Reset daily trades counter each day
  if (state._lastDay !== today) {
    state._lastDay = today;
    state._dailyTrades = [];
    // Reset range
    if (state.range) {
      for (const sym of TICKERS) {
        if (state.range[sym]?.day !== today) delete state.range[sym];
      }
    }
    saveState(state);
  }

  // Reconcile with Alpaca
  const liveInAlpaca = new Set();
  try {
    const positions = await alpaca("/positions");
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        const match = pos.symbol?.match(/^([A-Z]+)\d/);
        if (match && TICKERS.includes(match[1])) {
          const sym = match[1];
          liveInAlpaca.add(sym);
          if (!state[sym]?.active) {
            state[sym] = { ...state[sym], active: true };
          }
          if (!state[sym].optionSymbol || !state[sym].entryPremium) {
            await tg(`⚠️ <b>${sym}</b>: صفقة نشطة في Alpaca (${pos.symbol}) لكن بيانات المتابعة المحلية ناقصة — تحتاج مراجعة يدوية.`, null);
          }
        }
      }
      for (const sym of TICKERS) {
        if (!liveInAlpaca.has(sym) && state[sym]?.active) {
          // Position closed in Alpaca (stop order executed) — log + notify, no new sell needed
          const pos = state[sym];
          if (pos.optionSymbol && pos.entryPremium) {
            const exitPrem = await getQuote(pos.optionSymbol);
            if (exitPrem !== null) {
              await closePosition(state, sym, pos, exitPrem, "alpaca_stop", "order_fill", true);
            } else {
              // Can't get quote — estimate from last known
              await closePosition(state, sym, pos, pos.entryPremium * 0.65, "alpaca_stop_est", "quote_estimate", true);
            }
          } else {
            delete state[sym];
          }
        }
      }
    }
    saveState(state);
  } catch(e) { console.error("Reconcile failed:", e.message); }

  // Get portfolio value
  let portfolio = 5000;
  try {
    const acctInfo = await alpaca("/account");
    portfolio = parseFloat(acctInfo.portfolio_value) || 5000;
    console.log(`Account: $${portfolio.toFixed(0)}`);
  } catch(e) { console.error("Account fetch failed:", e.message); }

  if (MODE === "monitor") {
    for (const sym of TICKERS) {
      if (state[sym]?.active) await monitorPosition(state, sym);
    }
    if (!isPastLastEntry()) {
      const freshState = loadState();
      for (const sym of TICKERS) {
        // Always try to build/verify range first
        await buildRange(freshState, sym);
        if (!freshState[sym]?.active && !liveInAlpaca.has(sym)) {
          await scanEntry(freshState, sym, portfolio, liveInAlpaca);
        }
      }
      saveState(freshState);
    }
  } else {
    for (const sym of TICKERS) {
      // Always build range from bars (works anytime after 8:30)
      await buildRange(state, sym);
      if (!state[sym]?.active && !liveInAlpaca.has(sym)) {
        await scanEntry(state, sym, portfolio, liveInAlpaca);
      }
    }
    saveState(state);
  }
  console.log("Done.");
})();
