// ============================================================
// BOT WVAD — WILLIAMS VARIABLE A/D PRESSURE STRATEGY
// Uses ALPACA_KEY / ALPACA_SECRET (the original idle paper account)
// Third bot — completely independent of scan_v21.js and scan_lab.js:
// its own state file, its own outcomes file, its own Alpaca account.
//
// Logic (base version of the TradingView indicator — no HTF
// confirmation, no ADX filter, no adaptive filter types):
//   1. Raw WVAD per bar = (close-open)/(high-low) * volume  (0 if h==l)
//   2. WVAD Sum   = SMA(raw, 20) * 20   ( == rolling sum of last 20 )
//   3. Signal     = SMA(WVAD Sum, 9)
//   4. LONG  (CALL): WVAD Sum crosses OVER  Signal
//      SHORT (PUT) : WVAD Sum crosses UNDER Signal
//   5. Structural stop: 1.5 * ATR(14) on the underlying, from entry
//   6. Premium stop + profit ladder: identical to v21
//   7. Reverse crossover closes the position
//
// SILENT: no per-trade Telegram message (no entry, no exit, no
// ladder). The ONLY messages this file can ever send are operational
// failures that need manual intervention (orphan position at Alpaca,
// unverifiable quantity, failed sell order). Daily performance is
// reported once by daily_report.js.
// ============================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ALPACA_KEY   = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const TG_TOKEN      = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const MODE          = process.env.MODE || "scan";
// Kill switch: set WVAD_ENABLED=0 in Railway to stop this bot within
// one cycle without a redeploy and without touching v21/LAB.
const ENABLED       = (process.env.WVAD_ENABLED ?? "1") !== "0";
const TRADING_BASE  = "https://paper-api.alpaca.markets/v2";
const DATA_BASE     = "https://data.alpaca.markets/v2";

const STATE_FILE    = "state_wvad.json";
const OUTCOMES_FILE = "outcomes_wvad.jsonl";

// Same network guard as scan_v21.js: a stalled connection with no
// response and no error would otherwise hang this process forever,
// which hangs the whole runner loop since it just awaits the child.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── CONFIG ──────────────────────────────────────────────────
const TICKERS            = ["SPY", "QQQ"];  // 0DTE only
const MAX_DTE            = 2;               // hard guard: never buy an expiry more than 2 days out

const TRADE_BUDGET       = 500;   // $ per trade                (same as v21)
const MAX_DAILY_TRADES   = 4;     // across all symbols         (same as v21)
const MAX_TRADES_PER_SYM = 2;     // NEW — only two symbols here, stop SPY eating all four
const DAILY_LOSS_LIMIT   = -600;  // NEW — v21 has no loss limit at all. Absolute $, not a
                                  // percentage: -6% of a ~$99k account would be -$5,940,
                                  // i.e. ~34 stopped-out trades — meaningless as a brake.
                                  // -$600 is ~3.4 fully stopped trades.
// NOTE: no daily PROFIT target on purpose — we have no data yet on
// whether stopping on a good day helps or hurts this strategy.

const LADDER_1_PCT       = 10;    // ladder + hard stop: identical to v21
const LADDER_1_STOP      = 5;
const LADDER_2_PCT       = 20;
const LADDER_2_STOP      = 10;
const TRAIL_PCT          = 10;
const HARD_STOP_PCT      = -35;

const ATR_PERIOD         = 14;
const ATR_STOP_MULT      = 1.5;   // structural stop on the underlying, per the indicator

const COOLDOWN_MINUTES   = 30;    // same as v21

// WVAD parameters — must match the Pine script exactly
const WVAD_LENGTH        = 20;    // SMA length for the sum
const SIGNAL_LENGTH      = 9;     // SMA length for the signal line
// First valid WVAD Sum is at index WVAD_LENGTH-1 (19); first valid
// Signal at 19 + SIGNAL_LENGTH-1 = 27; a crossover needs two
// consecutive valid points (27 and 28) => 29 closed bars minimum.
const MIN_CLOSED_BARS    = WVAD_LENGTH + SIGNAL_LENGTH;   // 29

const BAR_TF             = "15Min";
const BARS_DAYS_BACK     = 6;     // calendar days — guarantees >= 29 RTH 15m bars
const BARS_LIMIT         = 1000;  // NOT 100: v21's limit=100 silently starves its own
                                  // 120-bar HalfTrend check. Do not repeat that here.

