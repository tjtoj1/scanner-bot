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
const DAILY_TARGET_MAX  = 0.05;  // 5% of portfolio
// Hard daily loss floor, in absolute dollars on realised P&L. v21 ran with
// no loss limit at all while LAB (-$1000) and WVAD (-$600) both had one, so
// a cascading day here could run unchecked. -600 matches WVAD, which shares
// v21's $500 budget and 4-trade cap: four trades stopping out at -35% is
// about -$700, so this trips only on a genuinely bad day, not a normal one.
const DAILY_LOSS_LIMIT  = -600;
// ─── TIER 1a: DAILY LOSS STOP (blocks new entries only) ───────────
// The day is down STOP_DAY_LOSS or worse on REALISED P&L. Sticky for the
// day via replay, so a later recovery does not re-open trading. It only
// ever makes scanEntry() return. Nothing here force-closes: positions
// already open are left to their own stops, which means the day's
// realised loss can overshoot STOP_DAY_LOSS by one open position's
// worth. That is accepted, deliberately.
// DAILY_LOSS_LIMIT above remains tier 2 — the wider emergency that does
// flatten (monitorPosition) — and is untouched by any of this.
const STOP_DAY_LOSS     = -280;

// ─── TIER 1b: PROFIT FLOOR on the day's TOTAL P&L ─────────────────
// Total = realised (from the outcomes log) + unrealised (summed from the
// Alpaca positions this bot manages). Once the day's total has touched
// the floor it is "armed" for the rest of the day; after that a new entry
// is admitted only if its worst case still leaves the day at or above the
// floor, and its size is cut down to fit. At exactly the floor the budget
// is zero, so nothing opens. Open positions are NEVER force-closed by
// this rule — guaranteeing the floor against open risk is phase B.
//
// profitFloor() is the seam for a future ratchet; today it ignores its
// argument and returns the constant.
//
// Arming must survive the cycle, and nothing survives in memory: the
// runner spawns a fresh `node` per bot per mode every 60s
// (runner.js:414, :501, :503). A peak reached only on unrealised P&L
// would therefore be forgotten by the next cycle, so the running maximum
// of the day's total is journaled to DAYPEAK_FILE.
const PROFIT_FLOOR_ENABLED = true;   // per-bot switch: false ⇒ gate fully inert
const PROFIT_FLOOR      = 170;       // $ total P&L
const STOP_SLIPPAGE_PAD = 0.10;      // a triggered stop is a MARKET order
const DAYPEAK_FILE      = "daypeak_v21.json";
function profitFloor(_peakTotal) { return PROFIT_FLOOR; }
const VOL_SURGE_RATIO   = 1.2;   // high volume threshold
const LADDER_1_PCT      = 10;
const LADDER_1_STOP     = 5;
const LADDER_2_PCT      = 20;
const LADDER_2_STOP     = 10;
const TRAIL_PCT         = 10;
const HARD_STOP_PCT     = -35;

// Cooldown: prevent re-entry on same symbol×signal within 30 min after losing close
const COOLDOWN_MINUTES  = 30;

// ─── SESSION TIMES, DERIVED FROM America/Chicago ──────────────────
// The session used to be hard-coded in UTC, which is correct for exactly
// half the year: on 2026-11-01 the US leaves daylight saving and the same
// constants point an hour early — range building would read pre-market
// bars and the force-exit would flatten an hour before the close.
//
// So the clock is derived from the zone instead. `Intl.DateTimeFormat`
// with a timeZone reads the system tz database, so this is correct on
// both sides of every past and future transition without a date table
// and without a dependency. scan_wvad.js has derived its RTH window this
// way since it was written; this extends the same idea to the gates.
//
// chicagoOffsetMin() returns UTC-minus-Chicago in minutes:
//   300 = CDT (UTC-5, summer)      360 = CST (UTC-6, winter)
// Both transitions happen at 02:00 local on a SUNDAY, so the answer never
// changes inside a trading session. NaN on any failure — see the startup
// assertion below, which refuses to trade on a silent fallback rather
// than guessing.
const CHI_HM = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function chicagoOffsetMin(d = new Date()) {
  try {
    const p = CHI_HM.formatToParts(d);
    const h = +p.find(x => x.type === "hour")?.value;
    const m = +p.find(x => x.type === "minute")?.value;
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
    let off = (d.getUTCHours() * 60 + d.getUTCMinutes()) - (h * 60 + m);
    if (off < 0) off += 1440;
    return off;
  } catch { return NaN; }
}
// UTC minute-of-day for h:m America/Chicago, on the day `d` falls in.
// Pass the bar's own Date when filtering historical bars, so a bar from
// the other side of a transition is judged by its own day's offset.
function chicagoToUtcMinutes(h, m, d = new Date()) {
  return (h * 60 + m + chicagoOffsetMin(d)) % 1440;
}

// Startup assertion. A container without a full tz database makes
// Intl.DateTimeFormat fall back to UTC, which would silently move every
// gate by an hour — far worse than not trading. Exit non-zero instead:
// runner.js treats a non-zero child exit as "halted, not idle" and raises
// a one-per-day Telegram alert (runner.js:509-515).
const CHI_OFFSET_AT_BOOT = chicagoOffsetMin();
if (CHI_OFFSET_AT_BOOT !== 300 && CHI_OFFSET_AT_BOOT !== 360) {
  console.error(`FATAL: America/Chicago offset resolved to ${CHI_OFFSET_AT_BOOT} `
    + `(expected 300=CDT or 360=CST) — tz database unavailable, refusing to trade.`);
  process.exit(1);
}

// Session gates, in America/Chicago wall-clock. The UTC minute each one
// resolves to shifts by 60 across the DST boundary; the local time does
// not. Range building is 8:30-8:45 local, the opening 15 minutes.
function rangeStartUtc()   { return chicagoToUtcMinutes(8, 30); }
function rangeEndUtc()     { return chicagoToUtcMinutes(8, 45); }
function lastEntryUtc()    { return chicagoToUtcMinutes(14, 30); }
function forceExitUtc()    { return chicagoToUtcMinutes(14, 55); }
function marketCloseUtc()  { return chicagoToUtcMinutes(15, 30); }

function utcMin() {
  const n = new Date();
  return n.getUTCHours() * 60 + n.getUTCMinutes();
}
function isMarketOpen() { const m=utcMin(); return m>=rangeStartUtc() && m<marketCloseUtc(); }
function isRangeBuilding() { const m=utcMin(); return m>=rangeStartUtc() && m<rangeEndUtc(); }
function isPastLastEntry() { return utcMin() >= lastEntryUtc(); }
function isForceExit() { return utcMin() >= forceExitUtc(); }
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

