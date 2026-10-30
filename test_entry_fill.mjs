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
import os from "os";
import path from "path";
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
  // Exactly four keys are written, from the one shared amend() helper, so
  // the in-memory and on-disk writes can never drift apart.
  const writes = amend.match(/target\.\w+ = entryFill\.\w+;/g) || [];
  check(`${bot}: لا يكتب إلا مفاتيح التعبئة الأربعة`, writes.length === 4, writes, 4);
  check(`${bot}: ويُطبَّق على الكائنين معاً`,
    (amend.match(/amend\((?:state|fresh)\[symbol\]\);/g) || []).length === 2,
    (amend.match(/amend\((?:state|fresh)\[symbol\]\);/g) || []), 2);
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

// ── 17) END TO END: the amend must survive the caller's final save ──
// The unit sections above drive scanEntry's amend in isolation, and that
// is exactly how a real blocker slipped through: the amend wrote the four
// keys onto `fresh` (its own loadState object) and saved it, but main()
// then saves its OWN in-memory `state` once at the very end — a
// whole-file overwrite — so the amend was clobbered seconds later and
// entryFillPrice would have been null on essentially every trade.
//
// These cases run the REAL scanEntry against stubbed network/fs and then
// perform the caller's final saveState exactly as main() does:
//   scan_lab.js   saveState(state) at the end of main, BOTH modes
//   scan_v21.js   saveState(state) in scan mode
//                 saveState(freshState) in monitor mode, where freshState
//                 is the object passed in as `state`
// Verified to FAIL at 7c4ca9a4 (entryFillPrice undefined on disk) and to
// pass after the fix.
console.log("\n── 17) من الطرف للطرف: التعديل يصمد أمام الحفظ الأخير ──");

const SCAN_ENTRY_RE = {
  v21: /async function scanEntry\(state, symbol, portfolio, liveInAlpaca, dayCtx\) \{[\s\S]*?\n\}/,
  lab: /async function scanEntry\(state, strategy, symbol, liveInAlpaca, dayCtx\) \{[\s\S]*?\n\}/,
};
const ENTRY_FILL = { price: 1.07, confirmed: true, source: "entry_order", filledAt: "2026-10-23T14:31:02.500Z" };