// Session windows in UTC — kept identical to scan_v21.js and to
// runner.js's isMarketHours() so all three bots agree on when the day
// starts and ends. (These assume US DST, like the rest of the repo.)
const MARKET_OPEN_UTC    = 13 * 60 + 30; // 13:30 UTC
const MARKET_CLOSE_UTC   = 20 * 60 + 30;
const FIRST_ENTRY_UTC    = 13 * 60 + 45; // no entry on the opening bar — let one bar close
const LAST_ENTRY_UTC     = 19 * 60 + 30; // 2:30 PM CDT
const FORCE_EXIT_UTC     = 19 * 60 + 55; // 2:55 PM CDT

function utcMin() {
  const n = new Date();
  return n.getUTCHours() * 60 + n.getUTCMinutes();
}
function isMarketOpen()       { const m = utcMin(); return m >= MARKET_OPEN_UTC && m < MARKET_CLOSE_UTC; }
function isBeforeFirstEntry() { return utcMin() < FIRST_ENTRY_UTC; }
function isPastLastEntry()    { return utcMin() >= LAST_ENTRY_UTC; }
function isForceExit()        { return utcMin() >= FORCE_EXIT_UTC; }
function getToday()           { return new Date().toISOString().split("T")[0]; }

// ─── STATE ───────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ─── OPERATIONAL ALERT (NOT a trade message) ─────────────────
// This bot trades silently. alertOps() exists only for states that
// need a human: a position living at Alpaca with no local tracking
// data, a quantity we cannot verify, a sell order that did not go
// through. It is never called on entry, exit, ladder or stop.
async function alertOps(text) {
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode: "HTML" }),
    });
    const d = await res.json();
    return d.result?.message_id || null;
  } catch (e) { console.error("alertOps:", e.message); return null; }
}

