// ============================================================
// FILL-ACCURATE P&L — TEST SUITE. No network, no API keys.
//
// Every function under test is EXTRACTED BY TEXT from the real
// scan_v21.js / scan_lab.js and run against a stubbed fetcher, a stubbed
// fs and an injected clock, so the code under test is the code that
// ships. If a regex stops matching, grab() throws and the suite exits
// non-zero rather than silently testing nothing.
//
// The two bots reach the broker differently on purpose: v21 calls
// alpaca(path, "GET", null, timeoutMs), LAB calls fetchWithTimeout
// directly because alpaca() takes no timeout and must not be modified.
// Both are driven here through their own seam.
//
// What this suite is really protecting:
//   1. the lookups are BOUNDED — one attempt each, a hard per-process
//      budget, and no call at all once the budget is spent;
//   2. they NEVER throw and never return a guessed price;
//   3. pnlAtFill is all-or-nothing and null on any *_est exit;
//   4. the record stays ADDITIVE — every pre-existing field byte-identical
//      and the old serialization a literal prefix of the new one.
//
// Run:  node test_entry_fill.mjs
// ============================================================
import fs from "fs";
import { execFileSync } from "child_process";

const FILES = { v21: "scan_v21.js", lab: "scan_lab.js" };
const lf = s => s.replace(/\r\n/g, "\n");
const showAt = (sha, file) =>
  lf(execFileSync("git", ["show", `${sha}:${file}`], { maxBuffer: 1 << 28 }).toString());

// Pinned: the commit this work branched from. Used for the additive proof.
const BASE_SHA = "c93b786b797500fd405bc7ca5f25de322630bbb6";

const src = {}, base = {};
for (const [bot, file] of Object.entries(FILES)) {
  src[bot] = lf(fs.readFileSync(file, "utf8"));
  base[bot] = showAt(BASE_SHA, file);
}

const grab = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`extraction failed (${what}) — the source no longer matches this regex`);
  return m[0];
};

let pass = 0, fail = 0;
const check = (name, ok, got, want) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✔" : "✖"} ${name}`);
  if (!ok) {
    console.log(`      got:  ${typeof got === "string" ? got : JSON.stringify(got)}`);
    console.log(`      want: ${typeof want === "string" ? want : JSON.stringify(want)}`);
  }
};

function capture(fn) {
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: fn(), lines }; }
  finally { Object.assign(console, orig); }
}
async function captureAsync(fn) {
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: await fn(), lines }; }
  catch (e) { return { out: undefined, err: e, lines }; }
  finally { Object.assign(console, orig); }
}

// ════════════════════════════════════════════════════════════
// Extraction
// ════════════════════════════════════════════════════════════
const RE = {
  consts:  /const ENTRY_FILL_TIMEOUT_MS = 4000;[\s\S]*?let fillBudgetUsedMs = 0;/,
  miss:    /const fillMiss = source => \(\{ price: null, confirmed: false, source, filledAt: null \}\);/,
  isoLab:  /function fillIsoOrNull\(v\) \{[\s\S]*?\n\}/,
  fromOrd: /async function fillFromOrder\(orderId, expectedQty, timeoutMs, okSource\) \{[\s\S]*?\n\}/,
  entry:   /async function getEntryFill\(orderId, expectedQty\) \{[\s\S]*?\n\}/,
  sell:    /async function getSellFill\(orderId, expectedQty\) \{[\s\S]*?\n\}/,
  logT:    /function logTrade\(pos, symbol, exitPremium, reason, fillSource, exitStockPrice(?:, exitFill = null)?\) \{[\s\S]*?\n\}/,
  // The post-write entry amend in scanEntry, from its first comment line
  // through the catch. Pinned so its ORDER cannot drift: the whole point
  // is that it runs after saveState().
  //
  // Anchored on `} catch (e) {` rather than the first `\n  }`: the block's
  // own inner `} else {` is also at 4 spaces, so a plain non-greedy match
  // stops at the try's closing brace and silently excludes the catch —
  // which would make the "is it guarded" assertion test nothing.
  amend:   /  \/\/ ── the entry's REAL fill, recorded STRICTLY AFTER the position is ──[\s\S]*?\n  \} catch \(e\) \{\n[\s\S]*?\n  \}/,
  // closePosition's exit-fill block, anchored the same way and for the
  // same reason.
  exitBlk: /  \/\/ ── the (?:sell's REAL fill, for the five local exit paths|exit's REAL fill, per exit path) ──[\s\S]*?\n  \} catch \(e\) \{\n[\s\S]*?\n  \}/,
};