// Today's realised P&L, replayed trade by trade from the outcomes log —
// the same source and shape LAB's breaker uses, so the two bots measure
// the day identically. A missing or unreadable log reads as zeros, which
// fails open (keeps trading) rather than halting the bot on a filesystem
// hiccup.
//
// Returns { net, peak, stopped, reason }:
//   net     — realised P&L for today
//   peak    — the highest `net` reached at any point today
//   stopped — the loss stop became true at some point today
//   reason  — "loss" when it did, else null
//
// `stopped` is STICKY and yet nothing is persisted: realised P&L only
// changes when logTrade() appends, so replaying today's records rebuilds
// the whole day exactly — including a condition that was true at trade 3
// and false again by trade 7. That is why there is no _dayStopped flag.
// A stored flag would be lost by the boot-time `reset --hard origin/main`
// whenever the last push had not landed; a replay cannot be.
//
// Records are sorted by exitTime rather than trusted in file order:
// logTrade appends in close order, but this log has been rebuilt from a
// backup branch once already and may be re-ordered again.
function getTodayRealizedDay() {
  const today = getToday();
  const todays = [];
  try {
    const lines = fs.readFileSync("outcomes_v21.jsonl", "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { const r = JSON.parse(line); if (r.day === today) todays.push(r); } catch {}
    }
  } catch {}
  todays.sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));

  let net = 0, peak = 0, stopped = false, reason = null;
  for (const r of todays) {
    net += r.pnl;
    if (net > peak) peak = net;
    // Checked after EVERY record, so a later recovery cannot clear it.
    if (!stopped && net <= STOP_DAY_LOSS) { stopped = true; reason = "loss"; }
  }
  return { net, peak, stopped, reason };
}

// Unchanged contract for the tier-2 call sites, which only ever wanted
// the day's net.
function getTodayRealizedPnl() { return getTodayRealizedDay().net; }

// ─── OPTION EXPIRY, FROM THE OCC SYMBOL ───────────────────────────
// "SPY261020P00600000" → "2026-10-20". Used only to keep an EXPIRED
// contract out of the profit floor's unrealised sum: unrealized_pl is
// cumulative since entry, so a contract that expired days ago still
// reports a number, and counting it would move today's floor on P&L that
// is not today's. The day basis is getToday() — the same UTC date key
// logTrade writes as `day` and readDayPeak uses — so an expiry equal to
// today is kept (0DTE is the normal case here) and only strictly earlier
// expiries are dropped.
//
// Returns null when the symbol does not parse. A null is NOT excluded:
// dropping a position because its symbol looked odd would understate the
// day and could silently disarm the floor. It is counted separately and
// logged as unparsed_n so an unexpected format is visible rather than
// silent.
function optionExpiryISO(optSym) {
  const m = /^[A-Z]+(\d{6})[CP]/.exec(optSym || "");
  if (!m) return null;
  const d = m[1];
  return `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`;
}

// ─── DAY-PEAK JOURNAL (for the profit floor's arming) ─────────────
// The running maximum of the day's TOTAL P&L. Needed because the
// unrealised half cannot be replayed from anything: the runner spawns a
// fresh process per bot per mode every cycle (runner.js:414, :501, :503),
// so a peak reached only on open positions would be forgotten by the
// next cycle and the gate would go inert at exactly the wrong moment.
//
// The day key is getToday() — the SAME value logTrade writes as `day`
// (see the record built in logTrade), never a second date computation.
// A file whose day is not today is treated as a peak of 0, so a stale
// file from a previous session can never arm the floor.
//
// Every failure mode here reads the peak LOWER, which leaves the gate
// inert: permissive by design. The gate's own fail-closed behaviour (on
// an untrusted positions snapshot or a missing ask) is independent of
// this file and is not weakened by losing it.
function readDayPeak() {
  try {
    const d = JSON.parse(fs.readFileSync(DAYPEAK_FILE, "utf8"));
    if (d && d.day === getToday() && Number.isFinite(d.peakTotal)) {
      return { day: d.day, peakTotal: d.peakTotal };
    }
  } catch {}
  return { day: getToday(), peakTotal: 0 };
}

