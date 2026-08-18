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

const ALPACA_KEY    = process.env.ALPACA_KEY_2;
const ALPACA_SECRET = process.env.ALPACA_SECRET_2;
const TG_TOKEN      = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const MODE          = process.env.MODE || "scan";
const TRADING_BASE  = "https://paper-api.alpaca.markets/v2";
const DATA_BASE     = "https://data.alpaca.markets/v2";
const TICKERS       = ["SPY", "QQQ"];

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
  const today = getToday();
  const type = signal === "CALL" ? "call" : "put";
  for (const delta of [0, 1, -1, 2, -2, 3, -3]) {
    const strike = Math.round(spotPrice) + delta;
    try {
      const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date=${today}&type=${type}&strike_price_gte=${strike-0.5}&strike_price_lte=${strike+0.5}&status=active&limit=5`;
      const res = await fetch(url, {
        headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
      });
      const d = await res.json();
      const contracts = d?.option_contracts || [];
      if (!contracts.length) continue;
      const contract = contracts.sort((a,b)=>Math.abs(a.strike_price-spotPrice)-Math.abs(b.strike_price-spotPrice))[0];
      const premium = await getQuote(contract.symbol);
      if (premium && premium > 0.05) return { symbol: contract.symbol, strike: contract.strike_price, premium };
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

  // Filter bars from 8:30-8:45 AM CDT (13:30-13:45 UTC)
  const rangeBars = bars.filter(b => {
    const t = new Date(b.t);
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    return m >= RANGE_START_UTC && m < RANGE_END_UTC;
  });

  // If no range bars yet (before 8:45), use all bars so far today
  const todayBars = rangeBars.length > 0 ? rangeBars : bars.filter(b => {
    const t = new Date(b.t);
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    return m >= RANGE_START_UTC;
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
    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE").catch(()=>{});
    await alpaca("/orders","POST",{symbol:pos.optionSymbol,qty:String(pos.qty),side:"sell",type:"market",time_in_force:"day"});
    const pnl = Math.round((currentPremium-pos.entryPremium)*pos.qty*100);
    await tg(`🔔 <b>v21 خروج إجباري ${symbol}</b>\n${pos.signal} | ${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
    delete state[symbol]; saveState(state); return;
  }

  // Hard stop
  if (pnlPct <= HARD_STOP_PCT) {
    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE").catch(()=>{});
    await alpaca("/orders","POST",{symbol:pos.optionSymbol,qty:String(pos.qty),side:"sell",type:"market",time_in_force:"day"});
    const pnl = Math.round((currentPremium-pos.entryPremium)*pos.qty*100);
    await tg(`🛑 <b>v21 وقف خسارة ${symbol}</b>\n${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
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
    await tg(`📈 <b>v21 ${symbol} مستوى 2</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_2_STOP}% + تريلينق ${TRAIL_PCT}%`, pos.msgId);
  }
  if (pnlPct >= LADDER_1_PCT && !pos.ladder1) {
    pos.ladder1=true; pos.stopPct=LADDER_1_STOP;
    pos.peakPct=Math.max(pos.peakPct||0, pnlPct);
    // Update stop order to lock in +5%
    const newStop = +(pos.entryPremium * (1 + LADDER_1_STOP/100)).toFixed(2);
    await updateStopOrder(pos, newStop);
    await tg(`📊 <b>v21 ${symbol} مستوى 1</b>\n+${pnlPct.toFixed(1)}% | وقف +${LADDER_1_STOP}%`, pos.msgId);
  }
  if (pos.trailPct) pos.peakPct = Math.max(pos.peakPct||0, pnlPct);

  // Trail/ladder stop exit
  if (pos.stopPct !== undefined) {
    const floor = pos.trailPct ? (pos.peakPct - pos.trailPct) : pos.stopPct;
    if (pnlPct <= floor) {
      await alpaca("/orders","POST",{symbol:pos.optionSymbol,qty:String(pos.qty),side:"sell",type:"market",time_in_force:"day"});
      const pnl = Math.round((currentPremium-pos.entryPremium)*pos.qty*100);
      await tg(`💰 <b>v21 وقف ربح ${symbol}</b>\n${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
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
        await tg(`🔄 <b>v21 وقف بنيوي ${symbol}</b>\nالاختراق فشل (حجم عادي) | ${pnlPct.toFixed(1)}% | ${pnl>=0?"+":""}$${pnl}`, pos.msgId);
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

  const opt = await findOption(symbol, breakout.signal, spot);
  if (!opt || opt.premium < 0.05) { console.log(`${symbol}: no option found`); return; }

  const qty = calcQty(opt.premium);
  const order = await alpaca("/orders","POST",{symbol:opt.symbol,qty:String(qty),side:"buy",type:"market",time_in_force:"day"});
  if (!order.id) { console.log(`${symbol}: order failed`, order); return; }

  const msgId = await tg(`🚀 <b>v21 ORB ${symbol} ${breakout.signal} $${opt.strike} 0DTE</b>
💰 دخول: $${opt.premium.toFixed(2)} × ${qty}
📊 النطاق: $${state.range[symbol].low.toFixed(2)} — $${state.range[symbol].high.toFixed(2)}
📈 اختراق: $${breakout.level.toFixed(2)} | حجم ×${breakout.volSurge.toFixed(2)}
🛑 وقف: إغلاق شمعة 15د داخل النطاق + حجم عادي`);

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