// Build the fill helpers for one bot against a stubbed transport.
//   v21 → stub alpaca(path, method, body, timeoutMs)
//   lab → stub fetchWithTimeout(url, opts, timeoutMs) returning {json()}
// `calls` records every transport call, which is how "no call once the
// budget is spent" is asserted rather than assumed.
function makeFills(bot, { responses, throwOn = null, sleepMs = null }) {
  const calls = [];
  let i = 0;
  const next = () => (Array.isArray(responses) ? responses[Math.min(i++, responses.length - 1)] : responses);

  const sleeps = [];
  // Replace the real timer so EXIT_FILL_WAIT_MS does not cost a real
  // second per case; the requested delay is recorded instead.
  const realSetTimeout = globalThis.setTimeout;
  const fakeSetTimeout = (fn, ms) => { sleeps.push(ms); return realSetTimeout(fn, 0); };

  const body = [
    grab(src[bot], RE.consts, `consts/${bot}`),
    grab(src[bot], RE.miss, `fillMiss/${bot}`),
    bot === "lab" ? grab(src[bot], RE.isoLab, `fillIsoOrNull/${bot}`) : "",
    grab(src[bot], RE.fromOrd, `fillFromOrder/${bot}`),
    grab(src[bot], RE.entry, `getEntryFill/${bot}`),
    grab(src[bot], RE.sell, `getSellFill/${bot}`),
    "return { getEntryFill, getSellFill, fillFromOrder, budget: () => fillBudgetUsedMs, FILL_BUDGET_MS, EXIT_FILL_TIMEOUT_MS };",
  ].join("\n");

  const names = bot === "v21"
    ? ["alpaca", "isoOrNull", "setTimeout", "Date"]
    : ["fetchWithTimeout", "TRADING_BASE", "HEADERS", "setTimeout", "Date"];

  const transport = async (...args) => {
    const timeoutMs = bot === "v21" ? args[3] : args[2];
    calls.push({ arg: args[0], timeoutMs });
    if (throwOn && calls.length === throwOn) throw new Error("stub transport failure");
    if (sleepMs) await new Promise(r => realSetTimeout(r, sleepMs));
    const r = next();
    return bot === "v21" ? r : { json: async () => r };
  };

  const isoOrNull = v => {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };

  const vals = bot === "v21"
    ? [transport, isoOrNull, fakeSetTimeout, Date]
    : [transport, "https://paper-api.alpaca.markets/v2", {}, fakeSetTimeout, Date];

  return { api: new Function(...names, body)(...vals), calls, sleeps };
}

const FILLED = { status: "filled", filled_avg_price: "1.07", filled_qty: "3", filled_at: "2026-10-23T14:31:02.500Z" };
const ACCEPTED = { status: "accepted", filled_avg_price: null, filled_qty: "0" };
const ERRBODY = { code: 40410000, message: "order not found" };

console.log("\n═══════════════════════════════════════════════════════════");
console.log(" FILL-ACCURATE P&L — no network, no keys");
console.log(`  pinned base: ${BASE_SHA.slice(0, 12)}`);
console.log("═══════════════════════════════════════════════════════════");

// ── 1) a confirmed fill ───────────────────────────────────
console.log("\n── 1) تعبئة مؤكَّدة ──");
for (const bot of ["v21", "lab"]) {
  const { api, calls } = makeFills(bot, { responses: FILLED });
  const r = (await captureAsync(() => api.getEntryFill("ord-1", 3))).out;
  check(`${bot}: price = 1.07`, r.price === 1.07, r.price, 1.07);
  check(`${bot}: confirmed = true`, r.confirmed === true, r.confirmed, true);
  check(`${bot}: source = entry_order`, r.source === "entry_order", r.source, "entry_order");
  check(`${bot}: filledAt منسَّق ISO`, r.filledAt === "2026-10-23T14:31:02.500Z", r.filledAt, "2026-10-23T14:31:02.500Z");
  check(`${bot}: نداء واحد فقط (بلا إعادة محاولة)`, calls.length === 1, calls.length, 1);
  check(`${bot}: مهلة الدخول 4000ms`, calls[0].timeoutMs === 4000, calls[0].timeoutMs, 4000);
}

// ── 2) ONE attempt only: never ready ⇒ never retried ──────
console.log("\n── 2) محاولة واحدة فقط ──");
for (const bot of ["v21", "lab"]) {
  const { api, calls } = makeFills(bot, { responses: ACCEPTED });
  const r = (await captureAsync(() => api.getEntryFill("ord-2", 3))).out;
  check(`${bot}: غير جاهز ⇒ price null`, r.price === null, r.price, null);
  check(`${bot}: source = not_ready`, r.source === "not_ready", r.source, "not_ready");
  check(`${bot}: confirmed = false`, r.confirmed === false, r.confirmed, false);
  check(`${bot}: نداء واحد، لا ثانٍ ولا ثالث`, calls.length === 1, calls.length, 1);
}