// ─── ALPACA ──────────────────────────────────────────────────
async function alpaca(path, method = "GET", body = null) {
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

// Alpaca's real position is the only source of truth for how many
// contracts we may sell — never local state, which can be stale after
// a restart. Returns qty > 0, 0 (flat), or null (unknown: caller must
// NOT sell and must NOT touch the existing protective stop order).
async function getOwnedQty(optionSymbol) {
  try {
    const d = await alpaca(`/positions/${optionSymbol}`);
    if (d && typeof d.qty !== "undefined") {
      const q = Math.abs(parseInt(d.qty, 10));
      return Number.isFinite(q) ? q : null;
    }
    // A "position does not exist" response means flat, not unknown.
    const msg = typeof d === "string" ? d : JSON.stringify(d || {});
    if (/not exist|not found|404/i.test(msg)) return 0;
    return null;
  } catch (e) {
    console.error(`getOwnedQty(${optionSymbol}) failed:`, e.message);
    return null;
  }
}

// Paginated bar fetch. v21 uses limit=100 and silently truncates; this
// one follows next_page_token so the WVAD warm-up is never starved.
async function getBars(symbol, tf = BAR_TF, daysBack = BARS_DAYS_BACK) {
  const out = [];
  try {
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    let pageToken = null;
    for (let page = 0; page < 5; page++) {
      let url = `${DATA_BASE}/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&limit=${BARS_LIMIT}&adjustment=raw`;
      if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
      const res = await fetchWithTimeout(url, {
        headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
      });
      const text = await res.text();
      let d;
      try { d = JSON.parse(text); }
      catch { console.error(`${symbol} getBars parse error:`, text.slice(0, 120)); break; }
      if (Array.isArray(d.bars)) out.push(...d.bars);
      pageToken = d.next_page_token || null;
      if (!pageToken) break;
    }
  } catch (e) { console.error(`${symbol} getBars error:`, e.message); }
  return out;
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

// ─── REGULAR TRADING HOURS FILTER ────────────────────────────
// WVAD is multiplied by VOLUME, so the near-zero-volume pre/post
// market bars Alpaca returns by default would dilute the 20-period
// SMA and manufacture crossovers that do not exist on a TradingView
// regular-hours chart. Everything downstream (WVAD, signal, ATR) runs
// on RTH bars only.
//
// The 9:30-16:00 window is derived in America/New_York rather than
// hardcoded in UTC, so it stays correct across the DST switch. (The
// session gates above still use the repo-wide fixed-UTC convention so
// this bot starts and stops in lockstep with v21, LAB and runner.js.)
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
function etMinutes(date) {
  const parts = ET_FMT.formatToParts(date);
  const h = +parts.find(p => p.type === "hour").value;
  const m = +parts.find(p => p.type === "minute").value;
  return h * 60 + m;
}
function filterRTH(bars) {
  return bars.filter(b => {
    const t = etMinutes(new Date(b.t));
    return t >= 9 * 60 + 30 && t < 16 * 60;   // [09:30, 16:00) ET
  });
}

// ─── WVAD ────────────────────────────────────────────────────
// Faithful to the Pine script:
//   wvad     = (close-open)/(high-low)*volume,  0 when high == low
//   wvadSum  = ta.sma(wvad, 20) * 20   ->  mathematically identical to
//              the rolling sum of the last 20 raw values (sum/20*20).
//              Computed as the sum directly: same result, no rounding
//              drift from the divide-then-multiply round trip.
//   signal   = ta.sma(wvadSum, 9)
// Returns arrays aligned 1:1 with `bars`; entries are null until the
// window has filled, exactly like Pine's `na`.
function computeWVAD(bars) {
  const n = bars.length;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const range = b.h - b.l;
    raw[i] = range === 0 ? 0 : ((b.c - b.o) / range) * b.v;
  }

  const sum = new Array(n).fill(null);
  let running = 0;
  for (let i = 0; i < n; i++) {
    running += raw[i];
    if (i >= WVAD_LENGTH) running -= raw[i - WVAD_LENGTH];
    if (i >= WVAD_LENGTH - 1) sum[i] = running;
  }

  const sig = new Array(n).fill(null);
  let sigRunning = 0;
  for (let i = 0; i < n; i++) {
    if (sum[i] === null) continue;
    sigRunning += sum[i];
    const dropIdx = i - SIGNAL_LENGTH;
    if (dropIdx >= 0 && sum[dropIdx] !== null) sigRunning -= sum[dropIdx];
    if (i >= WVAD_LENGTH - 1 + SIGNAL_LENGTH - 1) sig[i] = sigRunning / SIGNAL_LENGTH;
  }

  return { raw, sum, sig };
}

// ATR(14) with Wilder smoothing (NOT a simple average) — matches the
// ta.atr() the indicator uses for its stop distance.
function computeATR(bars, period = ATR_PERIOD) {
  if (bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  if (tr.length < period) return null;
  let atr = tr.slice(0, period).reduce((a, x) => a + x, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

// ─── SIGNAL ──────────────────────────────────────────────────
// Decisions are made on the last CLOSED bar only (same convention as
// scan_v21.js's checkBreakout) — the forming bar is dropped, otherwise
// a crossover would flicker in and out within a single 15-minute bar.
//
// Pine's ta.crossover(a,b) is: a[1] <= b[1] && a > b   (note: <=, not <)
async function checkSignal(symbol) {
  const rth = filterRTH(await getBars(symbol));
  if (rth.length < MIN_CLOSED_BARS + 1) {
    console.log(`${symbol}: only ${rth.length} RTH bars — need ${MIN_CLOSED_BARS + 1}`);
    return null;
  }
  const closed = rth.slice(0, -1);              // drop the forming bar
  const n = closed.length;
  if (n < MIN_CLOSED_BARS) return null;

  const { sum, sig } = computeWVAD(closed);
  const curSum = sum[n - 1], curSig = sig[n - 1];
  const prevSum = sum[n - 2], prevSig = sig[n - 2];
  if (curSum === null || curSig === null || prevSum === null || prevSig === null) {
    console.log(`${symbol}: WVAD not warmed up yet`);
    return null;
  }

  const atr = computeATR(closed);
  const lastClose = closed[n - 1].c;
  console.log(`${symbol} [wvad]: sum=${curSum.toFixed(0)} sig=${curSig.toFixed(0)} | prev ${prevSum.toFixed(0)}/${prevSig.toFixed(0)} | atr=${atr ? atr.toFixed(2) : "n/a"}`);

  const crossUp   = prevSum <= prevSig && curSum >  curSig;
  const crossDown = prevSum >= prevSig && curSum <  curSig;

  if (crossUp)   return { signal: "CALL", wvadSum: curSum, signalLine: curSig, atr, lastClose };
  if (crossDown) return { signal: "PUT",  wvadSum: curSum, signalLine: curSig, atr, lastClose };
  return null;
}

// Current WVAD state without requiring a fresh crossover — used by
// monitorPosition() to detect that the signal has flipped against an
// open position.
async function currentWvadSide(symbol) {
  const rth = filterRTH(await getBars(symbol));
  if (rth.length < MIN_CLOSED_BARS + 1) return null;
  const closed = rth.slice(0, -1);
  const n = closed.length;
  const { sum, sig } = computeWVAD(closed);
  if (sum[n - 1] === null || sig[n - 1] === null) return null;
  return { side: sum[n - 1] > sig[n - 1] ? "CALL" : "PUT", lastClose: closed[n - 1].c };
}

// ─── OPTION SELECTION ────────────────────────────────────────
// 0DTE by design. If today has no listed expiry (holiday shift), fall
// back to the nearest expiry still within MAX_DTE days — never
// further. Returns null rather than reaching for a later expiry.
async function resolveExpiry(symbol) {
  const today = getToday();
  try {
    const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date_gte=${today}&status=active&limit=50&type=call`;
    const res = await fetchWithTimeout(url, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const d = await res.json();
    const dates = [...new Set((d?.option_contracts || []).map(c => c.expiration_date))].sort();
    if (!dates.length) return null;
    const msPerDay = 24 * 60 * 60 * 1000;
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    for (const dt of dates) {
      const dte = Math.round((Date.parse(`${dt}T00:00:00Z`) - todayMs) / msPerDay);
      if (dte >= 0 && dte <= MAX_DTE) return { expiry: dt, dte };
    }
    console.log(`${symbol}: no expiry within ${MAX_DTE} DTE (nearest ${dates[0]}) — skipping`);
    return null;
  } catch (e) {
    console.error(`${symbol} resolveExpiry error:`, e.message);
    return null;
  }
}

async function findOption(symbol, signal, spotPrice) {
  const exp = await resolveExpiry(symbol);
  if (!exp) return null;
  const type = signal === "CALL" ? "call" : "put";
  console.log(`${symbol}: ${type} expiry ${exp.expiry} (${exp.dte} DTE)`);

  for (const delta of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
    const strike = Math.round(spotPrice) + delta;
    try {
      const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date=${exp.expiry}&type=${type}&strike_price_gte=${strike - 0.5}&strike_price_lte=${strike + 0.5}&status=active&limit=5`;
      const res = await fetchWithTimeout(url, {
        headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
      });
      const d = await res.json();
      const contracts = d?.option_contracts || [];
      if (!contracts.length) continue;
      const contract = contracts.sort((a, b) => Math.abs(a.strike_price - spotPrice) - Math.abs(b.strike_price - spotPrice))[0];
      const premium = await getQuote(contract.symbol);
      if (premium && premium > 0.05) {
        return { symbol: contract.symbol, strike: contract.strike_price, premium, expiry: exp.expiry, dte: exp.dte };
      }
    } catch (e) { console.log(`  strike ${strike}: ${e.message}`); }
  }
  return null;
}

// ─── TRADE LOG ───────────────────────────────────────────────
// Same schema as outcomes_v21.jsonl (so daily_report.js reads it with
// the exact same helpers) plus the WVAD-specific entry snapshot.
function logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice) {
  try {
    const tradeId = `${symbol}_${pos.entryTime}`;
    let existing = "";
    try { existing = fs.readFileSync(OUTCOMES_FILE, "utf8"); } catch {}
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
      // Cost basis — daily_report.js uses this for "% of deployed capital"
      costBasis: Math.round(pos.entryPremium * pos.qty * 100),
      entryStockPrice: pos.entryStockPrice ?? null,
      exitStockPrice: exitStockPrice ?? null,
      // WVAD entry snapshot, analysis only — never read by trading logic
      wvadSumAtEntry: pos.wvadSumAtEntry ?? null,
      signalLineAtEntry: pos.signalLineAtEntry ?? null,
      atrAtEntry: pos.atrAtEntry ?? null,
      slStock: pos.slStock ?? null,
      dte: pos.dte ?? null,
      signalType: "wvad_cross",
    };
    fs.appendFileSync(OUTCOMES_FILE, JSON.stringify(record) + "\n");
    console.log(`logged: ${symbol} ${pos.signal} ${pnlPct.toFixed(1)}% (${reason})`);
    return true;
  } catch (e) { console.error("logTrade failed:", e.message); return false; }
}

// Realized PnL for today, read back from the outcomes file rather than
// held in memory — survives restarts, and is the same number the daily
// report will show.
function realizedTodayPnl() {
  try {
    const today = getToday();
    return fs.readFileSync(OUTCOMES_FILE, "utf8").split("\n")
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.day === today)
      .reduce((a, r) => a + (r.pnl || 0), 0);
  } catch { return 0; }
}

