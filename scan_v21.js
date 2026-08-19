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
    const res = await fetch(url, {
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
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
    });
    const d = await res.json();
    return d.result?.message_id || null;
  } catch(e) { console.error("TG:", e.message); return null; }
}

async function alpaca(path, method="GET", body=null) {
  const res = await fetch(`${TRADING_BASE}${path}`, {
    method, headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
      "Content-Type": "application/json"
    }, body: body ? JSON.stringify(body) : null
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
}

async function getBars(symbol, tf="15Min", daysBack=1) {
  try {
    const start = new Date(Date.now()-daysBack*24*60*60*1000).toISOString();
    const url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&limit=100&adjustment=raw`;
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const text = await res.text();
    try { return JSON.parse(text).bars || []; }
    catch { console.error(`${symbol} getBars parse error:`, text.slice(0,100)); return []; }
  } catch(e) { console.error(`${symbol} getBars error:`, e.message); return []; }
}

async function getLatestPrice(symbol) {
  try {
    const r = await fetch(`${DATA_BASE}/stocks/${symbol}/quotes/latest`, {
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
      const res = await fetch(url, {
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
    const res = await fetch(`https://data.alpaca.markets/v1beta1/options/quotes/latest?symbols=${optSym}`, {
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

// ─── UPDATE STOP ORDER ──────────────────────────────────────
async function updateStopOrder(pos, newStopPrice) {
  try {
    // Cancel old stop order
    if (pos.stopOrderId) {
      await alpaca(`/orders/${pos.stopOrderId}`, "DELETE");
      console.log(`Stop order ${pos.stopOrderId} cancelled`);
    }
    // Place new stop order
    const stopOrder = await alpaca("/orders", "POST", {
      symbol: pos.optionSymbol, qty: String(pos.qty), side: "sell",
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

  // ── UPDATE EVERY 2 MINUTES ────────────────────────────────
  const UPDATE_INTERVAL = 2 * 60 * 1000; // 2 minutes
  const now = Date.now();
  if (!pos.lastUpdate || (now - pos.lastUpdate) >= UPDATE_INTERVAL) {
    pos.lastUpdate = now;
    const updateMsg = buildUpdateMsg(symbol, pos, pnlPct, currentPremium);
    await tg(updateMsg, pos.msgId);
  }

  // Force exit
  if (isForceExit()) {
    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE").catch(()=>{});
    await alpaca("/orders","POST",{symbol:pos.optionSymbol,qty:String(pos.qty),side:"sell",type:"market",time_in_force:"day"});
    const pnl = Math.round((currentPremium-pos.entryPremium)*pos.qty*100);
    await tg(`🔔 <b>خروج إجباري ${symbol}</b>\n${pos.signal} | ${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
    delete state[symbol]; saveState(state); return;
  }

  // Hard stop
  if (pnlPct <= HARD_STOP_PCT) {
    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE").catch(()=>{});
    await alpaca("/orders","POST",{symbol:pos.optionSymbol,qty:String(pos.qty),side:"sell",type:"market",time_in_force:"day"});
    const pnl = Math.round((currentPremium-pos.entryPremium)*pos.qty*100);
    await tg(`🛑 <b>وقف خسارة ${symbol}</b>\n${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
    delete state[symbol]; saveState(state); return;
  }

  // Profit ladder
  if (pnlPct >= LADDER_2_PCT && !pos.ladder2) {
    pos.ladder2=true; pos.ladder1=true;
    pos.stopPct=LADDER_2_STOP; pos.trailPct=TRAIL_PCT;
    pos.peakPct=Math.max(pos.peakPct||0, pnlPct);
    // Update stop order to lock in +10%
    const newStop = +(pos.entryPremium * (1 + LADDER_2_STOP/100)).toFixed(2);
    await updateStopOrder(pos, newStop);
    await tg(`📈 <b>${symbol} مستوى 2</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_2_STOP}% + تريلينق ${TRAIL_PCT}%`, pos.msgId);
  }
  if (pnlPct >= LADDER_1_PCT && !pos.ladder1) {
    pos.ladder1=true; pos.stopPct=LADDER_1_STOP;
    pos.peakPct=Math.max(pos.peakPct||0, pnlPct);
    // Update stop order to lock in +5%
    const newStop = +(pos.entryPremium * (1 + LADDER_1_STOP/100)).toFixed(2);
    await updateStopOrder(pos, newStop);
    await tg(`📊 <b>${symbol} مستوى 1</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_1_STOP}%`, pos.msgId);
  }
  if (pos.trailPct) pos.peakPct = Math.max(pos.peakPct||0, pnlPct);

  // Trail/ladder stop exit
  if (pos.stopPct !== undefined) {
    const floor = pos.trailPct ? (pos.peakPct - pos.trailPct) : pos.stopPct;
    if (pnlPct <= floor) {
      await alpaca("/orders","POST",{symbol:pos.optionSymbol,qty:String(pos.qty),side:"sell",type:"market",time_in_force:"day"});
      const pnl = Math.round((currentPremium-pos.entryPremium)*pos.qty*100);
      await tg(`💰 <b>وقف ربح ${symbol}</b>\n${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
      delete state[symbol]; saveState(state); return;
    }
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
        await alpaca("/orders","POST",{symbol:pos.optionSymbol,qty:String(pos.qty),side:"sell",type:"market",time_in_force:"day"});
        const pnl = Math.round((currentPremium-pos.entryPremium)*pos.qty*100);
        await tg(`🔄 <b>وقف بنيوي ${symbol}</b>\nالاختراق فشل (حجم عادي) | ${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
        delete state[symbol]; saveState(state); return;
      }
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
  const acct = await fetch(`${TRADING_BASE}/account`, {
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
          liveInAlpaca.add(match[1]);
          if (!state[match[1]]?.active) {
            state[match[1]] = { ...state[match[1]], active: true };
          }
        }
      }
      for (const sym of TICKERS) {
        if (!liveInAlpaca.has(sym) && state[sym]?.active) {
          delete state[sym];
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