// The real scanEntry, with every collaborator stubbed and state on a temp
// file. Nothing here touches the network; `alpaca` only ever answers the
// entry POST. The stub list is explicit so a new dependency in scanEntry
// makes this throw rather than silently skip.
function makeScanEntry(bot, { stateFile, entryFill = ENTRY_FILL, onLookup = null }) {
  const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  const saveState = s => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  const stubs = {
    fs,
    TICKERS_0DTE: ["SPY", "QQQ", "IWM"], HARD_STOP_PCT: -35,
    DAILY_LOSS_LIMIT: -1000, DAILY_TARGET_MAX: 99999, MAX_DAILY_TRADES: 99,
    COOLDOWN_MINUTES: 30, PROFIT_FLOOR_ENABLED: true, STOP_SLIPPAGE_PAD: 0.10,
    TRADING_BASE: "https://stub", ALPACA_KEY: "k", ALPACA_SECRET: "s",
    MAX_DAILY_LOSS: 1000, MAX_DTE: 2, MAX_OPEN_POSITIONS: 3, MAX_TRADE_BUDGET: 1000,
    fetchWithTimeout: async () => ({ json: async () => ({}), text: async () => "{}" }),
    alpaca: async (p, m) => (m === "POST" && p === "/orders" ? { id: "entry-order-xyz" } : {}),
    calcQty: () => 3,
    checkBreakout: () => ({ signal: "PUT", level: 731.2, volSurge: 1.8 }),
    computeSignal: () => ({ signal: "PUT", regime: "bearish", emaFast: 1, emaSlow: 1,
                            breakoutHigh: 2, breakoutLow: 1, volRatio: 1.5, lastClose: 1.5,
                            lastVolume: 100, barTime: "2026-10-23T14:00:00Z" }),
    computeHalfTrend: () => ({ atr2: 1.0 }),
    computeRSI: () => 44.1, computeVWAP: () => 731.4,
    countOpenPositions: () => 0,
    findOption: async () => ({ symbol: "QQQ261023P00730000", strike: 730, premium: 1.00, expiry: "2026-10-23" }),
    getBars: async () => [{ t: "2026-10-23T14:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
    getLatestPrice: async () => 731.0,
    getNearExpiry: async () => "2026-10-23",
    getQuoteLegs: async () => ({ bid: 0.95, ask: 1.05, mid: 1.00 }),
    getToday: () => "2026-10-23",
    getTodayRealizedDay: () => ({ net: 0, peak: 0, stopped: false, reason: null }),
    // onLookup fires as the lookup resolves, which is how the
    // "monitor closed the position mid-lookup" race is driven.
    getEntryFill: async () => { if (onLookup) onLookup(); return entryFill; },
    isPastLastEntry: () => false, isRangeBuilding: () => false,
    loadState, saveState,
    logTrade: () => true, monitorPosition: async () => {},
    postEntryStop: async () => ({ id: "stop-order-abc" }),
    stopOrderIdOrNull: (_l, o) => o?.id ?? null,
    progressBar: () => "███", tg: async () => 12345,
    bumpDayPeak: c => c, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    lookupComboMultiplier: () => ({ comboKey: "PUT|position:near_low", sizeMultiplier: 1 }),
    positionBucket: () => "near_low", spot: 731.0,
    // Stage 0 shadow logging. scanEntry now calls these, so the extraction
    // needs them; they are inert no-ops here because this suite is about
    // the fill capture, not the shadow log (test_signal_shadow.mjs covers
    // that). snapQuoteLegs returns null so no bid/ask reaches the record —
    // which also proves the null path does not disturb the entry.
    bumpSigCount: () => {}, logSignal: () => false, queueFollowup: () => {},
    sigSeenHas: () => false,
    snapQuoteLegs: async () => null,
    CHI_HM: { formatToParts: () => [{ type: "hour", value: "09" }] },
  };
  const fn = grab(src[bot], SCAN_ENTRY_RE[bot], `scanEntry/${bot}`);
  const scanEntry = new Function(...Object.keys(stubs), `${fn}\nreturn scanEntry;`)(...Object.values(stubs));
  const strategy = { name: "t", version: 1, combos: {}, params: { tradeBudget: 300, stopLossPct: -30,
    takeProfit1Pct: 15, takeProfit1LockPct: 5, takeProfit2Pct: 25, takeProfit2LockPct: 12, trailingPct: 8 } };
  const dayCtx = { armed: false, trusted: true, budget: 0 };
  const run = (state, symbol) => bot === "v21"
    ? scanEntry(state, symbol, { last_equity: 99000 }, new Set(), dayCtx)
    : scanEntry(state, strategy, symbol, new Set(), dayCtx);
  return { run, loadState, saveState };
}

const FILL_KEYS = { entryFillPrice: 1.07, entryFillConfirmed: true,
                    fillSourceEntry: "entry_order", entryFilledAt: "2026-10-23T14:31:02.500Z" };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fillcap-"));
try {
  for (const bot of ["v21", "lab"]) {
    // (a) one ticker, then the caller's final save — the core blocker.
    {
      const stateFile = path.join(TMP, `${bot}-a.json`);
      fs.writeFileSync(stateFile, "{}");
      const h = makeScanEntry(bot, { stateFile });
      const state = {};
      const r0 = await captureAsync(() => h.run(state, "QQQ"));
      // Asserted explicitly: a missing stub makes scanEntry throw, which
      // leaves the state empty and every assertion below fails with a
      // confusing "undefined". This names the real cause instead. It has
      // already caught two new scanEntry dependencies.
      check(`${bot}: scanEntry اكتملت بلا استثناء (كل الوكلاء موجودون)`,
        r0.err === undefined, String(r0.err), "no throw");
      check(`${bot}: المفاتيح على الكائن في الذاكرة (الذي سيحفظه main)`,
        FILL_KEYS.entryFillPrice === state.QQQ?.entryFillPrice, state.QQQ?.entryFillPrice, 1.07);
      // main()'s final whole-file overwrite.
      h.saveState(state);
      const disk = h.loadState();
      for (const [k, v] of Object.entries(FILL_KEYS)) {
        check(`${bot}: ${k} باقٍ على القرص بعد الحفظ الأخير`,
          JSON.stringify(disk.QQQ?.[k]) === JSON.stringify(v), disk.QQQ?.[k], v);
      }
      check(`${bot}: المركز نفسه لم يُفقد`,
        disk.QQQ?.active === true && disk.QQQ?.optionSymbol === "QQQ261023P00730000",
        { a: disk.QQQ?.active, o: disk.QQQ?.optionSymbol }, "intact");
    }

    // (b) TWO tickers, ONE final save. This is why the bug was a blocker
    //     rather than a one-trade loss: the ticker loop runs scanEntry for
    //     every symbol and main saves once, so a single overwrite
    //     discarded every ticker's amend at once.
    {
      const stateFile = path.join(TMP, `${bot}-b.json`);
      fs.writeFileSync(stateFile, "{}");
      const h = makeScanEntry(bot, { stateFile });
      const state = {};
      await captureAsync(() => h.run(state, "QQQ"));
      await captureAsync(() => h.run(state, "SPY"));
      h.saveState(state);
      const disk = h.loadState();
      check(`${bot}: رمزان ثم حفظ واحد — كلاهما يحفظ تعبئته`,
        disk.QQQ?.entryFillPrice === 1.07 && disk.SPY?.entryFillPrice === 1.07,
        { QQQ: disk.QQQ?.entryFillPrice, SPY: disk.SPY?.entryFillPrice }, { QQQ: 1.07, SPY: 1.07 });
    }

    // (c) a null lookup must still be recorded as null, not left absent —
    //     "we looked and found nothing" is information.
    {
      const stateFile = path.join(TMP, `${bot}-c.json`);
      fs.writeFileSync(stateFile, "{}");
      const h = makeScanEntry(bot, { stateFile,
        entryFill: { price: null, confirmed: false, source: "not_ready", filledAt: null } });
      const state = {};
      await captureAsync(() => h.run(state, "QQQ"));
      h.saveState(state);
      const disk = h.loadState();
      check(`${bot}: بحث فاشل ⇒ المفاتيح موجودة بقيمة null`,
        "entryFillPrice" in (disk.QQQ || {}) && disk.QQQ.entryFillPrice === null
        && disk.QQQ.fillSourceEntry === "not_ready",
        { p: disk.QQQ?.entryFillPrice, s: disk.QQQ?.fillSourceEntry }, { p: null, s: "not_ready" });
    }

    // (d) the monitor closes the position WHILE the lookup is in flight.
    //     onLookup empties the state file as the lookup resolves, which
    //     is exactly that race. Expected: the on-disk write is skipped —
    //     the position is gone from the file, do not resurrect it — while
    //     the in-memory amend still happens, because the caller owns that
    //     object and persisting it is main's pre-existing behaviour, not
    //     something these four fields introduce.
    {
      const stateFile = path.join(TMP, `${bot}-d.json`);
      fs.writeFileSync(stateFile, "{}");
      const h = makeScanEntry(bot, { stateFile,
        onLookup: () => fs.writeFileSync(stateFile, "{}") });
      const state = {};
      await captureAsync(() => h.run(state, "QQQ"));
      check(`${bot}: اختفى المركز من الملف ⇒ لا إحياء على القرص`,
        h.loadState().QQQ === undefined, h.loadState().QQQ, undefined);
      check(`${bot}: ومع ذلك الذاكرة تحمل التعبئة (main سيحفظها)`,
        state.QQQ?.entryFillPrice === 1.07 && state.QQQ?.fillSourceEntry === "entry_order",
        { p: state.QQQ?.entryFillPrice, s: state.QQQ?.fillSourceEntry },
        { p: 1.07, s: "entry_order" });
    }
  }

  // (e) v21 monitor mode: scanEntry is called with freshState, and main
  //     saves freshState — a DIFFERENT object from the `state` the
  //     monitor loop used. The amend must land on whatever is passed in.
  {
    const stateFile = path.join(TMP, "v21-monitor.json");
    // The monitor branch starts from a file that already holds other keys.
    fs.writeFileSync(stateFile, JSON.stringify({ _lastDay: "2026-10-23", _dailyTrades: [] }, null, 2));
    const h = makeScanEntry("v21", { stateFile });
    const freshState = h.loadState();          // scan_v21.js: const freshState = loadState()
    await captureAsync(() => h.run(freshState, "QQQ"));
    h.saveState(freshState);                   // scan_v21.js: saveState(freshState)
    const disk = h.loadState();
    check("v21 monitor: التعديل على freshState يصل للقرص",
      disk.QQQ?.entryFillPrice === 1.07 && disk.QQQ?.fillSourceEntry === "entry_order",
      { p: disk.QQQ?.entryFillPrice, s: disk.QQQ?.fillSourceEntry }, { p: 1.07, s: "entry_order" });
    check("v21 monitor: المفاتيح الأخرى في الملف لم تُفقد",
      disk._lastDay === "2026-10-23", disk._lastDay, "2026-10-23");
  }

  // (f) the source itself: both objects must be amended, under their own
  //     guards. Pinned so the blocker cannot come back by someone
  //     deleting one of the two writes.
  for (const bot of ["v21", "lab"]) {
    const amend = grab(src[bot], RE.amend, `amend/${bot}`);
    check(`${bot}: يعدّل state[symbol] (كائن المُنادي)`,
      /if \(state\[symbol\]\?\.active && state\[symbol\]\.optionSymbol === opt\.symbol\) \{\n\s*amend\(state\[symbol\]\);/.test(amend),
      "missing in-memory amend", "present");
    check(`${bot}: ويعدّل fresh[symbol] (الملف)`,
      /if \(fresh\[symbol\]\?\.active && fresh\[symbol\]\.optionSymbol === opt\.symbol\) \{\n\s*amend\(fresh\[symbol\]\);/.test(amend),
      "missing on-disk amend", "present");
    check(`${bot}: الحقول الأربعة تُكتب من دالة واحدة مشتركة`,
      (amend.match(/target\.\w+ = entryFill\./g) || []).length === 4,
      (amend.match(/target\.\w+ = entryFill\./g) || []), 4);
    check(`${bot}: saveState(fresh) مرة واحدة فقط`,
      (amend.match(/saveState\(fresh\)/g) || []).length === 1,
      (amend.match(/saveState\(fresh\)/g) || []).length, 1);
    // Comments stripped first: the block's own prose explains what main's
    // saveState(state) does, and a bare search matches that explanation.
    const code = amend.replace(/\/\/[^\n]*/g, "");
    check(`${bot}: لا saveState(state) داخل التعديل (main يتولّاه)`,
      !/saveState\(state\)/.test(code), "saves the caller's object", "leaves it to main");
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(` نجح ${pass} | فشل ${fail}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