// ─── CLOSE ───────────────────────────────────────────────────
async function closePosition(state, symbol, pos, exitPremium, reason, fillSource, skipSell = false) {
  const exitStockPrice = await getLatestPrice(symbol);
  let soldQty = pos.qty;

  if (!skipSell) {
    // Verify the real quantity BEFORE cancelling the protective stop:
    // that stop order is the last line of defense for exactly the case
    // this check cannot reach Alpaca. On null, change nothing.
    const ownedQty = await getOwnedQty(pos.optionSymbol);

    if (ownedQty === null) {
      console.error(`${symbol}: could not verify owned qty — leaving stop order in place, skipping sell this cycle (${reason})`);
      await alertOps(`⚠️ <b>WVAD ${symbol}: تعذّر التحقق من الكمية في Alpaca</b>\nلم يُرسل أمر بيع (${reason})، ووقف الخسارة الحالي بقي كما هو. ستتم إعادة المحاولة الدورة القادمة.`);
      return;
    }

    if (pos.stopOrderId) await alpaca(`/orders/${pos.stopOrderId}`, "DELETE").catch(() => {});

    if (ownedQty === 0) {
      console.warn(`${symbol}: no position at Alpaca (already flat) — clearing local state (${reason})`);
      logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice);
      delete state[symbol];
      saveState(state);
      return;
    }

    if (pos.qty > ownedQty) {
      console.warn(`${symbol}: requested sell qty ${pos.qty} > owned ${ownedQty} — selling owned only (${reason})`);
      await alertOps(`⚠️ <b>WVAD ${symbol}: فرق في الكمية</b>\nالمطلوب بيعه ${pos.qty} لكن المملوك فعلياً ${ownedQty} — تم بيع ${ownedQty} فقط.`);
      soldQty = ownedQty;
    }

    const order = await alpaca("/orders", "POST", {
      symbol: pos.optionSymbol, qty: String(soldQty), side: "sell",
      type: "market", time_in_force: "day"
    });
    if (!order.id) {
      console.error(`${symbol}: close sell order failed (${reason}):`, order);
      await alertOps(`⚠️ <b>WVAD: فشل إغلاق ${symbol}</b>\nأمر البيع لم يُنفَّذ (${reason}) — يحتاج تدخلاً يدوياً.`);
      return;
    }
  }

  const pnl = Math.round((exitPremium - pos.entryPremium) * soldQty * 100);
  const pnlPct = (exitPremium - pos.entryPremium) / pos.entryPremium * 100;
  logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice);

  // Cooldown on ANY losing close, not just hard/alpaca stops as in v21.
  // The point is to break re-entry chains, and a WVAD line hovering on
  // its signal can re-cross within one or two bars after any bad exit.
  if (pnl < 0) {
    const key = `${symbol}_${pos.signal}`;
    state._cooldowns = state._cooldowns || {};
    state._cooldowns[key] = new Date().toISOString();
    console.log(`Cooldown registered: ${key} (${COOLDOWN_MINUTES}m)`);
  }

  console.log(`CLOSED ${symbol} ${pos.signal} ${pnlPct.toFixed(1)}% (${pnl >= 0 ? "+" : ""}$${pnl}) reason=${reason}`);
  delete state[symbol];
  saveState(state);
}