// ── 3) qty mismatch: price reported, NOT confirmed ────────
console.log("\n── 3) عدم تطابق الكمية ──");
for (const bot of ["v21", "lab"]) {
  const { api } = makeFills(bot, { responses: { ...FILLED, filled_qty: "2" } });
  const r = (await captureAsync(() => api.getEntryFill("ord-3", 3))).out;
  check(`${bot}: price مُبلَّغ عنه`, r.price === 1.07, r.price, 1.07);
  check(`${bot}: confirmed = false`, r.confirmed === false, r.confirmed, false);
  check(`${bot}: source = qty_mismatch`, r.source === "qty_mismatch", r.source, "qty_mismatch");
}

// ── 4) an Alpaca error body is not "not ready" ────────────
console.log("\n── 4) جسم خطأ من Alpaca ──");
for (const bot of ["v21", "lab"]) {
  const { api } = makeFills(bot, { responses: ERRBODY });
  const r = (await captureAsync(() => api.getEntryFill("ord-4", 3))).out;
  check(`${bot}: source = lookup_error (لا not_ready)`, r.source === "lookup_error", r.source, "lookup_error");
  check(`${bot}: price null`, r.price === null, r.price, null);
}

// ── 5) a throwing transport is swallowed ──────────────────
console.log("\n── 5) الناقل يرمي ⇒ لا يتسرّب الخطأ ──");
for (const bot of ["v21", "lab"]) {
  const { api } = makeFills(bot, { responses: FILLED, throwOn: 1 });
  const res = await captureAsync(() => api.getEntryFill("ord-5", 3));
  check(`${bot}: لم يُرفَع أي استثناء`, res.err === undefined, String(res.err), "no throw");
  check(`${bot}: source = lookup_failed`, res.out?.source === "lookup_failed", res.out?.source, "lookup_failed");
  check(`${bot}: price null وليس تخميناً`, res.out?.price === null, res.out?.price, null);
}

// ── 6) no order id ⇒ no call at all ───────────────────────
console.log("\n── 6) بلا رقم أمر ──");
for (const bot of ["v21", "lab"]) {
  const { api, calls } = makeFills(bot, { responses: FILLED });
  const r = (await captureAsync(() => api.getEntryFill(null, 3))).out;
  check(`${bot}: source = no_order_id`, r.source === "no_order_id", r.source, "no_order_id");
  check(`${bot}: صفر نداءات`, calls.length === 0, calls.length, 0);
}

// ── 7) the sell lookup: 1s wait then ONE 3s attempt ───────
console.log("\n── 7) تعبئة أمر البيع ──");
for (const bot of ["v21", "lab"]) {
  const { api, calls, sleeps } = makeFills(bot, { responses: FILLED });
  const r = (await captureAsync(() => api.getSellFill("sell-1", 3))).out;
  check(`${bot}: source = sell_order`, r.source === "sell_order", r.source, "sell_order");
  check(`${bot}: انتظار ثابت 1000ms مرة واحدة`, sleeps.length === 1 && sleeps[0] === 1000, sleeps, [1000]);
  check(`${bot}: مهلة الخروج 3000ms`, calls[0].timeoutMs === 3000, calls[0].timeoutMs, 3000);
  check(`${bot}: نداء واحد فقط`, calls.length === 1, calls.length, 1);
}