// Writes only when BOTH hold: the candidate has reached the floor, and it
// is strictly higher than what is on disk. The floor condition keeps the
// file untouched on every ordinary day, which is the point — fewer writes
// mean fewer commits for syncToGitHub to carry and less exposure to the
// line-wise `merge -X ours` recovery. The consequence to remember when
// reading logs: `peak` shows +0 until the day's total first reaches the
// floor, so a low peak does NOT mean the day never made money.
// Monotonic, so a writer never lowers the recorded peak. tmp + rename, so
// a reader never sees a torn file.
//
// Two OS processes doing read-modify-write without a lock can still lose
// an update (both read 300, one writes 390, the other 350). That is not
// claimed to be impossible — but a lost update can only ever leave the
// peak too LOW, which is the permissive direction, and the next cycle
// re-raises it. The caller restricts writing to the scan child and to a
// trusted positions snapshot, which removes the scan-vs-monitor race.
function bumpDayPeak(candidate) {
  if (!Number.isFinite(candidate)) return readDayPeak().peakTotal;
  const cur = readDayPeak();
  // Below the floor there is nothing worth journaling: arming needs a peak
  // at or above it, so a lower peak changes no decision.
  if (candidate < profitFloor(candidate)) return cur.peakTotal;
  if (candidate <= cur.peakTotal) return cur.peakTotal;
  const tmp = `${DAYPEAK_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ day: getToday(), peakTotal: candidate }));
    fs.renameSync(tmp, DAYPEAK_FILE);
    return candidate;
  } catch (e) {
    console.error(`bumpDayPeak failed (peak stays ${cur.peakTotal}):`, e.message);
    try { fs.unlinkSync(tmp); } catch {}
    return cur.peakTotal;
  }
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

// timeoutMs overrides fetchWithTimeout's own 15s default for one call.
// Only the TA2 fill lookups pass it; every existing caller keeps 15s.
async function alpaca(path, method="GET", body=null, timeoutMs=15000) {
  const res = await fetchWithTimeout(`${TRADING_BASE}${path}`, {
    method, headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
      "Content-Type": "application/json"
    }, body: body ? JSON.stringify(body) : null
  }, timeoutMs);
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

// ─── STOP-ORDER ACCEPTANCE CHECK (detection only) ────────────
// alpaca() deliberately does not check res.ok — it returns the parsed
// body whatever the status, and getOwnedQty() above depends on that
// (it reads code 40410000 out of a 404 body to mean "flat"). The side
// effect is that a REJECTED stop order (422/403) arrives as an ordinary
// object with no `id`, throws nothing, and the old `stopOrder.id || null`
// recorded it as "no stop" indistinguishably from a network failure —
// silently, with no way afterwards to tell which happened or why.
//
// These two helpers only inspect a response that was already fetched.
// They place no order, make no network call, and never throw. The POST
// call sites are untouched; only the line that extracts the id changes.

// Response body for the log, bounded. stdout only — never written to any
// file that gets committed, so nothing from the broker reaches the repo.
function brief(x, max = 500) {
  let s;
  try { s = typeof x === "string" ? x : JSON.stringify(x); } catch { s = String(x); }
  if (s == null) return "(empty)";
  return s.length > max ? s.slice(0, max) + `…[+${s.length - max} chars]` : s;
}

// Returns the order id, or null with the reason logged. Same return
// contract as the `stopOrder.id || null` it replaces.
function stopOrderIdOrNull(label, raw) {
  const id = raw && typeof raw === "object" ? raw.id : null;
  if (id) return id;
  console.error(`${label}: stop order REJECTED — no id in response. body=${brief(raw)}`);
  return null;
}

// Entry path only. Alpaca rejects a sell stop sent while our own market
// buy for the same contract is still open (code 40310000, "potential
// wash trade detected"). That rejection means NO order was created, so
// one retry after 2s cannot leave two sell orders. A thrown error
// (network/timeout) or any other code is never retried — the order may
// exist. If the retry is rejected too, both bodies go to stdout only;
// the reconcile 🛑 alert covers the missing stop.
const WASH_TRADE_CODE = 40310000;
const ENTRY_STOP_RETRY_MS = 2000;
async function postEntryStop(body) {
  const first = await alpaca("/orders", "POST", body);
  if (first?.id || first?.code !== WASH_TRADE_CODE) return first;
  await new Promise(r => setTimeout(r, ENTRY_STOP_RETRY_MS));
  let second;
  try { second = await alpaca("/orders", "POST", body); }
  catch (e) { console.log(`${body.symbol}: entry stop retry THREW after wash-trade reject. first=${brief(first)}`); throw e; }
  if (!second?.id) {
    console.log(`${body.symbol}: entry stop retry failed. first=${brief(first)} second=${brief(second)}`);
  } else {
    console.log(`${body.symbol}: entry stop placed on RETRY after wash-trade reject (order ${second.id})`);
  }
  return second;
}

// A broker timestamp, kept only if it really parses as one. Recorded for
// analysis; never compared against in any decision, so a null is harmless.
function isoOrNull(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ─── TA2: the exit price the broker actually filled at ───────
// The reconcile path only ever knew a market quote sampled when it
// noticed the position was gone; the stop had already filled, earlier,
// at a price nothing here read. Two layers, first hit wins:
//   1. GET /orders/{pos.stopOrderId} — that id is stored at entry and
//      the reconcile path never cancels it (the DELETE lives inside
//      `if (!skipSell)`), so it is still valid here.
//   2. GET /account/activities/FILL — covers a null stopOrderId (stop
//      placement failed), a manual close, or a broker liquidation.
// Returns { price, confirmed, source }:
//   confirmed=true  → price came from a filled order or fill activity
//   confirmed=false → looked and found nothing usable; price stays null
// It NEVER estimates a price, and never throws: on any error the caller
// gets the confirmed=false shape and the close proceeds untouched.
// Both calls use a 6s timeout, not the usual 15s: this runs inside the
// reconcile loop, which the runner kills at CHILD_TIMEOUT_MS (90s), and
// a slow broker must not cost the whole cycle. Worst case is 12s per
// position instead of 30s.
const FILL_LOOKUP_TIMEOUT_MS = 6000;

async function getExitFill(pos) {
  const miss = source => ({ price: null, confirmed: false, source, filledAt: null });
  // entryTime is set as Date.now() — a number (see state[symbol] in
  // scanEntry). Normalised anyway: were it ever an ISO string, the raw
  // `>= pos.entryTime` comparison below would evaluate to NaN >= … and
  // silently drop every fill, reporting "not found" for trades whose
  // fill was right there. Cheap guard against a silent-miss failure.
  const entryMs = typeof pos.entryTime === "number"
    ? pos.entryTime
    : new Date(pos.entryTime).getTime();

  // ── layer 1: the stop order we placed ──
  if (pos.stopOrderId) {
    try {
      const o = await alpaca(`/orders/${pos.stopOrderId}`, "GET", null, FILL_LOOKUP_TIMEOUT_MS);
      const px = parseFloat(o?.filled_avg_price);
      if (o?.status === "filled" && Number.isFinite(px) && px > 0) {
        const fq = parseFloat(o.filled_qty);
        if (Number.isFinite(fq) && fq === pos.qty) {
          return { price: px, confirmed: true, source: "stop_order", filledAt: isoOrNull(o.filled_at) };
        }
        // Filled, but not for the quantity we think we held. Report the
        // price and refuse to call it confirmed rather than quietly
        // pricing a different size than the one pnl is computed on.
        console.warn(`${pos.optionSymbol}: stop order filled ${fq} but local qty ${pos.qty} — not confirmed`);
        return { price: px, confirmed: false, source: "stop_order_qty_mismatch", filledAt: isoOrNull(o.filled_at) };
      }
      console.log(`${pos.optionSymbol}: stop order ${pos.stopOrderId} status=${o?.status ?? "?"} — trying layer 2`);
    } catch (e) {
      console.warn(`${pos.optionSymbol}: order lookup failed (${e.message}) — trying layer 2`);
    }
  }

  // ── layer 2: the account's own fill log ──
  // Newest first and unfiltered by symbol (the endpoint takes no symbol
  // filter), then narrowed here. 100 is far above v21's fill rate — 4
  // trades a day, 2 fills each — but it IS a bound: a fill older than
  // the newest 100 is reported as not found, never guessed at.
  try {
    const acts = await alpaca("/account/activities/FILL?direction=desc&page_size=100",
                              "GET", null, FILL_LOOKUP_TIMEOUT_MS);
    if (!Array.isArray(acts)) return miss("none");
    const mine = acts.filter(a =>
      a.symbol === pos.optionSymbol &&
      String(a.side || "").startsWith("sell") &&
      new Date(a.transaction_time).getTime() >= entryMs);
    if (!mine.length) return miss("none");

    const orders = new Set(mine.map(a => a.order_id));
    if (orders.size > 1) {
      console.warn(`${pos.optionSymbol}: ${orders.size} sell orders since entry — ambiguous, not confirmed`);
      return miss("ambiguous_multiple_orders");
    }
    const qty = mine.reduce((a, f) => a + parseFloat(f.qty), 0);
    const notional = mine.reduce((a, f) => a + parseFloat(f.price) * parseFloat(f.qty), 0);
    // The newest of the matched fills: when a stop fills in several
    // prints, that is the moment the position actually went flat.
    const lastFillAt = isoOrNull(mine.reduce((a, f) =>
      new Date(f.transaction_time).getTime() > new Date(a).getTime() ? f.transaction_time : a,
      mine[0].transaction_time));
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(notional)) return miss("none");
    const px = +(notional / qty).toFixed(4);
    if (qty !== pos.qty) {
      console.warn(`${pos.optionSymbol}: fills total ${qty} but local qty ${pos.qty} — not confirmed`);
      return { price: px, confirmed: false, source: "fill_activity_qty_mismatch", filledAt: lastFillAt };
    }
    return { price: px, confirmed: true, source: "fill_activity", filledAt: lastFillAt };
  } catch (e) {
    console.warn(`${pos.optionSymbol}: activities lookup failed (${e.message}) — no confirmed price`);
    return miss("none");
  }
}

// ─── REAL FILL PRICES — ADDITIVE ONLY ────────────────────────────────
// Reported pnl is optimistic by construction: entryPremium is the MID
// (getQuote returns (ap+bp)/2) while the entry is a MARKET buy that
// fills near the ask, and most exits are priced from a quote sampled
// when reconciliation noticed the stop had gone, not from the fill. Over
// 2026-10-19..22 that was -$240 on v21 and -$214 on LAB versus real
// equity. These lookups measure it. They ADD fields and nothing else:
// pnl, pnlPct, win, reason and fillSource are computed exactly as before,
// and no trading decision reads any of this.
//
// Every failure records null. Never a guess, never an estimate.
//
// Budgets, against runner.js's 90s child watchdog (:481) and 60s cycle
// (:118):
//   entry — ONE attempt, 4s, no retry, no sleep. It runs immediately
//           after the buy, where the order can still read "accepted", so
//           "not_ready" is an expected answer rather than a failure.
//   exit  — ONE attempt, 3s, after a fixed 1s wait for the sell to
//           settle. Runs after the sell has already been placed.
//   whole process — FILL_BUDGET_MS. Once spent, every further lookup
//           returns null with source "budget_exhausted" and makes NO
//           call, so a slow broker costs a bounded ~20s per child
//           instead of ~20s per position.
const ENTRY_FILL_TIMEOUT_MS = 4000;
const EXIT_FILL_TIMEOUT_MS  = 3000;
const EXIT_FILL_WAIT_MS     = 1000;
const FILL_BUDGET_MS        = 20000;
let fillBudgetUsedMs = 0;

const fillMiss = source => ({ price: null, confirmed: false, source, filledAt: null });

// One GET of one order. confirmed:true only when the order is filled AND
// filled_qty is the quantity this trade thinks it traded — a partial or
// mismatched fill reports its price with confirmed:false rather than
// quietly pricing a different size than pnl is computed on.
async function fillFromOrder(orderId, expectedQty, timeoutMs, okSource) {
  if (!orderId) return fillMiss("no_order_id");
  if (fillBudgetUsedMs >= FILL_BUDGET_MS) return fillMiss("budget_exhausted");
  const started = Date.now();
  try {
    const o = await alpaca(`/orders/${orderId}`, "GET", null, timeoutMs);
    // alpaca() never checks res.ok, so an error body arrives here as a
    // normal object carrying `code`. Distinguish it from a real order
    // that simply has not filled yet.
    if (o && o.code !== undefined && o.status === undefined) return fillMiss("lookup_error");
    const px = parseFloat(o?.filled_avg_price);
    if (o?.status !== "filled" || !Number.isFinite(px) || px <= 0) return fillMiss("not_ready");
    const fq = parseFloat(o.filled_qty);
    if (!Number.isFinite(fq) || fq !== expectedQty) {
      console.warn(`order ${orderId}: filled ${o.filled_qty} but expected ${expectedQty} — not confirmed`);
      return { price: px, confirmed: false, source: "qty_mismatch", filledAt: isoOrNull(o.filled_at) };
    }
    return { price: px, confirmed: true, source: okSource, filledAt: isoOrNull(o.filled_at) };
  } catch (e) {
    console.warn(`order ${orderId}: fill lookup failed (${e.message})`);
    return fillMiss("lookup_failed");
  } finally {
    fillBudgetUsedMs += Date.now() - started;
  }
}

async function getEntryFill(orderId, expectedQty) {
  return fillFromOrder(orderId, expectedQty, ENTRY_FILL_TIMEOUT_MS, "entry_order");
}

// The wait counts against the budget too: a child that has already spent
// its allowance must not even sleep.
async function getSellFill(orderId, expectedQty) {
  if (!orderId) return fillMiss("no_order_id");
  if (fillBudgetUsedMs >= FILL_BUDGET_MS) return fillMiss("budget_exhausted");
  const waitStarted = Date.now();
  await new Promise(r => setTimeout(r, EXIT_FILL_WAIT_MS));
  fillBudgetUsedMs += Date.now() - waitStarted;
  return fillFromOrder(orderId, expectedQty, EXIT_FILL_TIMEOUT_MS, "sell_order");
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

// Both legs of the quote, for the profit floor's risk arithmetic only.
// getQuote() above is left exactly as it was (it returns the mid, and
// every existing caller depends on that). This is only ever called from
// the armed branch of the floor gate, so an unarmed cycle makes no extra
// network call and behaves byte-for-byte as before.
async function getQuoteLegs(optSym) {
  try {
    const res = await fetchWithTimeout(`https://data.alpaca.markets/v1beta1/options/quotes/latest?symbols=${optSym}`, {
      headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
    });
    const d = await res.json();
    const q = d.quotes?.[optSym];
    if (!q || !Number.isFinite(q.ap) || !Number.isFinite(q.bp) || q.ap <= 0) return null;
    return { bid: q.bp, ask: q.ap, mid: (q.ap + q.bp) / 2 };
  } catch { return null; }
}