// ─── STOP ORDER MAINTENANCE ──────────────────────────────────
async function updateStopOrder(pos, newStopPrice) {
  try {
    // Same ordering rule as closePosition: verify first, and on an
    // unverifiable quantity leave the older, wider stop alone rather
    // than cancelling it with no replacement.
    const ownedQty = await getOwnedQty(pos.optionSymbol);
    if (ownedQty === null) {
      console.error(`updateStopOrder(${pos.optionSymbol}): unverifiable qty — leaving existing stop in place`);
      return;
    }

    if (pos.stopOrderId) {
      await alpaca(`/orders/${pos.stopOrderId}`, "DELETE");
      console.log(`Stop order ${pos.stopOrderId} cancelled`);
    }

    if (ownedQty === 0) {
      console.warn(`updateStopOrder(${pos.optionSymbol}): no position at Alpaca — skipping`);
      pos.stopOrderId = null;
      return;
    }

    let stopQty = pos.qty;
    if (stopQty > ownedQty) {
      console.warn(`updateStopOrder(${pos.optionSymbol}): qty ${stopQty} > owned ${ownedQty} — using owned`);
      stopQty = ownedQty;
    }

    const stopOrder = await alpaca("/orders", "POST", {
      symbol: pos.optionSymbol, qty: String(stopQty), side: "sell",
      type: "stop", time_in_force: "day",
      stop_price: String(Math.max(0.01, newStopPrice))
    });
    pos.stopOrderId = stopOrder.id || null;
    console.log(`New stop placed @ $${newStopPrice.toFixed(2)} (order ${pos.stopOrderId})`);
  } catch (e) { console.error("updateStopOrder failed:", e.message); }
}