// ── 8) the per-process budget ─────────────────────────────
console.log("\n── 8) ميزانية العملية التراكمية ──");
for (const bot of ["v21", "lab"]) {
  // Each stubbed call burns 1.1s of real time; 20s of budget is spent
  // after ~19 of them, so the 20th must make NO call.
  const { api, calls } = makeFills(bot, { responses: FILLED, sleepMs: 1100 });
  check(`${bot}: FILL_BUDGET_MS = 20000`, api.FILL_BUDGET_MS === 20000, api.FILL_BUDGET_MS, 20000);
  let exhausted = null, callsAtExhaustion = 0;
  for (let k = 0; k < 40; k++) {
    const r = (await captureAsync(() => api.getEntryFill(`ord-b${k}`, 3))).out;
    if (r.source === "budget_exhausted") { exhausted = k; callsAtExhaustion = calls.length; break; }
  }
  check(`${bot}: الميزانية تُستنفد فعلاً`, exhausted !== null, exhausted, "a number");
  check(`${bot}: نُفدت بعد ~20s لا قبلها`, api.budget() >= 20000, api.budget(), ">= 20000");
  const before = calls.length;
  const r2 = (await captureAsync(() => api.getEntryFill("ord-after", 3))).out;
  check(`${bot}: بعد الاستنفاد — صفر نداءات إضافية`, calls.length === before, calls.length - before, 0);
  check(`${bot}: بعد الاستنفاد — source = budget_exhausted`, r2.source === "budget_exhausted", r2.source, "budget_exhausted");
  check(`${bot}: بعد الاستنفاد — price null`, r2.price === null, r2.price, null);
  // And the sell path must not even sleep once the budget is gone.
  const r3 = (await captureAsync(() => api.getSellFill("sell-after", 3))).out;
  check(`${bot}: البيع بعد الاستنفاد — لا نداء إضافي`, calls.length === before && r3.source === "budget_exhausted",
    { calls: calls.length - before, source: r3.source }, { calls: 0, source: "budget_exhausted" });
  check(`${bot}: الاستنفاد حدث بعد عدة نداءات لا من أول نداء`,
    callsAtExhaustion >= 2, callsAtExhaustion, ">= 2");
}

// ════════════════════════════════════════════════════════════
// logTrade: pnlAtFill and additivity
// ════════════════════════════════════════════════════════════
function makeLogTrade(bot, text) {
  const written = [];
  const fsStub = { readFileSync: () => "", appendFileSync: (_f, line) => written.push(line) };
  const fn = new Function("fs", "getToday",
    `${grab(text, RE.logT, `logTrade/${bot}`)}\nreturn logTrade;`)(fsStub, () => "2026-10-23");
  return { logTrade: fn, written };
}

const POS = {
  signal: "PUT", optionSymbol: "QQQ261023P00730000", strike: 730,
  entryPremium: 1.00, qty: 3, entryTime: 1791995440527, level: 731.2,
  ladder1: false, ladder2: false, stopPct: -35, peakPct: 4.2,
  stopOrderId: "a1b2c3d4-0000-1111-2222-333344445555", hardStopPrice: 0.65,
  stopLossPct: -35, entryStockPrice: 731.0, vwapAtEntry: 731.4, rsiAtEntry: 44.1,
  volumeRatio: 1.6, signalType: "breakout",
  entryConditions: { comboKey: "PUT|position:near_low" }, strategyVersion: 1,
};
const EF = { price: 0.80, confirmed: true, source: "sell_order", filledAt: "2026-10-23T15:02:11.000Z" };