function calcQty(premium) {
  return Math.max(1, Math.floor(TRADE_BUDGET / (premium * 100)));
}

// ─── ENTRY-SNAPSHOT INDICATORS (VWAP + RSI, for later analysis only) ──
// Computed from bars already fetched for the breakout/HalfTrend checks —
// no extra network call. Never used in any entry/exit decision; purely
// recorded on the trade for the weekly deep-dive analysis planned later
// (e.g. price-vs-VWAP trend filter, RSI context).
//
// Session VWAP: cumulative (typical price × volume) over TODAY's bars
// only, up to and including the last CLOSED bar (mirrors how
// checkBreakout/computeSignal already treat "the last closed bar" as the
// decision point elsewhere in this file).
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

  // Filter bars from TODAY's opening 15 minutes, 8:30-8:45 America/Chicago.
  // Each bar is judged with the offset of its OWN timestamp, not of "now",
  // so a bar set spanning a DST transition is filtered correctly.
  const rangeBars = bars.filter(b => {
    const t = new Date(b.t);
    const barDate = t.toISOString().split("T")[0];
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    return barDate === today
      && m >= chicagoToUtcMinutes(8, 30, t) && m < chicagoToUtcMinutes(8, 45, t);
  });

  // If no range bars yet (before 8:45), use all TODAY's bars so far
  const todayBars = rangeBars.length > 0 ? rangeBars : bars.filter(b => {
    const t = new Date(b.t);
    const barDate = t.toISOString().split("T")[0];
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    return barDate === today && m >= chicagoToUtcMinutes(8, 30, t);
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
// exitStockPrice is optional (undefined for any call site that doesn't
// have it) — falls back to null so old-style callers never break.
function logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice, exitFill = null) {
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
    // P&L at the REAL fills, additive and deliberately all-or-nothing.
    // Null unless BOTH sides are real prices: a real entry fill against a
    // quoted exit is not "P&L at fill", it is the same bias measured once
    // instead of twice, and summing such records would mislead. Also null
    // on any *_est exit, whose exitPremium is an invented 65% of entry.
    const entryFillPx = typeof pos.entryFillPrice === "number" && pos.entryFillPrice > 0
      ? pos.entryFillPrice : null;
    const exitFillPx = exitFill && typeof exitFill.price === "number" && exitFill.price > 0
      ? exitFill.price : null;
    const bothReal = entryFillPx !== null && exitFillPx !== null
      && !String(reason).endsWith("_est");
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
      // Entry-snapshot indicators, for the weekly deep-dive analysis —
      // null on any trade opened before this field existed.
      entryStockPrice: pos.entryStockPrice ?? null,
      vwapAtEntry: pos.vwapAtEntry ?? null,
      rsiAtEntry: pos.rsiAtEntry ?? null,
      volumeRatio: pos.volumeRatio ?? null,
      signalType: pos.signalType ?? null,
      exitStockPrice: exitStockPrice ?? null,
      // TA2 — recorded ALONGSIDE exitPremium, never instead of it. pnl,
      // pnlPct, win, reason and fillSource above are computed exactly as
      // before. Three states, deliberately distinct:
      //   null  → this exit path never looked up a fill
      //   false → it looked and found nothing usable (price stays null)
      //   true  → exitFillPrice is what the broker actually filled at
      exitFillPrice: exitFill?.price ?? null,
      exitPriceConfirmed: exitFill ? exitFill.confirmed : null,
      exitFillSource: exitFill?.source ?? null,
      // When the broker actually filled, from the order's own filled_at
      // (or the newest matched FILL activity). exitTime above is when
      // reconciliation NOTICED — up to a full cycle later, and on 10-12
      // AMZN that gap was ~16 minutes. Analysis only; null on every
      // local exit path, which never looks a fill up.
      exitFilledAt: exitFill?.filledAt ?? null,
      // Stop-order provenance. Which stop was actually protecting the
      // position at exit could not be answered from this file before —
      // reconstructing it needed 373 revisions of state_v21.json. Pure
      // record: nothing here is read by any trading decision.
      //   ladder1/2 → whether a profit ladder had fired
      //   stopPct   → the floor in force (5 after ladder 1, 10 after 2)
      //   peakPct   → highest pnlPct any monitor cycle SAMPLED, not the
      //               market's true peak
      //   stopOrderIdAtExit → null here means the position was running
      //               with no broker-side stop at all
      ladder1: pos.ladder1 === true,
      ladder2: pos.ladder2 === true,
      stopPct: pos.stopPct ?? null,
      trailPct: pos.trailPct ?? null,
      peakPct: typeof pos.peakPct === "number" ? +pos.peakPct.toFixed(1) : null,
      stopOrderIdAtExit: pos.stopOrderId ?? null,
      hardStopPrice: pos.hardStopPrice ?? null,
      // ── FILL-ACCURATE P&L — appended LAST, on purpose ──
      // Everything above is byte-for-byte what the previous version
      // wrote. These keys go at the end so the old serialization stays a
      // literal PREFIX of the new one, which keeps logTrade's own
      // substring duplicate guard above matching exactly as before and
      // keeps test_stop_detect's prefix assertion true.
      //
      // Entry side, carried on `pos` from scanEntry's post-write amend:
      //   null  → this trade opened before the capture existed, or the
      //           lookup found nothing usable
      //   false → it looked and the price is unconfirmed (qty mismatch)
      entryFillPrice: pos.entryFillPrice ?? null,
      entryFillConfirmed: typeof pos.entryFillConfirmed === "boolean" ? pos.entryFillConfirmed : null,
      fillSourceEntry: pos.fillSourceEntry ?? null,
      entryFilledAt: pos.entryFilledAt ?? null,
      pnlAtFill: bothReal ? Math.round((exitFillPx - entryFillPx) * pos.qty * 100) : null,
      pnlPctAtFill: bothReal ? +((exitFillPx - entryFillPx) / entryFillPx * 100).toFixed(1) : null,
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
    case "daily_loss_breaker": return `🚨 <b>${symbol} إغلاق طارئ — تجاوز حد الخسارة اليومي</b>\n${tail}`;
    case "alpaca_stop":
    case "alpaca_stop_est": return `🛑 <b>${symbol} أُقفلت (Alpaca)</b>\n${tail}`;
    default:                return `${symbol} أُغلقت (${reason})\n${tail}`;
  }
}