// ─── MONITOR ─────────────────────────────────────────────────
async function monitorPosition(state, symbol) {
  const pos = state[symbol];
  if (!pos?.active) return;

  const currentPremium = await getQuote(pos.optionSymbol);
  if (!currentPremium) return;

  const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium * 100;
  const elapsed = Math.round((Date.now() - pos.entryTime) / 60000);
  console.log(`${symbol} [wvad]: ${pos.signal} | ${pnlPct.toFixed(1)}% | ${elapsed}m`);

  if (isForceExit()) {
    await closePosition(state, symbol, pos, currentPremium, "force_exit", "order_fill");
    return;
  }

  if (pnlPct <= HARD_STOP_PCT) {
    await closePosition(state, symbol, pos, currentPremium, "hard_stop", "order_fill");
    return;
  }

  // Profit ladder — identical to v21, just silent.
  if (pnlPct >= LADDER_2_PCT && !pos.ladder2) {
    pos.ladder2 = true; pos.ladder1 = true;
    pos.stopPct = LADDER_2_STOP; pos.trailPct = TRAIL_PCT;
    pos.peakPct = Math.max(pos.peakPct || 0, pnlPct);
    await updateStopOrder(pos, +(pos.entryPremium * (1 + LADDER_2_STOP / 100)).toFixed(2));
    console.log(`${symbol}: ladder 2 — stop +${LADDER_2_STOP}% + trail ${TRAIL_PCT}%`);
  }
  if (pnlPct >= LADDER_1_PCT && !pos.ladder1) {
    pos.ladder1 = true; pos.stopPct = LADDER_1_STOP;
    pos.peakPct = Math.max(pos.peakPct || 0, pnlPct);
    await updateStopOrder(pos, +(pos.entryPremium * (1 + LADDER_1_STOP / 100)).toFixed(2));
    console.log(`${symbol}: ladder 1 — stop +${LADDER_1_STOP}%`);
  }
  if (pos.trailPct) pos.peakPct = Math.max(pos.peakPct || 0, pnlPct);

  const currentStopFloor = pos.stopPct !== undefined
    ? (pos.trailPct ? pos.peakPct - pos.trailPct : pos.stopPct)
    : HARD_STOP_PCT;

  if (pos.stopPct !== undefined && pnlPct <= currentStopFloor) {
    await closePosition(state, symbol, pos, currentPremium, "ladder_stop", "order_fill");
    return;
  }

  // ── STRUCTURAL EXITS (on the underlying, one bar-data fetch) ──
  // 1. ATR stop: a closed 15m bar beyond entry -/+ 1.5*ATR(14)
  // 2. Reverse crossover: WVAD Sum has flipped to the other side of
  //    its signal line — the trade thesis is gone, and on 0DTE theta
  //    punishes waiting for the premium stop to catch up.
  const side = await currentWvadSide(symbol);
  if (side) {
    if (pos.slStock) {
      const hitAtrStop =
        (pos.signal === "CALL" && side.lastClose <= pos.slStock) ||
        (pos.signal === "PUT"  && side.lastClose >= pos.slStock);
      if (hitAtrStop) {
        console.log(`${symbol}: ATR stop hit (close ${side.lastClose.toFixed(2)} vs SL ${pos.slStock.toFixed(2)})`);
        await closePosition(state, symbol, pos, currentPremium, "atr_stop", "order_fill");
        return;
      }
    }
    if (side.side !== pos.signal) {
      console.log(`${symbol}: WVAD flipped to ${side.side} — closing ${pos.signal}`);
      await closePosition(state, symbol, pos, currentPremium, "reverse_signal", "order_fill");
      return;
    }
  }

  saveState(state);
}