console.log("\n── 9) pnlAtFill — الكل أو لا شيء ──");
for (const bot of ["v21", "lab"]) {
  const withEntry = { ...POS, entryFillPrice: 1.05, entryFillConfirmed: true, fillSourceEntry: "entry_order", entryFilledAt: "2026-10-23T14:31:02.500Z" };

  // both sides real
  let t = makeLogTrade(bot, src[bot]);
  capture(() => t.logTrade(withEntry, "QQQ", 0.82, "ladder_stop", "order_fill", 729.0, EF));
  let r = JSON.parse(t.written[0]);
  // reported pnl uses the mid entry and the quoted exit: (0.82-1.00)*3*100
  check(`${bot}: pnl المُبلَّغ لم يتغيّر (-54)`, r.pnl === -54, r.pnl, -54);
  // at the fills: (0.80-1.05)*3*100
  check(`${bot}: pnlAtFill = -75`, r.pnlAtFill === -75, r.pnlAtFill, -75);
  check(`${bot}: pnlPctAtFill = -23.8`, r.pnlPctAtFill === -23.8, r.pnlPctAtFill, -23.8);
  check(`${bot}: التعبئة الفعلية أسوأ من المُبلَّغ عنه`, r.pnlAtFill < r.pnl, { atFill: r.pnlAtFill, rep: r.pnl }, "atFill < reported");

  // entry only
  t = makeLogTrade(bot, src[bot]);
  capture(() => t.logTrade(withEntry, "QQQ", 0.82, "ladder_stop", "order_fill", 729.0, null));
  r = JSON.parse(t.written[0]);
  check(`${bot}: دخول فقط ⇒ pnlAtFill null`, r.pnlAtFill === null, r.pnlAtFill, null);
  check(`${bot}: ومع ذلك entryFillPrice مُسجَّل`, r.entryFillPrice === 1.05, r.entryFillPrice, 1.05);

  // exit only
  t = makeLogTrade(bot, src[bot]);
  capture(() => t.logTrade(POS, "QQQ", 0.82, "ladder_stop", "order_fill", 729.0, EF));
  r = JSON.parse(t.written[0]);
  check(`${bot}: خروج فقط ⇒ pnlAtFill null`, r.pnlAtFill === null, r.pnlAtFill, null);
  check(`${bot}: ومع ذلك exitFillPrice مُسجَّل`, r.exitFillPrice === 0.80, r.exitFillPrice, 0.80);

  // neither
  t = makeLogTrade(bot, src[bot]);
  capture(() => t.logTrade(POS, "QQQ", 0.82, "ladder_stop", "order_fill", 729.0, null));
  r = JSON.parse(t.written[0]);
  check(`${bot}: لا جانب ⇒ كل الحقول null`,
    r.pnlAtFill === null && r.entryFillPrice === null && r.exitFillPrice === null,
    { p: r.pnlAtFill, e: r.entryFillPrice, x: r.exitFillPrice }, "all null");
  check(`${bot}: لا NaN ولا undefined في السجل`, !/NaN|undefined/.test(t.written[0]), t.written[0].slice(0, 120), "clean");

  // *_est is never priced at fill, even with both sides present
  t = makeLogTrade(bot, src[bot]);
  capture(() => t.logTrade(withEntry, "QQQ", 0.65, "alpaca_stop_est", "quote_estimate", 729.0, EF));
  r = JSON.parse(t.written[0]);
  check(`${bot}: alpaca_stop_est ⇒ pnlAtFill null مهما توفّر`, r.pnlAtFill === null, r.pnlAtFill, null);
  check(`${bot}: alpaca_stop_est ⇒ pnlPctAtFill null`, r.pnlPctAtFill === null, r.pnlPctAtFill, null);

  // a zero / negative fill price is not a price
  t = makeLogTrade(bot, src[bot]);
  capture(() => t.logTrade({ ...withEntry, entryFillPrice: 0 }, "QQQ", 0.82, "ladder_stop", "order_fill", 729.0, EF));
  r = JSON.parse(t.written[0]);
  check(`${bot}: سعر دخول 0 لا يُعَد سعراً`, r.pnlAtFill === null, r.pnlAtFill, null);

  // unconfirmed is still recorded, with the flag false
  t = makeLogTrade(bot, src[bot]);
  capture(() => t.logTrade({ ...withEntry, entryFillConfirmed: false, fillSourceEntry: "qty_mismatch" },
    "QQQ", 0.82, "ladder_stop", "order_fill", 729.0, { ...EF, confirmed: false, source: "qty_mismatch" }));
  r = JSON.parse(t.written[0]);
  check(`${bot}: غير مؤكَّد ⇒ العلَم false لا null`,
    r.entryFillConfirmed === false && r.exitPriceConfirmed === false,
    { e: r.entryFillConfirmed, x: r.exitPriceConfirmed }, { e: false, x: false });
}