// ─── UNIFIED POSITION CLOSE ──────────────────────────────────
// skipSell=true is for the Alpaca-reconcile path, where the broker
// already closed the position — no cancel/sell needed, just record it.
async function closePosition(state, symbol, pos, exitPremium, reason, fillSource, skipSell = false, exitFill = null) {
  // One extra lightweight quote fetch here — only when a position is
  // actually closing, not every monitor cycle — same call already used
  // once per trade at entry (getLatestPrice). Recorded for later
  // analysis only; getLatestPrice already returns null on failure, so
  // this never blocks or fails the actual close below.
  const exitStockPrice = await getLatestPrice(symbol);
  let soldQty = pos.qty;
  // The id of the sell order this function places, so its real fill can be
  // looked up after the close is already done. Stays null on the reconcile
  // path (no sell) and on every early return.
  let sellOrderId = null;
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
      logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice, exitFill);
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
    sellOrderId = order.id;
  }
  // ── the sell's REAL fill, for the five local exit paths ──
  // The reconcile path already passes exitFill in (getExitFill at the
  // call site), so it is never re-looked-up here. These five —
  // daily_loss_breaker, force_exit, hard_stop, ladder_stop,
  // structural_stop — had no fill price at all before: only 9 of 16
  // trades over 2026-10-19..22 carried one, exactly the alpaca_stop ones.
  //
  // Deliberately here and not in monitorPosition(): the sell is already
  // placed, so a slow or failed lookup costs a null field and nothing
  // else, and monitorPosition stays byte-identical for the suites that
  // pin it. Bounded at 1s wait + 3s timeout, and free once the
  // per-process budget is spent.
  if (exitFill === null && sellOrderId) {
    try {
      exitFill = await getSellFill(sellOrderId, soldQty);
      console.log(`${symbol}: sell fill ${exitFill.price ?? "n/a"} (${exitFill.source})`);
    } catch (e) {
      console.error(`${symbol}: sell fill capture failed (non-fatal):`, e.message);
    }
  }
  const pnl = Math.round((exitPremium - pos.entryPremium) * soldQty * 100);
  const pnlPct = (exitPremium - pos.entryPremium) / pos.entryPremium * 100;
  logTrade(pos, symbol, exitPremium, reason, fillSource, exitStockPrice, exitFill);

  // ─── REGISTER COOLDOWN (on losing hard_stop or alpaca_stop) ────────
  if ((reason === "hard_stop" || reason === "alpaca_stop") && pnl < 0) {
    const cooldownKey = `${symbol}_${pos.signal}`;
    state._cooldowns = state._cooldowns || {};
    state._cooldowns[cooldownKey] = new Date().toISOString();
    console.log(`Cooldown registered: ${cooldownKey} until ${new Date(Date.now() + COOLDOWN_MINUTES * 60 * 1000).toISOString()}`);
  }
  // ─── END COOLDOWN REGISTRATION ────────────────────────────────────

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
    pos.stopOrderId = stopOrderIdOrNull(`${pos.optionSymbol} ladder stop`, stopOrder);
    console.log(`New stop placed @ $${newStopPrice.toFixed(2)} (order ${pos.stopOrderId})`);
  } catch(e) { console.error("updateStopOrder THREW (network/timeout, not a rejection):", e.message); }
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

  // Daily loss circuit breaker — checked before every other exit so a
  // breached day flattens immediately rather than waiting for this
  // position's own stop. Mirrors LAB's ordering.
  if (getTodayRealizedPnl() <= DAILY_LOSS_LIMIT) {
    await closePosition(state, symbol, pos, currentPremium, "daily_loss_breaker", "order_fill");
    return;
  }

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
async function scanEntry(state, symbol, portfolio, liveInAlpaca, dayCtx) {
  if (state[symbol]?.active) return;
  if (liveInAlpaca.has(symbol)) return;
  if (isPastLastEntry()) return;
  if (isRangeBuilding()) return;

  // Daily gates, checked before any network call so a stopped day costs
  // nothing to re-evaluate each cycle. One replay of the day covers both
  // tiers: tier 1 (stop opening trades) and tier 2 (the older, wider
  // floor, whose force-close lives in monitorPosition and is untouched).
  // F2 — an untrusted positions snapshot means the day's total P&L is
  // unknowable this cycle (alpaca() does not check res.ok, so an error body
  // is indistinguishable from "flat"). While the floor is enabled we refuse
  // to open anything on a number we cannot compute, armed or not: the cost
  // is one cycle of missed entries, the cost of being wrong the other way
  // is the giveback the floor exists to prevent. Placed here, before any
  // network call, so it is also the cheapest possible refusal.
  if (PROFIT_FLOOR_ENABLED && dayCtx?.trusted === false) {
    console.log(`${symbol}: positions snapshot untrusted — skipping entry (fail closed)`);
    return;
  }

  const day = getTodayRealizedDay();
  if (day.stopped) {
    console.log(`${symbol}: day stopped (${day.reason}) — net $${day.net}, peak $${day.peak} — no new entries today`);
    return;
  }
  if (day.net <= DAILY_LOSS_LIMIT) {
    console.log(`${symbol}: daily loss limit hit ($${day.net} <= $${DAILY_LOSS_LIMIT}) — no new entries today`);
    return;
  }

  // ─── COOLDOWN CHECK (prevent re-entry chains) ───────────────
  // Compute signal first to check cooldown for this symbol×signal
  const breakout = await checkBreakout(state, symbol);
  if (!breakout) return;

  const cooldownKey = `${symbol}_${breakout.signal}`;
  if (state._cooldowns?.[cooldownKey]) {
    const cooldownTime = new Date(state._cooldowns[cooldownKey]);
    const nowTime = new Date();
    const elapsedMs = nowTime - cooldownTime;

    if (elapsedMs < COOLDOWN_MINUTES * 60 * 1000) {
      const remainingMin = Math.round((COOLDOWN_MINUTES * 60 * 1000 - elapsedMs) / 60000);
      console.log(`${symbol} ${breakout.signal}: BLOCKED by cooldown (${remainingMin}m remaining)`);
      return;
    } else {
      // Cooldown expired, clean it up
      delete state._cooldowns[cooldownKey];
      saveState(state);
    }
  }
  // ─── END COOLDOWN CHECK ────────────────────────────────────

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

  // breakout already computed in cooldown check above

  const spot = await getLatestPrice(symbol);
  if (!spot) return;

  // ── HALFTREND FILTER ────────────────────────────────────────
  const bars15m = await getBars(symbol, "15Min", 3); // 3 days for enough history
  const ht = bars15m.length >= 120 ? computeHalfTrend(bars15m) : null;

  // Entry-snapshot indicators for later analysis only (see
  // computeVWAP/computeRSI above) — reuses bars15m, no extra fetch.
  const closedBars15m = bars15m.length > 1 ? bars15m.slice(0, -1) : bars15m;
  const vwapAtEntry = computeVWAP(bars15m);
  const rsiAtEntry = computeRSI(closedBars15m.map(b => b.c));

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

  let qty = calcQty(opt.premium);

  // ─── PROFIT-FLOOR GATE ──────────────────────────────────────────
  // Armed only. An unarmed cycle reaches the buy POST with qty exactly as
  // calcQty computed it and makes no extra network call — identical to the
  // behaviour before this rule existed, EXCEPT when the positions snapshot
  // is untrusted, which the F2 guard near the top of this function now
  // refuses regardless of arming (and which PROFIT_FLOOR_ENABLED=false
  // switches off along with everything else here).
  //
  // The !trusted branch below is therefore unreachable while the F2 guard
  // stands. It is kept deliberately: it is the invariant this arithmetic
  // depends on, and it must not become reachable silently if that guard is
  // ever moved.
  //
  // Max loss per contract is measured against the stop that is ACTUALLY
  // placed below (mid-based, with the same 0.01 clamp), not against a
  // percentage of the ask: the buy fills near the ask while the stop sits
  // at a fraction of the mid, so `ask - stopPlaced` is strictly wider than
  // `ask * 0.35` whenever there is a spread. Plus a pad, because a
  // triggered stop is a market order — on 2026-10-12 AMZN filled 6% below
  // its stop.
  if (dayCtx?.armed) {
    if (!dayCtx.trusted) {
      console.log(`${symbol}: floor armed but positions snapshot untrusted — skipping entry (fail closed)`);
      return;
    }
    const legs = await getQuoteLegs(opt.symbol);
    if (!legs) {
      console.log(`${symbol}: floor armed but no ask available — skipping entry (fail closed)`);
      return;
    }
    const stopPlaced = Math.max(0.01, +(opt.premium * (1 + HARD_STOP_PCT/100)).toFixed(2));
    const maxLossPerCt = 100 * (legs.ask - stopPlaced) * (1 + STOP_SLIPPAGE_PAD);
    const allowed = maxLossPerCt > 0 ? Math.floor(dayCtx.budget / maxLossPerCt) : 0;
    const sized = Math.min(qty, allowed);
    console.log(`${symbol}: floor gate — budget $${Math.round(dayCtx.budget)}, `
      + `ask ${legs.ask.toFixed(2)}, stop ${stopPlaced.toFixed(2)}, `
      + `maxLoss/ct $${maxLossPerCt.toFixed(2)} ⇒ allowed ${allowed}, qty ${qty} → ${sized}`);
    if (!(sized >= 1)) {
      console.log(`${symbol}: not even 1 contract fits under the floor — skipping entry`);
      return;
    }
    qty = sized;
  }

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
    const stopOrder = await postEntryStop({
      symbol: opt.symbol, qty: String(qty), side: "sell",
      type: "stop", time_in_force: "day",
      stop_price: String(Math.max(0.01, hardStopPrice))
    });
    stopOrderId = stopOrderIdOrNull(`${symbol} entry stop`, stopOrder);
    if (stopOrderId) console.log(`${symbol}: hard stop placed @ $${hardStopPrice.toFixed(2)} (order ${stopOrderId})`);
  } catch(e) { console.error(`${symbol}: stop order THREW (network/timeout, not a rejection):`, e.message); }

  state[symbol] = {
    active: true, signal: breakout.signal,
    optionSymbol: opt.symbol, strike: opt.strike,
    entryPremium: opt.premium, qty,
    entryTime: Date.now(), level: breakout.level, msgId,
    stopOrderId, hardStopPrice,
    // Entry-snapshot indicators, carried through to logTrade() at exit —
    // for later analysis only, never read by any trading logic.
    entryStockPrice: spot, vwapAtEntry, rsiAtEntry,
    volumeRatio: breakout.volSurge, signalType: "breakout",
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

  // ── the entry's REAL fill, recorded STRICTLY AFTER the position is ──
  // Everything above is unchanged and already persisted: the buy, the
  // protective stop, the Telegram message and the state write all
  // completed before this runs. So a hang, a throw or a watchdog kill in
  // here cannot lose or delay the open-position record — the worst case
  // is entryFillPrice staying null on this one trade, which is exactly
  // what null means.
  //
  // The amend RE-READS the state file rather than reusing the `state`
  // object above, and this matters. saveState() is a bare
  // fs.writeFileSync of the whole file (see saveState) — no lock, no
  // temp+rename, unlike bumpDayPeak which does use temp+rename. The
  // monitor child writes the same file. Within one runner process scan
  // and monitor are sequential (runner.js awaits each in runBotCycle),
  // but two Railway replicas would overlap, and several seconds of wall
  // clock have passed since the write above — the buy, the stop POST and
  // the Telegram call. Writing back the stale in-memory object would
  // discard anything the monitor changed in that window. Re-reading
  // shrinks the read-modify-write race to microseconds.
  //
  // It is NOT a lock and does not make the write atomic. A concurrent
  // writer can still lose this amend, or this amend can still lose
  // theirs. What it cannot do is roll back seconds of state.
  // The amend is applied to BOTH objects, and both are necessary:
  //
  //   `state` — the caller's in-memory object. main() saves it once at the
  //   very end (saveState(state) in scan mode, saveState(freshState) in
  //   monitor mode, where freshState is what is passed in here). That
  //   final write is a whole-file overwrite, so without this the amend
  //   lands on disk and is then clobbered seconds later — and in scan
  //   mode the ticker loop means ONE final save would discard every
  //   ticker's amend, not just this one. entryFillPrice would be null on
  //   essentially every trade.
  //
  //   `fresh` — the file as it is right now. Needed because the caller's
  //   final save may never happen (a watchdog kill, an early return, a
  //   throw in a later ticker), and because writing back the stale
  //   in-memory object alone would discard anything the monitor changed
  //   during the seconds this lookup took.
  //
  // Each write is guarded on its own object: `state[symbol]` is what the
  // caller will persist, `fresh[symbol]` is what is on disk, and they can
  // legitimately disagree if the monitor closed the position meanwhile.
  try {
    const entryFill = await getEntryFill(order.id, qty);
    const amend = target => {
      target.entryFillPrice = entryFill.price;
      target.entryFillConfirmed = entryFill.confirmed;
      target.fillSourceEntry = entryFill.source;
      target.entryFilledAt = entryFill.filledAt;
    };
    // The caller's object, which main() will save last and therefore wins.
    if (state[symbol]?.active && state[symbol].optionSymbol === opt.symbol) {
      amend(state[symbol]);
    }
    const fresh = loadState();
    // Never resurrect a position the monitor already closed: if it is
    // gone from the file, or the symbol now holds a different contract,
    // do not write it back.
    if (fresh[symbol]?.active && fresh[symbol].optionSymbol === opt.symbol) {
      amend(fresh[symbol]);
      saveState(fresh);
      console.log(`${symbol}: entry fill ${entryFill.price ?? "n/a"} (${entryFill.source})`);
    } else {
      console.log(`${symbol}: position gone from the state file — entry fill kept in memory only (${entryFill.source})`);
    }
  } catch (e) {
    console.error(`${symbol}: entry fill capture failed (non-fatal):`, e.message);
  }
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
  const unprotected = [];   // live at Alpaca, tracked locally, no stop order id
  // Unrealised P&L for the profit floor, summed over the symbols THIS bot
  // manages — never account-level, so a ghost or a hand-opened contract
  // cannot move the floor. unrealized_pl is the number the floor uses: its
  // semantics match the realised side (both measure from entry).
  // unrealized_intraday_pl is summed only to be logged beside it for
  // comparison against live data; no decision reads it.
  let unrealPl = 0, unrealIntraday = 0;
  // Expired contracts excluded from the sums above (F1), plus any symbol
  // whose expiry could not be parsed — both reported in the log line so
  // the exclusion is never invisible.
  let exclN = 0, exclPl = 0, unparsedN = 0;
  // False whenever the snapshot is not a trustworthy array. alpaca() does
  // not check res.ok, so an error body is indistinguishable from "flat" —
  // which is exactly why the gate must fail CLOSED on this, and why the
  // peak must not be bumped from it.
  let positionsTrusted = false;
  try {
    const positions = await alpaca("/positions");
    if (Array.isArray(positions)) {
      positionsTrusted = true;
      for (const pos of positions) {
        const match = pos.symbol?.match(/^([A-Z]+)\d/);
        if (match && TICKERS.includes(match[1])) {
          const sym = match[1];
          liveInAlpaca.add(sym);
          // The ticker filter above says "a symbol this bot trades"; it does
          // NOT say "a position from today". An expired contract on a
          // managed ticker still reports a cumulative unrealized_pl, so it
          // is excluded from the floor's sums (but left alone otherwise —
          // nothing here changes reconcile or trading).
          const upl = parseFloat(pos.unrealized_pl);
          const uplIntra = parseFloat(pos.unrealized_intraday_pl);
          const expISO = optionExpiryISO(pos.symbol);
          if (expISO === null) unparsedN++;
          if (expISO !== null && expISO < getToday()) {
            exclN++;
            if (Number.isFinite(upl)) exclPl += upl;
          } else {
            if (Number.isFinite(upl)) unrealPl += upl;
            if (Number.isFinite(uplIntra)) unrealIntraday += uplIntra;
          }
          if (!state[sym]?.active) {
            state[sym] = { ...state[sym], active: true };
          }
          if (!state[sym].optionSymbol || !state[sym].entryPremium) {
            await tg(`⚠️ <b>${sym}</b>: صفقة نشطة في Alpaca (${pos.symbol}) لكن بيانات المتابعة المحلية ناقصة — تحتاج مراجعة يدوية.`, null);
          } else if (!state[sym].stopOrderId) {
            // Alpaca itself confirms this position is open, and we hold
            // no stop order id for it: nothing is protecting it
            // broker-side. Detection only — placing a replacement is
            // deliberately NOT done here.
            unprotected.push(sym);
          }
        }
      }
      // One alert per position per day, aggregated into a single message.
      // The flag MUST live in the state file, not memory: this script is a
      // short-lived child respawned twice a bot per 60s cycle, so an
      // in-memory guard (as in runner.js alertOnce) would re-send roughly
      // 390 times a day. Saved BEFORE the send, so a watchdog kill mid-send
      // costs one missed alert rather than a daily flood.
      if (unprotected.length) {
        const todayKey = getToday();
        const seen = state._noStopAlerted?.day === todayKey
          ? (state._noStopAlerted.symbols || []) : [];
        const fresh = unprotected.filter(s => !seen.includes(s));
        if (fresh.length) {
          state._noStopAlerted = { day: todayKey, symbols: [...seen, ...fresh] };
          saveState(state);
          await tg(`🛑 <b>v21: مركز بلا وقف عند الوسيط</b>\n${fresh.map(s => `${s} (${state[s].optionSymbol})`).join("\n")}\nالمركز مؤكَّد في Alpaca ولا يوجد أمر وقف محفوظ له — يحتاج مراجعة يدوية.`, null);
        }
      }
      for (const sym of TICKERS) {
        if (!liveInAlpaca.has(sym) && state[sym]?.active) {
          // Position closed in Alpaca (stop order executed) — log + notify, no new sell needed
          const pos = state[sym];
          if (pos.optionSymbol && pos.entryPremium) {
            const exitPrem = await getQuote(pos.optionSymbol);
            // TA2: ask Alpaca what the stop actually filled at. Never
            // blocks the close — getExitFill swallows every error and
            // returns confirmed:false — and never changes the pnl below.
            const exitFill = await getExitFill(pos);
            if (exitPrem !== null) {
              // NOT an order fill: exitPrem is a market quote sampled at the
              // moment reconciliation noticed the position was gone. The real
              // fill happened earlier, at Alpaca, at a price nothing here read.
              await closePosition(state, sym, pos, exitPrem, "alpaca_stop", "quote_at_detection", true, exitFill);
            } else {
              // Can't get quote — estimate from last known
              await closePosition(state, sym, pos, pos.entryPremium * 0.65, "alpaca_stop_est", "quote_estimate", true, exitFill);
            }
          } else {
            delete state[sym];
          }
        }
      }
    }
    saveState(state);
  } catch(e) { console.error("Reconcile failed:", e.message); }

  // ─── DAY CONTEXT for the profit-floor gate ──────────────────────
  // dayTotal = realised (replayed from the outcomes log) + unrealised
  // (managed positions only). The peak is journaled by the SCAN child
  // only, and only from a trusted snapshot: an untrusted one reads as
  // flat, and bumping from it would record a peak that never happened.
  const realizedDay = getTodayRealizedDay();
  const dayTotal = realizedDay.net + unrealPl;
  const peakTotal = (positionsTrusted && MODE !== "monitor")
    ? bumpDayPeak(dayTotal)
    : readDayPeak().peakTotal;
  const floorNow = profitFloor(peakTotal);
  const armed = PROFIT_FLOOR_ENABLED && (peakTotal >= floorNow || dayTotal >= floorNow);
  const dayCtx = {
    total: dayTotal, peak: peakTotal, floor: floorNow,
    armed, trusted: positionsTrusted,
    budget: Math.max(0, dayTotal - floorNow),
  };
  // One line per cycle, stdout only — enough to reconstruct every gate
  // decision afterwards without persisting anything new.
  console.log(`[v21 day] realized=${realizedDay.net >= 0 ? "+" : ""}${realizedDay.net} `
    + `unreal_pl=${unrealPl >= 0 ? "+" : ""}${Math.round(unrealPl)} `
    + `unreal_intraday=${unrealIntraday >= 0 ? "+" : ""}${Math.round(unrealIntraday)} `
    + `total=${dayTotal >= 0 ? "+" : ""}${Math.round(dayTotal)} peak=${peakTotal >= 0 ? "+" : ""}${Math.round(peakTotal)} `
    + `floor=${floorNow} enabled=${PROFIT_FLOOR_ENABLED ? "YES" : "NO"} armed=${armed ? "YES" : "NO"} `
    + `budget=${Math.round(dayCtx.budget)} trusted=${positionsTrusted ? "YES" : "NO"} `
    + `excl_n=${exclN} excl_pl=${exclPl >= 0 ? "+" : ""}${Math.round(exclPl)} unparsed_n=${unparsedN} `
    + `loss_stopped=${realizedDay.stopped ? realizedDay.reason : "no"}`);

  // Get portfolio value
  let portfolio = 5000;
  try {
    const acctInfo = await alpaca("/account");
    portfolio = parseFloat(acctInfo.portfolio_value) || 5000;
    console.log(`Account: $${portfolio.toFixed(0)}`);
  } catch(e) { console.error("Account fetch failed:", e.message); }

  // Daily loss breaker — one-time alert, so a breached day is visible
  // immediately rather than inferred from a silent absence of entries.
  const dayNow = getTodayRealizedDay();
  if (dayNow.net <= DAILY_LOSS_LIMIT && state._lossBreakerAlerted !== today) {
    state._lossBreakerAlerted = today;
    saveState(state);
    await tg(`🚨 <b>v21: تم بلوغ حد الخسارة اليومي</b>\n($${dayNow.net} ≤ $${DAILY_LOSS_LIMIT}) — إيقاف كل دخول جديد وإغلاق المراكز المفتوحة لبقية اليوم.`);
  }

  // Tier 1 — one alert per day, same pattern. Saved before the send so a
  // watchdog kill mid-send costs one missed alert, not a daily flood.
  if (dayNow.stopped && state._dayStoppedAlerted !== today) {
    state._dayStoppedAlerted = today;
    saveState(state);
    const why = `حدّ الخسارة اليومي: الصافي المحقق $${dayNow.net} ≤ $${STOP_DAY_LOSS}`;
    await tg(`⏸️ <b>v21: إيقاف الدخول لبقية اليوم</b>\n${why}\nالمراكز المفتوحة تُترك لأوقافها — لا إغلاق قسري.`);
  }

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
          await scanEntry(freshState, sym, portfolio, liveInAlpaca, dayCtx);
        }
      }
      saveState(freshState);
    }
  } else {
    for (const sym of TICKERS) {
      // Always build range from bars (works anytime after 8:30)
      await buildRange(state, sym);
      if (!state[sym]?.active && !liveInAlpaca.has(sym)) {
        await scanEntry(state, sym, portfolio, liveInAlpaca, dayCtx);
      }
    }
    saveState(state);
  }
  console.log("Done.");
})();