// ─── ENTRY ───────────────────────────────────────────────────
async function scanEntry(state, symbol, liveInAlpaca) {
  if (state[symbol]?.active) return;
  if (liveInAlpaca.has(symbol)) return;
  if (isBeforeFirstEntry()) return;
  if (isPastLastEntry()) return;

  const today = getToday();

  // Daily loss limit — checked before anything expensive.
  const realized = realizedTodayPnl();
  if (realized <= DAILY_LOSS_LIMIT) {
    console.log(`${symbol}: daily loss limit hit ($${realized} <= $${DAILY_LOSS_LIMIT}) — no new entries today`);
    return;
  }

  // Trade count limits
  const todays = (state._dailyTrades || []).filter(t => t.day === today);
  if (todays.length >= MAX_DAILY_TRADES) {
    console.log(`${symbol}: max daily trades (${MAX_DAILY_TRADES}) reached`);
    return;
  }
  if (todays.filter(t => t.symbol === symbol).length >= MAX_TRADES_PER_SYM) {
    console.log(`${symbol}: max trades per symbol (${MAX_TRADES_PER_SYM}) reached`);
    return;
  }

  const sig = await checkSignal(symbol);
  if (!sig) return;

  // Cooldown on this symbol x direction
  const cooldownKey = `${symbol}_${sig.signal}`;
  if (state._cooldowns?.[cooldownKey]) {
    const elapsedMs = Date.now() - new Date(state._cooldowns[cooldownKey]).getTime();
    if (elapsedMs < COOLDOWN_MINUTES * 60 * 1000) {
      const remaining = Math.round((COOLDOWN_MINUTES * 60 * 1000 - elapsedMs) / 60000);
      console.log(`${symbol} ${sig.signal}: BLOCKED by cooldown (${remaining}m remaining)`);
      return;
    }
    delete state._cooldowns[cooldownKey];
    saveState(state);
  }

  if (!sig.atr) { console.log(`${symbol}: no ATR — skipping`); return; }

  const spot = await getLatestPrice(symbol);
  if (!spot) return;

  const opt = await findOption(symbol, sig.signal, spot);
  if (!opt || opt.premium < 0.05) { console.log(`${symbol}: no option found`); return; }

  const qty = calcQty(opt.premium);
  const order = await alpaca("/orders", "POST", {
    symbol: opt.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day"
  });
  if (!order.id) { console.log(`${symbol}: order failed`, order); return; }

  // Broker-side hard stop on the premium, placed immediately.
  const hardStopPrice = +(opt.premium * (1 + HARD_STOP_PCT / 100)).toFixed(2);
  let stopOrderId = null;
  try {
    const stopOrder = await alpaca("/orders", "POST", {
      symbol: opt.symbol, qty: String(qty), side: "sell",
      type: "stop", time_in_force: "day",
      stop_price: String(Math.max(0.01, hardStopPrice))
    });
    stopOrderId = stopOrder.id || null;
    console.log(`${symbol}: hard stop placed @ $${hardStopPrice.toFixed(2)} (order ${stopOrderId})`);
  } catch (e) { console.error(`${symbol}: stop order failed:`, e.message); }

  const slStock = sig.signal === "CALL"
    ? spot - ATR_STOP_MULT * sig.atr
    : spot + ATR_STOP_MULT * sig.atr;

  state[symbol] = {
    active: true, signal: sig.signal,
    optionSymbol: opt.symbol, strike: opt.strike,
    entryPremium: opt.premium, qty,
    entryTime: Date.now(),
    stopOrderId, hardStopPrice,
    entryStockPrice: spot,
    wvadSumAtEntry: +sig.wvadSum.toFixed(2),
    signalLineAtEntry: +sig.signalLine.toFixed(2),
    atrAtEntry: +sig.atr.toFixed(4),
    slStock: +slStock.toFixed(2),
    dte: opt.dte,
  };
  state._dailyTrades = state._dailyTrades || [];
  state._dailyTrades.push({ day: today, symbol, signal: sig.signal, pnl: 0 });
  saveState(state);
  console.log(`ENTRY [wvad]: ${symbol} ${sig.signal} $${opt.strike} @ $${opt.premium.toFixed(2)} x ${qty} | SL(stock) $${slStock.toFixed(2)}`);
}

// ─── MAIN ────────────────────────────────────────────────────
// Guarded so test_wvad.js can import the pure math functions
// (computeWVAD / computeATR / filterRTH) without this file placing a
// single order. `node scan_wvad.js` behaves exactly as before.
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export { computeWVAD, computeATR, filterRTH, etMinutes,
         WVAD_LENGTH, SIGNAL_LENGTH, MIN_CLOSED_BARS, ATR_PERIOD };