console.log("\n── 10) إضافة فقط: حقول الأساس والبادئة ──");
const recordKeys = {};
for (const bot of ["v21", "lab"]) {
  const RealDate = globalThis.Date;
  const FROZEN = 1792000000000;
  globalThis.Date = class extends RealDate {
    constructor(...a) { a.length ? super(...a) : super(FROZEN); }
    static now() { return FROZEN; }
  };
  try {
    const withEntry = { ...POS, entryFillPrice: 1.05, entryFillConfirmed: true, fillSourceEntry: "entry_order", entryFilledAt: "2026-10-23T14:31:02.500Z" };
    const a = makeLogTrade(bot, src[bot]), b = makeLogTrade(bot, base[bot]);
    const args = [withEntry, "QQQ", 0.82, "ladder_stop", "order_fill", 729.0, EF];
    capture(() => a.logTrade(...args));
    capture(() => b.logTrade(...args));
    const rNew = JSON.parse(a.written[0]), rOld = JSON.parse(b.written[0]);
    const changed = Object.keys(rOld).filter(k => JSON.stringify(rOld[k]) !== JSON.stringify(rNew[k]));
    check(`${bot}: لا حقل من حقول ${BASE_SHA.slice(0, 8)} تغيّر (${Object.keys(rOld).length} حقلاً)`,
      changed.length === 0, changed, []);
    const oldPrefix = b.written[0].trimEnd().replace(/\}$/, "");
    check(`${bot}: سطر الأساس بادئة حرفية للجديد (حارس التكرار)`,
      a.written[0].startsWith(oldPrefix), a.written[0].slice(0, 80) + "…", oldPrefix.slice(0, 80) + "…");
    check(`${bot}: الحقول الجديدة كلها بعد hardStopPrice`,
      a.written[0].indexOf('"entryFillPrice"') > a.written[0].indexOf('"hardStopPrice"'),
      "out of order", "appended");
    for (const k of ["pnl", "pnlPct", "win", "reason", "fillSource", "exitPremium", "entryPremium"]) {
      check(`${bot}: ${k} مطابق تماماً (${JSON.stringify(rNew[k])})`,
        JSON.stringify(rOld[k]) === JSON.stringify(rNew[k]), rNew[k], rOld[k]);
    }
    const NEW_KEYS = ["entryFillPrice", "entryFillConfirmed", "fillSourceEntry", "entryFilledAt",
                      "exitFillPrice", "exitPriceConfirmed", "exitFillSource", "exitFilledAt",
                      "pnlAtFill", "pnlPctAtFill"];
    check(`${bot}: كل الحقول العشرة موجودة`, NEW_KEYS.every(k => k in rNew),
      NEW_KEYS.filter(k => !(k in rNew)), []);
    recordKeys[bot] = Object.keys(rNew).filter(k => NEW_KEYS.includes(k));
  } finally { globalThis.Date = RealDate; }
}
// One analysis must read both bots, so the new keys must be spelled
// identically in each. Asserted from the records themselves, not from the
// NEW_KEYS list, which both sides would otherwise trivially pass.
//
// SET equality, not sequence: v21's four exit* fields already existed and
// sit before hardStopPrice, while LAB's are new and appended after it.
// Aligning the order would mean moving v21's existing keys, which would
// change a pre-existing record's serialization and break the prefix
// guarantee this suite also asserts. Every reader looks fields up by
// name, so order carries no meaning — only the spelling does.
check("أسماء الحقول الجديدة متطابقة بين البوتين (كمجموعة)",
  JSON.stringify([...recordKeys.v21].sort()) === JSON.stringify([...recordKeys.lab].sort()),
  { onlyV21: recordKeys.v21.filter(k => !recordKeys.lab.includes(k)),
    onlyLab: recordKeys.lab.filter(k => !recordKeys.v21.includes(k)) }, "same set");
check("v21: الحقول الأربعة للخروج كانت موجودة سابقاً (قبل hardStopPrice)",
  recordKeys.v21.indexOf("exitFillPrice") < recordKeys.v21.indexOf("entryFillPrice"),
  recordKeys.v21, "exit* first in v21");