if (IS_MAIN) (async () => {
  console.log(`=== WVAD Bot started ${new Date().toISOString()} (mode=${MODE}) ===`);
  // TEMPORARY DIAGNOSTIC — remove once the env delivery question is settled.
  // Prints only the NAMES of every ALPACA* variable that actually reached
  // this process, never a value. Placed before every guard below so it
  // prints even when the bot is disabled, the market is closed, or the
  // keys arrived fine — the last case is what confirms a fix worked.
  console.log('[wvad] env keys with ALPACA:', Object.keys(process.env).filter(k => k.includes('ALPACA')).join(', '));
  if (!ENABLED) { console.log("WVAD_ENABLED=0 — bot disabled, exiting"); process.exit(0); }
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    // Same diagnostic approach runner.js already uses for GH_PUSH_TOKEN:
    // the bare "missing" message cannot distinguish a variable Railway
    // never delivered from one delivered with an empty value, and those
    // two need opposite fixes. process.env is read once at module load
    // and nothing here shadows it (no dotenv, no .env file), so what
    // prints below IS what this process sees.
    const describe = (name) => {
      const has = Object.prototype.hasOwnProperty.call(process.env, name);
      const v = process.env[name];
      if (!has) return `${name}: NOT PRESENT in process.env`;
      if (v === "") return `${name}: PRESENT but EMPTY STRING`;
      return `${name}: present, length=${v.length}, trimmedLength=${v.trim().length}`;
    };
    console.error("ALPACA_KEY / ALPACA_SECRET missing — exiting without trading");
    console.error(`  ${describe("ALPACA_KEY")}`);
    console.error(`  ${describe("ALPACA_SECRET")}`);
    // Which ALPACA_* names DID arrive? If _2/_3 are here but the bare
    // names are not, the variables exist in Railway but were not added
    // to THIS service/environment (or the deploy predates them — a plain
    // restart may not reload env vars; a full redeploy does).
    const seen = Object.keys(process.env).filter(k => k.startsWith("ALPACA")).sort();
    console.error(`  ALPACA_* visible to this process: ${seen.length ? seen.join(", ") : "(none)"}`);
    process.exit(0);
  }
  if (!isMarketOpen()) { console.log("Market closed"); process.exit(0); }

  const state = loadState();
  const today = getToday();

  if (state._lastDay !== today) {
    state._lastDay = today;
    state._dailyTrades = [];
    saveState(state);
  }

  // ── RECONCILE WITH ALPACA ──
  const liveInAlpaca = new Set();
  try {
    const positions = await alpaca("/positions");
    if (Array.isArray(positions)) {
      for (const p of positions) {
        const match = p.symbol?.match(/^([A-Z]+)\d/);
        if (match && TICKERS.includes(match[1])) {
          const sym = match[1];
          liveInAlpaca.add(sym);
          if (!state[sym]?.active) state[sym] = { ...state[sym], active: true };
          if (!state[sym].optionSymbol || !state[sym].entryPremium) {
            // The orphan-position alert — the one case where silence
            // would leave a live position nobody is managing.
            await alertOps(`⚠️ <b>WVAD ${sym}</b>: صفقة نشطة في Alpaca (${p.symbol}) لكن بيانات المتابعة المحلية ناقصة — تحتاج مراجعة يدوية.`);
          }
        }
      }
      for (const sym of TICKERS) {
        if (!liveInAlpaca.has(sym) && state[sym]?.active) {
          const pos = state[sym];
          if (pos.optionSymbol && pos.entryPremium) {
            const exitPrem = await getQuote(pos.optionSymbol);
            if (exitPrem !== null) {
              await closePosition(state, sym, pos, exitPrem, "alpaca_stop", "order_fill", true);
            } else {
              await closePosition(state, sym, pos, pos.entryPremium * 0.65, "alpaca_stop_est", "quote_estimate", true);
            }
          } else {
            delete state[sym];
          }
        }
      }
    }
    saveState(state);
  } catch (e) { console.error("Reconcile failed:", e.message); }

  try {
    const acct = await alpaca("/account");
    console.log(`Account: $${(parseFloat(acct.portfolio_value) || 0).toFixed(0)} | realized today: $${realizedTodayPnl()}`);
  } catch (e) { console.error("Account fetch failed:", e.message); }

  if (MODE === "monitor") {
    for (const sym of TICKERS) {
      if (state[sym]?.active) await monitorPosition(state, sym);
    }
    if (!isPastLastEntry()) {
      const fresh = loadState();
      for (const sym of TICKERS) {
        if (!fresh[sym]?.active && !liveInAlpaca.has(sym)) await scanEntry(fresh, sym, liveInAlpaca);
      }
      saveState(fresh);
    }
  } else {
    for (const sym of TICKERS) {
      if (!state[sym]?.active && !liveInAlpaca.has(sym)) await scanEntry(state, sym, liveInAlpaca);
    }
    saveState(state);
  }
  console.log("Done.");
})();