// ── 11) ordering inside the source: the amend runs AFTER saveState ──
console.log("\n── 11) ترتيب الاستدعاء في المصدر ──");
for (const bot of ["v21", "lab"]) {
  const text = src[bot];
  const amend = grab(text, RE.amend, `amend/${bot}`);
  const amendAt = text.indexOf(amend);
  // The last saveState(state) before the amend, and the ENTRY log line.
  const entryLog = text.indexOf(bot === "v21" ? "✅ v21 ENTRY:" : "✅ LAB ENTRY:");
  check(`${bot}: تعديل الحالة بعد سطر "ENTRY" (أي بعد saveState)`, amendAt > entryLog, { amendAt, entryLog }, "amend after");
  check(`${bot}: التعديل داخل try/catch`, /^\s*try \{/m.test(amend) && /catch \(e\)/.test(amend), "unguarded", "guarded");
  check(`${bot}: التعديل يعيد قراءة الملف (loadState)`, /const fresh = loadState\(\);/.test(amend), "reuses stale object", "re-reads");
  check(`${bot}: لا يُحيي مركزاً أُغلق`, /fresh\[symbol\]\?\.active/.test(amend), "no guard", "guarded");
  // `= (?!=)` on purpose: a bare `\w+ =` also matches the `=== ` in the
  // guard condition `fresh[symbol].optionSymbol === opt.symbol`, which
  // reads nothing and assigns nothing.
  const writes = amend.match(/fresh\[symbol\]\.\w+ = (?!=)/g) || [];
  check(`${bot}: لا يكتب إلا مفاتيح التعبئة الأربعة`, writes.length === 4, writes, 4);
  // getEntryFill must be awaited before loadState, so a hang cannot hold a
  // stale snapshot open across the lookup.
  check(`${bot}: البحث قبل القراءة الجديدة`,
    amend.indexOf("await getEntryFill") < amend.indexOf("loadState()"), "wrong order", "lookup first");
}

// ── 12) closePosition's exit block, per path ──────────────
console.log("\n── 12) كتلة الخروج في closePosition ──");
{
  const v = grab(src.v21, RE.exitBlk, "exitBlk/v21");
  check("v21: لا يعيد البحث إن وُرِّد exitFill (مسار المطابقة)", /exitFill === null/.test(v), v.slice(0, 60), "guards on null");
  check("v21: يستعمل getSellFill", /getSellFill\(sellOrderId, soldQty\)/.test(v), "missing", "present");
  check("v21: الكتلة داخل try/catch", /try \{/.test(v) && /catch \(e\)/.test(v), "unguarded", "guarded");
  const l = grab(src.lab, RE.exitBlk, "exitBlk/lab");
  check("lab: بيع ⇒ getSellFill", /if \(sellOrderId\) exitFill = await getSellFill\(sellOrderId, soldQty\);/.test(l), "missing", "present");
  check("lab: alpaca_stop ⇒ أمر الوقف المحفوظ", /reason === "alpaca_stop" && pos\.stopOrderId/.test(l), "missing", "present");
  check("lab: alpaca_stop_est ⇒ لا بحث إطلاقاً", !/alpaca_stop_est/.test(l.replace(/\/\/[^\n]*/g, "")), "looks it up", "no lookup");
  check("lab: الكتلة داخل try/catch", /try \{/.test(l) && /catch \(e\)/.test(l), "unguarded", "guarded");
  // Neither block may live inside monitorPosition, which the other suites pin.
  for (const bot of ["v21", "lab"]) {
    const mp = grab(src[bot], /async function monitorPosition\([\s\S]*?\n\}/, `mp/${bot}`);
    check(`${bot}: monitorPosition لا يعرف شيئاً عن التعبئة`,
      !/getSellFill|getEntryFill|fillFromOrder|entryFillPrice/.test(mp), "knows", "clean");
  }
}

// ── 13) daily_report: the second line ─────────────────────
console.log("\n── 13) سطر daily_report الثاني ──");
{
  const rep = lf(fs.readFileSync("daily_report.js", "utf8"));
  const fn = grab(rep, /function fillLine\(rows\) \{[\s\S]*?\n\}/, "fillLine");
  const fillLine = new Function(`${fn}\nreturn fillLine;`)();
  check("تغطية صفر ⇒ سطر فارغ تماماً",
    fillLine([{ pnl: 10, pnlAtFill: null }, { pnl: -5, pnlAtFill: null }]) === "", "prints something", "");
  check("مصفوفة فارغة ⇒ سطر فارغ", fillLine([]) === "", "prints something", "");
  const out = fillLine([{ pnl: 10, pnlAtFill: 4 }, { pnl: -5, pnlAtFill: -9 }, { pnl: 3, pnlAtFill: null }]);
  check("يجمع الصفوف المتوفّرة فقط (4 + -9 = -5)", out.includes("$-5"), out, "$-5");
  check("يعرض التغطية صراحةً (2 من 3)", /2 من 3/.test(out), out, "2 من 3");
  check("إشارة + للأرباح", fillLine([{ pnl: 1, pnlAtFill: 7 }]).includes("+$7"), fillLine([{ pnl: 1, pnlAtFill: 7 }]), "+$7");
  // The existing net line must be untouched.
  const netLine = /msg \+= `📋 \$\{s\.n\} صفقة \| WR \$\{s\.wr\}% \| صافي \$\{s\.net>=0\?"\+":""\}\$\$\{s\.net\}\\n`;/;
  check("سطر الصافي الحالي بلا تغيير", netLine.test(rep), "changed", "identical");
  check("stats\\(\\) بلا تغيير", grab(rep, /function stats\(rows\) \{[\s\S]*?\n\}/, "stats")
    === grab(showAt(BASE_SHA, "daily_report.js"), /function stats\(rows\) \{[\s\S]*?\n\}/, "stats base"), "changed", "identical");
  check("pctLine\\(\\) بلا تغيير", grab(rep, /function pctLine\(rows, portfolioValue\) \{[\s\S]*?\n\}/, "pctLine")
    === grab(showAt(BASE_SHA, "daily_report.js"), /function pctLine\(rows, portfolioValue\) \{[\s\S]*?\n\}/, "pctLine base"), "changed", "identical");
}

// ── 14) real history still reads identically ──────────────
console.log("\n── 14) السجل الحقيقي يُقرأ كما كان ──");
{
  // Every existing record lacks the new fields. daily_report's own
  // computations must give byte-identical answers over them, and the new
  // line must stay silent for every historical day.
  const rep = lf(fs.readFileSync("daily_report.js", "utf8"));
  const statsFn = new Function(`${grab(rep, /function stats\(rows\) \{[\s\S]*?\n\}/, "stats")}\nreturn stats;`)();
  const fillFn = new Function(`${grab(rep, /function fillLine\(rows\) \{[\s\S]*?\n\}/, "fillLine")}\nreturn fillLine;`)();
  for (const [bot, file] of [["v21", "outcomes_v21.jsonl"], ["lab", "outcomes_lab.jsonl"]]) {
    const rows = showAt(BASE_SHA, file).split("\n").filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const s = statsFn(rows);
    check(`${bot}: ${rows.length} سجلاً تاريخياً — stats تعمل`, s.n === rows.length, s.n, rows.length);
    check(`${bot}: لا سجل تاريخي يحمل pnlAtFill`,
      rows.every(r => r.pnlAtFill === undefined), rows.filter(r => r.pnlAtFill !== undefined).length, 0);
    check(`${bot}: السطر الجديد صامت على التاريخ كله`, fillFn(rows) === "", fillFn(rows), "");
    // And adding the fields to a copy changes none of the old stats.
    const augmented = rows.map(r => ({ ...r, entryFillPrice: null, exitFillPrice: null, pnlAtFill: null, pnlPctAtFill: null }));
    const s2 = statsFn(augmented);
    check(`${bot}: إضافة الحقول لا تغيّر n/wr/net`,
      s.n === s2.n && s.wr === s2.wr && s.net === s2.net, s2, s);
  }
}

// ── 15) no new field feeds any decision ───────────────────
console.log("\n── 15) لا حقل جديد يغذّي قراراً ──");
for (const bot of ["v21", "lab"]) {
  const text = src[bot];
  // The pnl/pnlPct computations must not mention a fill price.
  const pnlLines = text.split("\n").filter(l => /const pnl(Pct)? =/.test(l) && !/AtFill/.test(l));
  check(`${bot}: حسابات pnl لا تذكر أي سعر تعبئة`,
    pnlLines.every(l => !/FillP|FillPrice|entryFillPx|exitFillPx/.test(l)), pnlLines, "clean");
  check(`${bot}: ${pnlLines.length} سطر pnl موجود`, pnlLines.length >= 2, pnlLines.length, ">= 2");
  // The realised-P&L replay reads r.pnl, never r.pnlAtFill.
  const replay = grab(text, /function getTodayRealizedDay\(\) \{[\s\S]*?\n\}/, `replay/${bot}`);
  check(`${bot}: إعادة تشغيل الأرباح المحققة تقرأ pnl فقط`,
    /\+= r\.pnl\b/.test(replay) && !/pnlAtFill/.test(replay), "reads pnlAtFill", "reads pnl");
  // alpaca() untouched.
  check(`${bot}: alpaca() بلا تغيير`,
    grab(text, /async function alpaca\([\s\S]*?\n\}/, `alpaca/${bot}`)
    === grab(base[bot], /async function alpaca\([\s\S]*?\n\}/, `alpaca base/${bot}`), "changed", "identical");
  check(`${bot}: getQuote() بلا تغيير`,
    grab(text, /async function getQuote\(optSym\) \{[\s\S]*?\n\}/, `gq/${bot}`)
    === grab(base[bot], /async function getQuote\(optSym\) \{[\s\S]*?\n\}/, `gq base/${bot}`), "changed", "identical");
  check(`${bot}: calcQty() بلا تغيير`,
    grab(text, /function calcQty\([\s\S]*?\n\}/, `cq/${bot}`)
    === grab(base[bot], /function calcQty\([\s\S]*?\n\}/, `cq base/${bot}`), "changed", "identical");
}

// ── 16) the option object still carries no bid/ask ────────
console.log("\n── 16) كائن الخيار لا يحمل bid/ask (موثَّق) ──");
for (const bot of ["v21", "lab"]) {
  const fo = grab(src[bot], /async function findOption\([\s\S]*?\n\}/, `findOption/${bot}`);
  check(`${bot}: findOption يعيد {symbol, strike, premium, expiry} فقط`,
    /return \{ symbol: contract\.symbol, strike: contract\.strike_price, premium, expiry \}/.test(fo),
    "shape changed", "unchanged");
  check(`${bot}: لا bid ولا ask في كائن الخيار`, !/\bbid\b|\bask\b/.test(fo), "has legs", "absent");
  check(`${bot}: findOption بلا تغيير عن الأساس`,
    fo === grab(base[bot], /async function findOption\([\s\S]*?\n\}/, `fo base/${bot}`), "changed", "identical");
}

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(` نجح ${pass} | فشل ${fail}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
