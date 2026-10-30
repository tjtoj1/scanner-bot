// ============================================================
// SIGNAL SHADOW LOG (STAGE 0) — TEST SUITE. No network, no API keys.
//
// Stage 0's whole promise is that it changes NOTHING. So the central
// section here is 4: the real scanEntry is run twice on identical stubs,
// once with the logging helpers live and once with them replaced by
// throwing stubs, and every observable — the orders POSTed, the stop
// placed, the state written, the console output — must match.
//
// Everything is EXTRACTED BY TEXT from the real scan_lab.js and run
// against stubs. If a regex stops matching, grab() throws and the suite
// exits non-zero rather than silently testing nothing.
//
// Run:  node test_signal_shadow.mjs
// ============================================================
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const lf = s => s.replace(/\r\n/g, "\n");
const src = lf(fs.readFileSync("scan_lab.js", "utf8"));
const showAt = (sha, f) =>
  lf(execFileSync("git", ["show", `${sha}:${f}`], { maxBuffer: 1 << 28 }).toString());
const BASE_SHA = "9208e4cdebac3d24dbb258cc264bd9ebac312e09";
const base = showAt(BASE_SHA, "scan_lab.js");

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
async function captureAsync(fn) {
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: await fn(), lines }; }
  catch (e) { return { out: undefined, err: e, lines }; }
  finally { Object.assign(console, orig); }
}

const RE = {
  consts:  /const SIGNALS_FILE          = "signals_lab\.jsonl";[\s\S]*?let followupBudgetUsedMs = 0;/,
  sigKey:  /function sigKey\(snap, decision, reason\) \{[\s\S]*?\n\}/,
  sigSeen: /function sigSeenHas\(state, snap, decision, reason\) \{[\s\S]*?\n\}/,
  snapLegs:/async function snapQuoteLegs\(optSym\) \{[\s\S]*?\n\}/,
  bump:    /function bumpSigCount\(state, reason\) \{[\s\S]*?\n\}/,
  logSig:  /function logSignal\(state, snap, decision, reason\) \{[\s\S]*?\n\}/,
  queue:   /function queueFollowup\(state, snap, decision, reason\) \{[\s\S]*?\n\}/,
  follow:  /async function runShadowFollowups\(state\) \{[\s\S]*?\n\}/,
  scanEntry: /async function scanEntry\(state, strategy, symbol, liveInAlpaca, dayCtx\) \{[\s\S]*?\n\}/,
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sigshadow-"));

// The shadow helpers, with fs and the clock injected.
function makeHelpers({ sigFile, today = "2026-10-29", legs = { bid: 0.95, ask: 1.05, mid: 1.0 },
                       legsThrows = false, appendThrows = false, quotes = null, sleepMs = 0 }) {
  const appended = [];
  const calls = [];
  const realSetTimeout = globalThis.setTimeout;
  const fsStub = {
    appendFileSync: (f, line) => {
      if (appendThrows) throw new Error("ENOSPC: no space left on device");
      appended.push({ file: f, line });
      fs.appendFileSync(sigFile, line);
    },
  };
  const fetchStub = async (url, _o, timeoutMs) => {
    calls.push({ url, timeoutMs });
    if (legsThrows) throw new Error("stub transport failure");
    if (sleepMs) await new Promise(r => realSetTimeout(r, sleepMs));
    const sym = decodeURIComponent(String(url).split("symbols=")[1] || "");
    const q = quotes ? quotes[sym] : (legs ? { ap: legs.ask, bp: legs.bid } : null);
    return { json: async () => ({ quotes: q ? { [sym]: q } : {} }) };
  };
  const body = [
    grab(src, RE.consts, "consts"),
    grab(src, RE.sigKey, "sigKey"),
    grab(src, RE.sigSeen, "sigSeenHas"),
    grab(src, RE.snapLegs, "snapQuoteLegs"),
    grab(src, RE.bump, "bumpSigCount"),
    grab(src, RE.logSig, "logSignal"),
    grab(src, RE.queue, "queueFollowup"),
    grab(src, RE.follow, "runShadowFollowups"),
    `return { snapQuoteLegs, bumpSigCount, logSignal, queueFollowup, runShadowFollowups,
              sigKey, sigSeenHas,
              budget: () => followupBudgetUsedMs, FOLLOWUP_BUDGET_MS, FOLLOWUP_MAX_PER_CYCLE,
              SIG_SEEN_CAP, SIG_PENDING_CAP, SIGNALS_FILE };`,
  ].join("\n");
  const api = new Function("fs", "fetchWithTimeout", "HEADERS", "getToday", "console", body)(
    fsStub, fetchStub, {}, () => today,
    { log: () => {}, warn: () => {}, error: () => {} });
  return { api, appended, calls };
}

const SNAP = {
  day: "2026-10-29", symbol: "QQQ", signal: "PUT", barTime: "2026-10-29T14:00:00Z",
  optionSymbol: "QQQ261029P00730000", premium: 1.0, bid: null, ask: null, spreadPct: null,
};

console.log("\n═══════════════════════════════════════════════════════════");
console.log(" SIGNAL SHADOW LOG (STAGE 0) — no network, no keys");
console.log(`  pinned base: ${BASE_SHA.slice(0, 12)}`);
console.log("═══════════════════════════════════════════════════════════");

try {
// ── 1) logSignal never throws ─────────────────────────────
console.log("\n── 1) logSignal لا يرمي أبداً ──");
{
  const f = path.join(TMP, "s1.jsonl");
  const h = makeHelpers({ sigFile: f, appendThrows: true });
  const st = {};
  let threw = false, out;
  try { out = h.api.logSignal(st, SNAP, "taken", null); } catch { threw = true; }
  check("append يرمي ⇒ لا يتسرّب الخطأ", !threw, "threw", "swallowed");
  check("ويعيد false", out === false, out, false);
  // a malformed snapshot must not throw either
  const h2 = makeHelpers({ sigFile: path.join(TMP, "s1b.jsonl") });
  let threw2 = false;
  try { h2.api.logSignal(st, {}, "taken", null); } catch { threw2 = true; }
  check("لقطة ناقصة ⇒ لا يرمي", !threw2, "threw", "swallowed");
  let threw3 = false;
  try { h2.api.logSignal(null, SNAP, "taken", null); } catch { threw3 = true; }
  check("state=null ⇒ لا يرمي", !threw3, "threw", "swallowed");
}

// ── 2) dedupe ─────────────────────────────────────────────
console.log("\n── 2) إزالة التكرار على (day, symbol, barTime, decision, reason) ──");
{
  const f = path.join(TMP, "s2.jsonl");
  const h = makeHelpers({ sigFile: f });
  const st = {};
  let r;
  r = h.api.logSignal(st, SNAP, "taken", null);
  check("أول كتابة تنجح", r === true, r, true);
  r = h.api.logSignal(st, SNAP, "taken", null);
  check("نفس المفتاح ⇒ مُكرَّر، لا يُكتب", r === false, r, false);
  r = h.api.logSignal(st, SNAP, "skipped", "cooldown");
  check("قرار مختلف ⇒ سجل جديد", r === true, r, true);
  r = h.api.logSignal(st, { ...SNAP, barTime: "2026-10-29T14:15:00Z" }, "taken", null);
  check("barTime مختلف ⇒ سجل جديد", r === true, r, true);
  r = h.api.logSignal(st, { ...SNAP, symbol: "SPY" }, "taken", null);
  check("رمز مختلف ⇒ سجل جديد", r === true, r, true);
  check("إجمالاً 4 سجلات", h.appended.length === 4, h.appended.length, 4);
  // The compact key: no day (the set carries it), time only, decision coded.
  check("المفتاح مُختصر (رمز|HH:MM|حرف|سبب)",
    h.api.sigKey(SNAP, "skipped", "cooldown") === "QQQ|14:00|S|cooldown",
    h.api.sigKey(SNAP, "skipped", "cooldown"), "QQQ|14:00|S|cooldown");
  check("والسبب غير مقتطع (لا تصادم مفاتيح)",
    h.api.sigKey(SNAP, "skipped", "no_spot") !== h.api.sigKey(SNAP, "skipped", "no_option"),
    [h.api.sigKey(SNAP, "skipped", "no_spot"), h.api.sigKey(SNAP, "skipped", "no_option")], "distinct");
  // sigSeenHas is read-only: it must not mark anything
  const stRO = {};
  check("sigSeenHas على مجموعة فارغة ⇒ false",
    h.api.sigSeenHas(stRO, SNAP, "taken", null) === false, h.api.sigSeenHas(stRO, SNAP, "taken", null), false);
  check("ولا يُنشئ _sigSeen", stRO._sigSeen === undefined, stRO._sigSeen, undefined);
  h.api.logSignal(stRO, SNAP, "taken", null);
  check("بعد التسجيل ⇒ true",
    h.api.sigSeenHas(stRO, SNAP, "taken", null) === true, h.api.sigSeenHas(stRO, SNAP, "taken", null), true);
  check("وقرار آخر ما زال false",
    h.api.sigSeenHas(stRO, SNAP, "skipped", "cooldown") === false, true, false);
  // day rollover resets the set
  const h2 = makeHelpers({ sigFile: path.join(TMP, "s2b.jsonl"), today: "2026-10-30" });
  r = h2.api.logSignal(st, SNAP, "taken", null);
  check("يوم جديد ⇒ المجموعة تُصفَّر", r === true, r, true);
  check("والمجموعة تحمل اليوم الجديد", st._sigSeen.day === "2026-10-30", st._sigSeen.day, "2026-10-30");
  // cap. The keys must be genuinely distinct UNDER THE COMPACT FORMAT,
  // which keeps only HH:MM of barTime — a counter stuffed anywhere else
  // collapses to one key and would make this test pass vacuously.
  const h3 = makeHelpers({ sigFile: path.join(TMP, "s2c.jsonl") });
  const st3 = {};
  const N = h3.api.SIG_SEEN_CAP + 50;
  const mkBar = i => `2026-10-29T${String(9 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`;
  for (let i = 0; i < N; i++)
    h3.api.logSignal(st3, { ...SNAP, barTime: mkBar(i) }, "taken", null);
  check(`المفاتيح المولَّدة متمايزة فعلاً (${N})`,
    new Set(Array.from({ length: N }, (_, i) => h3.api.sigKey({ ...SNAP, barTime: mkBar(i) }, "taken", null))).size === N,
    "collisions", `${N} distinct`);
  check(`المجموعة محدودة بـ ${h3.api.SIG_SEEN_CAP}`,
    st3._sigSeen.keys.length === h3.api.SIG_SEEN_CAP, st3._sigSeen.keys.length, h3.api.SIG_SEEN_CAP);
  check("الإخلاء من الأقدم (الأحدث باقٍ)",
    st3._sigSeen.keys[st3._sigSeen.keys.length - 1] === h3.api.sigKey({ ...SNAP, barTime: mkBar(N - 1) }, "taken", null),
    st3._sigSeen.keys[st3._sigSeen.keys.length - 1], h3.api.sigKey({ ...SNAP, barTime: mkBar(N - 1) }, "taken", null));
  check("والأقدم أُزيل",
    !st3._sigSeen.keys.includes(h3.api.sigKey({ ...SNAP, barTime: mkBar(0) }, "taken", null)),
    "oldest still present", "evicted");
}

// ── 3) counters, not records, for the early gates ─────────
console.log("\n── 3) العدّادات للبوابات المبكرة ──");
{
  const f = path.join(TMP, "s3.jsonl");
  const h = makeHelpers({ sigFile: f });
  const st = {};
  h.api.bumpSigCount(st, "already_active");
  h.api.bumpSigCount(st, "already_active");
  h.api.bumpSigCount(st, "no_signal");
  check("العدّاد يتراكم", st._sigCounts.already_active === 2, st._sigCounts.already_active, 2);
  check("ومفاتيح مستقلة", st._sigCounts.no_signal === 1, st._sigCounts.no_signal, 1);
  check("ولا يكتب أي سجل", h.appended.length === 0, h.appended.length, 0);
  const h2 = makeHelpers({ sigFile: f, today: "2026-10-30" });
  h2.api.bumpSigCount(st, "no_signal");
  check("يوم جديد ⇒ العدّادات تُصفَّر", st._sigCounts.already_active === undefined && st._sigCounts.no_signal === 1,
    st._sigCounts, { day: "2026-10-30", no_signal: 1 });
  let threw = false;
  try { h.api.bumpSigCount(null, "x"); } catch { threw = true; }
  check("state=null ⇒ لا يرمي", !threw, "threw", "swallowed");
}

// ── 4) THE POINT: scanEntry behaves identically ───────────
console.log("\n── 4) لا تغيير في السلوك إطلاقاً (كل مسارات البوابات) ──");
{
  // Run the real scanEntry twice on identical stubs: once with the shadow
  // helpers LIVE (real extracted code, real appends to a temp file), once
  // with them replaced by NO-OPS. Every observable must match.
  //
  // No-ops, not throwing stubs, on purpose. A throwing logger genuinely
  // would break the entry — which is why the real helpers carry their own
  // try/catch — so comparing against one would only prove that an
  // exception propagates. That robustness is tested separately in sections
  // 1, 3, 5 and 6, where the real helpers are given a failing fs and a
  // failing fetch and must still not throw.
  function runScanEntry(scenario, live) {
    const posts = [];
    const stops = [];
    const sigFile = path.join(TMP, `s4-${scenario.name}-${live ? "live" : "noop"}.jsonl`);
    const shadow = live
      ? makeHelpers({ sigFile }).api
      : {
          snapQuoteLegs: async () => ({ bid: 0.95, ask: 1.05, mid: 1.0 }),
          bumpSigCount: () => {},
          // false, so the control also exercises the "already logged"
          // branch — the live and no-op runs must agree either way.
          logSignal: () => false,
          queueFollowup: () => {},
          sigSeenHas: () => false,
        };
    const stubs = {
      fs,
      MAX_DAILY_LOSS: 1000, MAX_DTE: 2, MAX_OPEN_POSITIONS: 3, MAX_TRADE_BUDGET: 1000,
      PROFIT_FLOOR_ENABLED: true, STOP_SLIPPAGE_PAD: 0.10,
      fetchWithTimeout: async () => ({ json: async () => ({}) }),
      HEADERS: {},
      alpaca: async (p, m, b) => {
        if (m === "POST" && p === "/orders") { posts.push(b); return { id: "ord-1" }; }
        return {};
      },
      calcQty: () => 3,
      computeSignal: () => scenario.sig,
      computeRSI: () => 44.1, computeVWAP: () => 731.4,
      countOpenPositions: () => scenario.open ?? 0,
      findOption: async () => scenario.opt,
      getBars: async () => [{ t: "2026-10-29T14:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
      getLatestPrice: async () => scenario.spot,
      getQuoteLegs: async () => ({ bid: 0.95, ask: 1.05, mid: 1.0 }),
      getToday: () => "2026-10-29",
      getTodayRealizedDay: () => scenario.day,
      getEntryFill: async () => ({ price: 1.02, confirmed: true, source: "entry_order", filledAt: null }),
      isPastLastEntry: () => !!scenario.pastLastEntry,
      loadState: () => ({}), saveState: () => {},
      logTrade: () => true, monitorPosition: async () => {},
      postEntryStop: async (b) => { stops.push(b); return { id: "stop-1" }; },
      stopOrderIdOrNull: (_l, o) => o?.id ?? null,
      tg: async () => 1, bumpDayPeak: c => c,
      clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
      lookupComboMultiplier: () => ({ comboKey: "PUT|position:near_low", sizeMultiplier: 1 }),
      positionBucket: () => "near_low", spot: 731.0,
      CHI_HM: { formatToParts: () => [{ type: "hour", value: "09" }] },
      bumpSigCount: shadow.bumpSigCount, logSignal: shadow.logSignal,
      queueFollowup: shadow.queueFollowup, snapQuoteLegs: shadow.snapQuoteLegs,
      sigSeenHas: shadow.sigSeenHas,
    };
    const fn = grab(src, RE.scanEntry, "scanEntry");
    const scanEntry = new Function(...Object.keys(stubs), `${fn}\nreturn scanEntry;`)(...Object.values(stubs));
    const strategy = { name: "t", version: 1, combos: {}, params: { tradeBudget: 300, stopLossPct: -30,
      takeProfit1Pct: 15, takeProfit1LockPct: 5, takeProfit2Pct: 25, takeProfit2LockPct: 12, trailingPct: 8 } };
    const state = JSON.parse(JSON.stringify(scenario.state ?? {}));
    return { state, posts, stops, scanEntry, strategy };
  }

  const OK_SIG = { signal: "PUT", regime: "bearish", emaFast: 1.0, emaSlow: 1.02,
                   breakoutHigh: 2, breakoutLow: 1, volRatio: 1.5, lastClose: 0.99,
                   lastVolume: 100, barTime: "2026-10-29T14:00:00Z" };
  const OK_OPT = { symbol: "QQQ261029P00730000", strike: 730, premium: 1.0, expiry: "2026-10-29" };
  const DAY_OK = { net: 0, peak: 0, stopped: false, reason: null };

  const SCENARIOS = [
    { name: "already_active", sig: OK_SIG, opt: OK_OPT, spot: 731, day: DAY_OK,
      state: { QQQ: { active: true } } },
    { name: "past_last_entry", sig: OK_SIG, opt: OK_OPT, spot: 731, day: DAY_OK, pastLastEntry: true },
    { name: "max_open", sig: OK_SIG, opt: OK_OPT, spot: 731, day: DAY_OK, open: 3 },
    { name: "day_stopped", sig: OK_SIG, opt: OK_OPT, spot: 731,
      day: { net: -600, peak: 0, stopped: true, reason: "loss" } },
    { name: "loss_cap", sig: OK_SIG, opt: OK_OPT, spot: 731,
      day: { net: -1200, peak: 0, stopped: false, reason: null } },
    { name: "no_signal", sig: null, opt: OK_OPT, spot: 731, day: DAY_OK },
    { name: "cooldown", sig: OK_SIG, opt: OK_OPT, spot: 731, day: DAY_OK,
      state: { _cooldowns: { QQQ_PUT: Date.now() + 600000 } } },
    { name: "no_spot", sig: OK_SIG, opt: OK_OPT, spot: null, day: DAY_OK },
    { name: "no_option", sig: OK_SIG, opt: null, spot: 731, day: DAY_OK },
    { name: "taken", sig: OK_SIG, opt: OK_OPT, spot: 731, day: DAY_OK },
  ];

  for (const sc of SCENARIOS) {
    const A = runScanEntry(sc, true);
    const B = runScanEntry(sc, false);
    const ra = await captureAsync(() => A.scanEntry(A.state, A.strategy, "QQQ", new Set(), { armed: false, trusted: true, budget: 0 }));
    const rb = await captureAsync(() => B.scanEntry(B.state, B.strategy, "QQQ", new Set(), { armed: false, trusted: true, budget: 0 }));
    // Strip the shadow's own log lines from the live run before comparing.
    const clean = ls => ls.filter(l => !/shadow|logSignal/.test(l));
    const eqPosts = JSON.stringify(A.posts) === JSON.stringify(B.posts);
    const eqStops = JSON.stringify(A.stops) === JSON.stringify(B.stops);
    const eqLogs = JSON.stringify(clean(ra.lines)) === JSON.stringify(clean(rb.lines));
    // entryTime / msgId are wall-clock and stub-dependent, so they are
    // dropped. The three shadow bookkeeping keys are NOT dropped — instead
    // the live run's extra keys are asserted to be exactly those three,
    // which is stronger than hiding them.
    const strip = s => {
      const c = JSON.parse(JSON.stringify(s));
      delete c._sigSeen; delete c._sigCounts; delete c._sigPending;
      if (c.QQQ) { delete c.QQQ.entryTime; delete c.QQQ.msgId;
                   if (c.QQQ.entryConditions) delete c.QQQ.entryConditions.entryTimeUTC; }
      return c;
    };
    const eqState = JSON.stringify(strip(A.state)) === JSON.stringify(strip(B.state));
    const extra = Object.keys(A.state).filter(k => !(k in B.state));
    const SHADOW_KEYS = ["_sigSeen", "_sigCounts", "_sigPending"];
    check(`${sc.name}: نفس أوامر الشراء`, eqPosts, { live: A.posts, noop: B.posts }, "identical");
    check(`${sc.name}: نفس أوامر الوقف`, eqStops, { live: A.stops, noop: B.stops }, "identical");
    check(`${sc.name}: نفس الحالة المكتوبة`, eqState, { live: strip(A.state), noop: strip(B.state) }, "identical");
    check(`${sc.name}: المفاتيح الزائدة = مفاتيح الظل فقط`,
      extra.every(k => SHADOW_KEYS.includes(k)), extra, "subset of shadow keys");
    check(`${sc.name}: نفس مخرجات console`, eqLogs, { live: clean(ra.lines), noop: clean(rb.lines) }, "identical");
    check(`${sc.name}: التسجيل الحيّ لا يرمي`, ra.err === undefined, String(ra.err), "no throw");
  }
}

// ── 4b) THE REPEAT BUG: one bar, 30 evaluations ───────────
// scanEntry re-runs every cycle while the same 15-min bar is the last
// closed one — 15 cycles x 2 children ~= 30 identical evaluations. The
// first version fetched bid/ask and queued a follow-up on every one of
// them. This drives the real scanEntry 30 times on one bar and counts.
console.log("\n── 4b) شمعة واحدة، 30 تقييماً ──");
{
  function build(scenario, sigFile, onLegsCall) {
    const posts = [];
    const h = makeHelpers({ sigFile });
    let legsCalls = 0;
    const stubs = {
      fs,
      MAX_DAILY_LOSS: 1000, MAX_DTE: 2, MAX_OPEN_POSITIONS: 3, MAX_TRADE_BUDGET: 1000,
      PROFIT_FLOOR_ENABLED: true, STOP_SLIPPAGE_PAD: 0.10,
      fetchWithTimeout: async () => ({ json: async () => ({}) }), HEADERS: {},
      alpaca: async (p, m, b) => {
        if (m === "POST" && p === "/orders") { posts.push(b); return { id: "ord-1" }; }
        return {};
      },
      calcQty: () => 3,
      computeSignal: () => scenario.sig(),
      computeRSI: () => 44.1, computeVWAP: () => 731.4,
      countOpenPositions: () => 0,
      findOption: async () => ({ symbol: "QQQ261029P00730000", strike: 730, premium: 1.0, expiry: "2026-10-29" }),
      getBars: async () => [{ t: "2026-10-29T14:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
      getLatestPrice: async () => 731,
      getQuoteLegs: async () => ({ bid: 0.95, ask: 1.05, mid: 1.0 }),
      getToday: () => "2026-10-29",
      getTodayRealizedDay: () => ({ net: 0, peak: 0, stopped: false, reason: null }),
      getEntryFill: async () => ({ price: 1.02, confirmed: true, source: "entry_order", filledAt: null }),
      isPastLastEntry: () => false,
      loadState: () => ({}), saveState: () => {},
      logTrade: () => true, monitorPosition: async () => {},
      postEntryStop: async () => ({ id: "stop-1" }),
      stopOrderIdOrNull: (_l, o) => o?.id ?? null,
      tg: async () => 1, bumpDayPeak: c => c,
      clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
      lookupComboMultiplier: () => ({ comboKey: "PUT|position:near_low", sizeMultiplier: 1 }),
      positionBucket: () => "near_low", spot: 731.0,
      CHI_HM: { formatToParts: () => [{ type: "hour", value: "09" }] },
      bumpSigCount: h.api.bumpSigCount, logSignal: h.api.logSignal,
      queueFollowup: h.api.queueFollowup, sigSeenHas: h.api.sigSeenHas,
      snapQuoteLegs: async (s) => { legsCalls++; onLegsCall?.(); return { bid: 0.95, ask: 1.05, mid: 1.0 }; },
    };
    const fn = grab(src, RE.scanEntry, "scanEntry");
    const scanEntry = new Function(...Object.keys(stubs), `${fn}\nreturn scanEntry;`)(...Object.values(stubs));
    const strategy = { name: "t", version: 1, combos: {}, params: { tradeBudget: 300, stopLossPct: -30,
      takeProfit1Pct: 15, takeProfit1LockPct: 5, takeProfit2Pct: 25, takeProfit2LockPct: 12, trailingPct: 8 } };
    return { scanEntry, strategy, posts, h, legs: () => legsCalls };
  }
  const SIG = { signal: "PUT", regime: "bearish", emaFast: 1.0, emaSlow: 1.02,
                breakoutHigh: 2, breakoutLow: 1, volRatio: 1.5, lastClose: 0.99,
                lastVolume: 100, barTime: "2026-10-29T14:00:00Z" };

  // (i) a bar whose signal is NEVER entered: the buy fails every time.
  {
    const b = build({ sig: () => SIG }, path.join(TMP, "s4b-i.jsonl"));
    // make the buy fail so no "taken" record is ever written
    const state = {};
    b.scanEntry.__noop = 0;
    const stubsFailBuy = build({ sig: () => SIG }, path.join(TMP, "s4b-i2.jsonl"));
    // drive 30 evaluations of the same bar
    for (let i = 0; i < 30; i++) {
      await captureAsync(() => stubsFailBuy.scanEntry(state, stubsFailBuy.strategy, "QQQ", new Set(),
        { armed: true, trusted: true, budget: 0 }));   // armed + budget 0 => gated, never entered
    }
    const recs = stubsFailBuy.h.appended.map(a => JSON.parse(a.line));
    const gate = recs.filter(r => r.decision === "reached_floor_gate");
    check("30 تقييماً ⇒ سجل reached_floor_gate واحد", gate.length === 1, gate.length, 1);
    check("30 تقييماً ⇒ طلب bid/ask واحد على الأكثر",
      stubsFailBuy.legs() <= 1, stubsFailBuy.legs(), "<= 1");
    check("30 تقييماً ⇒ عنصر متابعة واحد",
      (state._sigPending?.items ?? []).length === 1, (state._sigPending?.items ?? []).length, 1);
    check("ولم يُفتح أي مركز", stubsFailBuy.posts.length === 0, stubsFailBuy.posts.length, 0);
    check("و_sigSeen يحمل مفتاحاً واحداً", state._sigSeen.keys.length === 1, state._sigSeen.keys.length, 1);
    void b;
  }

  // (ii) the same bar, gated for 29 cycles, then entered on the 30th.
  //      entryBid/entryAsk must still be populated on the trade.
  {
    const b = build({ sig: () => SIG }, path.join(TMP, "s4b-ii.jsonl"));
    const state = {};
    for (let i = 0; i < 29; i++) {
      await captureAsync(() => b.scanEntry(state, b.strategy, "QQQ", new Set(),
        { armed: true, trusted: true, budget: 0 }));           // gated
    }
    const legsAfterGated = b.legs();
    check("29 دورة محجوبة ⇒ طلب bid/ask واحد", legsAfterGated <= 1, legsAfterGated, "<= 1");
    await captureAsync(() => b.scanEntry(state, b.strategy, "QQQ", new Set(),
      { armed: false, trusted: true, budget: 0 }));             // now it enters
    check("الدورة الأخيرة تفتح مركزاً", b.posts.length === 1, b.posts.length, 1);
    check("والمركز يحمل entryBid",
      state.QQQ?.entryBid === 0.95, state.QQQ?.entryBid, 0.95);
    check("و entryAsk", state.QQQ?.entryAsk === 1.05, state.QQQ?.entryAsk, 1.05);
    check("و entrySpreadPct", state.QQQ?.entrySpreadPct === 10, state.QQQ?.entrySpreadPct, 10);
    check("طلب bid/ask إضافي واحد فقط للصفقة المنفَّذة",
      b.legs() === legsAfterGated + 1, b.legs(), legsAfterGated + 1);
    const taken = b.h.appended.map(a => JSON.parse(a.line)).filter(r => r.decision === "taken");
    check("وسجل taken واحد", taken.length === 1, taken.length, 1);
    check("سجل taken يحمل السبريد", taken[0].bid === 0.95 && taken[0].spreadPct === 10,
      { bid: taken[0].bid, s: taken[0].spreadPct }, { bid: 0.95, s: 10 });
  }

  // (iii) state cost at the cap
  {
    const h = makeHelpers({ sigFile: path.join(TMP, "s4b-iii.jsonl") });
    const st = {};
    // Realistic worst case: 6 symbols x distinct bar times x 3 decisions,
    // generated so every key is distinct, so the cap is genuinely reached.
    const SYMS = ["SPY","QQQ","IWM","NVDA","TSLA","AMZN"];
    const DECS = [["taken", null], ["skipped", "cooldown"], ["reached_floor_gate", null]];
    let made = 0;
    for (let bar = 0; bar < 40 && made < h.api.SIG_SEEN_CAP + 30; bar++) {
      const barTime = `2026-10-29T${String(8 + Math.floor(bar / 4)).padStart(2, "0")}:${String((bar % 4) * 15).padStart(2, "0")}:00Z`;
      for (const s of SYMS) {
        for (const [d, rsn] of DECS) {
          if (made >= h.api.SIG_SEEN_CAP + 30) break;
          h.api.logSignal(st, { ...SNAP, symbol: s, barTime }, d, rsn);
          made++;
        }
      }
    }
    const bytes = JSON.stringify(st._sigSeen).length;
    console.log(`      → _sigSeen at cap ${h.api.SIG_SEEN_CAP} = ${bytes} bytes (${(bytes/1024).toFixed(2)} KiB)`);
    check(`_sigSeen محدود بـ ${h.api.SIG_SEEN_CAP}`,
      st._sigSeen.keys.length === h.api.SIG_SEEN_CAP, st._sigSeen.keys.length, h.api.SIG_SEEN_CAP);
    check("وحجمه أقل من 4 كيبي", bytes < 4096, bytes, "< 4096");
  }
}

// ── 5) budgets and caps on the follow-up ──────────────────
console.log("\n── 5) ميزانيات المتابعة ──");
{
  const f = path.join(TMP, "s5.jsonl");
  const h = makeHelpers({ sigFile: f, quotes: { "QQQ261029P00730000": { ap: 1.1, bp: 0.9 } } });
  const st = {};
  for (let i = 0; i < 10; i++)
    h.api.queueFollowup(st, { ...SNAP, barTime: `b${i}` }, "reached_floor_gate", null);
  check("الطابور يمتلئ", st._sigPending.items.length === 10, st._sigPending.items.length, 10);
  await captureAsync(() => h.api.runShadowFollowups(st));
  check(`${h.api.FOLLOWUP_MAX_PER_CYCLE} متابعة فقط في الدورة`,
    h.calls.length === h.api.FOLLOWUP_MAX_PER_CYCLE, h.calls.length, h.api.FOLLOWUP_MAX_PER_CYCLE);
  check("والباقي يبقى في الطابور", st._sigPending.items.length === 8, st._sigPending.items.length, 8);
  check("مهلة 3000ms لكل متابعة", h.calls.every(c => c.timeoutMs === 3000), h.calls.map(c => c.timeoutMs), 3000);
  check("سجلّا followup كُتبا", h.appended.length === 2, h.appended.length, 2);
  const rec = JSON.parse(h.appended[0].line);
  check('type = "followup"', rec.type === "followup", rec.type, "followup");
  check("يحمل السعر المقتبس", rec.quote && rec.quote.mid === 1, rec.quote, { mid: 1 });
  check("ويحمل سبب التخطّي", rec.decision === "reached_floor_gate", rec.decision, "reached_floor_gate");

  // budget exhaustion: each call burns 3s of real time, 5s budget
  const h2 = makeHelpers({ sigFile: path.join(TMP, "s5b.jsonl"), sleepMs: 2600 });
  const st2 = {};
  for (let i = 0; i < 6; i++)
    h2.api.queueFollowup(st2, { ...SNAP, barTime: `c${i}` }, "reached_floor_gate", null);
  check(`FOLLOWUP_BUDGET_MS = 5000`, h2.api.FOLLOWUP_BUDGET_MS === 5000, h2.api.FOLLOWUP_BUDGET_MS, 5000);
  await captureAsync(() => h2.api.runShadowFollowups(st2));
  await captureAsync(() => h2.api.runShadowFollowups(st2));
  check("الميزانية تمنع نداءات إضافية", h2.api.budget() >= 5000 && h2.calls.length <= 2,
    { budget: h2.api.budget(), calls: h2.calls.length }, "budget spent, <=2 calls");
  const before = h2.calls.length;
  await captureAsync(() => h2.api.runShadowFollowups(st2));
  check("بعد الاستنفاد — صفر نداءات", h2.calls.length === before, h2.calls.length - before, 0);

  // the queue is capped
  const h3 = makeHelpers({ sigFile: path.join(TMP, "s5c.jsonl") });
  const st3 = {};
  for (let i = 0; i < h3.api.SIG_PENDING_CAP + 20; i++)
    h3.api.queueFollowup(st3, { ...SNAP, barTime: `d${i}` }, "x", null);
  check(`الطابور محدود بـ ${h3.api.SIG_PENDING_CAP}`,
    st3._sigPending.items.length === h3.api.SIG_PENDING_CAP, st3._sigPending.items.length, h3.api.SIG_PENDING_CAP);
  // no optionSymbol ⇒ nothing queued
  const st4 = {};
  h3.api.queueFollowup(st4, { ...SNAP, optionSymbol: null }, "x", null);
  check("بلا رمز عقد ⇒ لا يُصطفّ", (st4._sigPending?.items ?? []).length === 0,
    (st4._sigPending?.items ?? []).length, 0);
  // a throwing fetch must not escape
  const h4 = makeHelpers({ sigFile: path.join(TMP, "s5d.jsonl"), legsThrows: true });
  const st5 = {};
  h4.api.queueFollowup(st5, SNAP, "x", null);
  const r = await captureAsync(() => h4.api.runShadowFollowups(st5));
  check("fetch يرمي ⇒ لا يتسرّب", r.err === undefined, String(r.err), "no throw");
  check("ويُسجَّل quote=null لا تخميناً", JSON.parse(h4.appended[0].line).quote === null,
    JSON.parse(h4.appended[0].line).quote, null);
}

// ── 6) snapQuoteLegs ──────────────────────────────────────
console.log("\n── 6) snapQuoteLegs ──");
{
  const h = makeHelpers({ sigFile: path.join(TMP, "s6.jsonl"), legs: { bid: 0.95, ask: 1.05, mid: 1.0 } });
  const r = (await captureAsync(() => h.api.snapQuoteLegs("QQQ261029P00730000"))).out;
  check("يعيد bid/ask/mid", r && r.bid === 0.95 && r.ask === 1.05 && r.mid === 1.0, r, { bid: 0.95, ask: 1.05, mid: 1 });
  check("مهلة 3000ms", h.calls[0].timeoutMs === 3000, h.calls[0].timeoutMs, 3000);
  check("نداء واحد فقط", h.calls.length === 1, h.calls.length, 1);
  const h2 = makeHelpers({ sigFile: path.join(TMP, "s6b.jsonl"), legsThrows: true });
  const r2 = await captureAsync(() => h2.api.snapQuoteLegs("X"));
  check("يرمي ⇒ null لا استثناء", r2.err === undefined && r2.out === null, { err: String(r2.err), out: r2.out }, null);
  const h3 = makeHelpers({ sigFile: path.join(TMP, "s6c.jsonl"), legs: null });
  check("بلا اقتباس ⇒ null", (await captureAsync(() => h3.api.snapQuoteLegs("X"))).out === null, "not null", null);
}

// ── 7) the pinned phase A regions are untouched ───────────
console.log("\n── 7) مناطق المرحلة A المثبّتة لم تُلمس ──");
{
  const PINNED = [
    ["حارس F2 (untrusted)", /if \(PROFIT_FLOOR_ENABLED && dayCtx\?\.trusted === false\) \{[\s\S]*?\n  \}/],
    ["كتلة PROFIT-FLOOR GATE", /if \(dayCtx\?\.armed\) \{[\s\S]*?\n    qty = sized;\n  \}/],
    ["getQuoteLegs()", /async function getQuoteLegs\(optSym\) \{[\s\S]*?\n\}/],
    ["getQuote()", /async function getQuote\(optSym\) \{[\s\S]*?\n\}/],
    ["calcQty()", /function calcQty\([\s\S]*?\n\}/],
    ["getTodayRealizedDay()", /function getTodayRealizedDay\(\) \{[\s\S]*?\n\}/],
    ["alpaca()", /async function alpaca\([\s\S]*?\n\}/],
    ["monitorPosition()", /async function monitorPosition\([\s\S]*?\n\}/],
    ["computeSignal()", /function computeSignal\(bars, params\) \{[\s\S]*?\n\}/],
    ["positionBucket()", /function positionBucket\([\s\S]*?\n\}/],
  ];
  for (const [label, re] of PINNED) {
    check(`${label} مطابق لـ ${BASE_SHA.slice(0, 8)}`,
      grab(src, re, label) === grab(base, re, `${label} base`), "changed", "identical");
  }
  // and the shadow must stay out of monitorPosition entirely
  const mp = grab(src, /async function monitorPosition\([\s\S]*?\n\}/, "mp");
  check("monitorPosition لا يعرف شيئاً عن الظل",
    !/logSignal|bumpSigCount|queueFollowup|snapQuoteLegs|runShadowFollowups/.test(mp), "knows", "clean");
}

// ── 8) record shape and byte size ─────────────────────────
console.log("\n── 8) شكل السجل وحجمه ──");
{
  const f = path.join(TMP, "s8.jsonl");
  const h = makeHelpers({ sigFile: f });
  const st = {};
  const full = {
    day: "2026-10-29", symbol: "QQQ", signal: "PUT", barTime: "2026-10-29T14:00:00Z",
    hourCT: 9, dow: "Thu", regime: "bearish", emaFast: 730.1, emaSlow: 731.2,
    emaGapPct: -0.15, breakoutHigh: 733, breakoutLow: 729, marginPct: 0.12,
    rangePct: 0.55, volRatio: 1.52, lastClose: 728.1, lastVolume: 123456,
    spot: 728.3, vwapAtEntry: 730.5, rsiAtEntry: 31.2, vwapDistPct: -0.30,
    positionBucket: "near_low", comboKey: "PUT|position:near_low", sizeMultiplier: 1,
    openPositions: 1, dayNet: -120, dayArmed: false, dayBudget: 0,
    optionSymbol: "QQQ261029P00730000", strike: 730, premium: 1.0,
    bid: 0.95, ask: 1.05, spreadPct: 10.0, qty: 3, cost1: 100,
  };
  h.api.logSignal(st, full, "taken", null);
  const line = h.appended[0].line;
  const rec = JSON.parse(line);
  check('type = "signal"', rec.type === "signal", rec.type, "signal");
  const WANT = Object.keys(full).concat(["type", "decision", "reason", "loggedAt"]);
  check(`كل الحقول موجودة (${WANT.length})`, WANT.every(k => k in rec),
    WANT.filter(k => !(k in rec)), []);
  check("لا NaN ولا undefined", !/NaN|undefined/.test(line), line.slice(0, 120), "clean");
  console.log(`      → سجل كامل = ${line.length} بايت`);
  check("حجم السجل أقل من 1 كيبي", line.length < 1024, line.length, "< 1024");
}

// ── 9) outcomes record stays additive ─────────────────────
console.log("\n── 9) سجل outcomes يبقى إضافياً فقط ──");
{
  const RE_LT = /function logTrade\(pos, symbol, exitPremium, reason, fillSource, exitStockPrice, exitFill = null\) \{[\s\S]*?\n\}/;
  const mk = text => {
    const written = [];
    const fsStub = { readFileSync: () => "", appendFileSync: (_f, l) => written.push(l) };
    return { fn: new Function("fs", "getToday", `${grab(text, RE_LT, "logTrade")}\nreturn logTrade;`)(fsStub, () => "2026-10-29"), written };
  };
  const POS = { signal: "PUT", optionSymbol: "QQQ261029P00730000", strike: 730,
    entryPremium: 1.0, qty: 3, entryTime: 1792000000000, ladder1: true, ladder2: false,
    stopPct: 12, peakPct: 8.1, stopOrderId: "s1", hardStopPrice: 0.7,
    entryConditions: { x: 1 }, strategyVersion: 1,
    entryFillPrice: 1.02, entryFillConfirmed: true, fillSourceEntry: "entry_order", entryFilledAt: null,
    entryBid: 0.95, entryAsk: 1.05, entrySpreadPct: 10.0 };
  const RealDate = globalThis.Date, FROZEN = 1792100000000;
  globalThis.Date = class extends RealDate {
    constructor(...a) { a.length ? super(...a) : super(FROZEN); }
    static now() { return FROZEN; }
  };
  try {
    const a = mk(src), b = mk(base);
    const args = [POS, "QQQ", 1.2, "ladder_stop", "order_fill", 728.0, { price: 1.18, confirmed: true, source: "sell_order", filledAt: null }];
    a.fn(...args); b.fn(...args);
    const rNew = JSON.parse(a.written[0]), rOld = JSON.parse(b.written[0]);
    const changed = Object.keys(rOld).filter(k => JSON.stringify(rOld[k]) !== JSON.stringify(rNew[k]));
    check(`لا حقل من حقول ${BASE_SHA.slice(0, 8)} تغيّر (${Object.keys(rOld).length} حقلاً)`,
      changed.length === 0, changed, []);
    const oldPrefix = b.written[0].trimEnd().replace(/\}$/, "");
    check("سطر الأساس بادئة حرفية للجديد", a.written[0].startsWith(oldPrefix),
      a.written[0].slice(0, 80) + "…", oldPrefix.slice(0, 80) + "…");
    for (const k of ["entryBid", "entryAsk", "entrySpreadPct"])
      check(`${k} مُسجَّل`, rNew[k] === POS[k], rNew[k], POS[k]);
    check("الحقول الجديدة بعد pnlPctAtFill",
      a.written[0].indexOf('"entryBid"') > a.written[0].indexOf('"pnlPctAtFill"'), "out of order", "appended");
    // an older position without them reads null, not undefined
    const c = mk(src);
    const bare = { ...POS }; delete bare.entryBid; delete bare.entryAsk; delete bare.entrySpreadPct;
    c.fn(bare, "QQQ", 1.2, "ladder_stop", "order_fill", 728.0, null);
    const rBare = JSON.parse(c.written[0]);
    check("مركز قديم ⇒ null لا undefined",
      rBare.entryBid === null && rBare.entryAsk === null && rBare.entrySpreadPct === null,
      { b: rBare.entryBid, a: rBare.entryAsk, s: rBare.entrySpreadPct }, "all null");
  } finally { globalThis.Date = RealDate; }
}

// ── 10) source-level placement ────────────────────────────
console.log("\n── 10) موضع الاستدعاء في المصدر ──");
{
  const se = grab(src, RE.scanEntry, "scanEntry");
  check("لا saveState داخل أي مسار ظل",
    (se.match(/logSignal\([^)]*\);\s*saveState/g) || []).length === 0, "saves", "no extra save");
  check("snapQuoteLegs قبل أمر الشراء",
    se.indexOf("snapQuoteLegs(opt.symbol)") < se.indexOf('alpaca("/orders", "POST"'), "after", "before");
  check('سجل "taken" بعد saveState',
    se.indexOf('logSignal(state, snap, "taken"') > se.indexOf("saveState(state);"), "before", "after");
  check("runShadowFollowups في فرع monitor فقط",
    /if \(MODE === "monitor"\) \{\n    await runShadowFollowups\(state\);\n  \}/.test(src), "missing", "monitor only");
  check("runShadowFollowups قبل الحفظ الأخير",
    src.indexOf("await runShadowFollowups(state);") < src.lastIndexOf("saveState(state);"), "after", "before");
  check("كل بوابة بعد computeSignal تُسجِّل",
    ["cooldown", "no_spot", "no_option", "order_failed"].every(r => se.includes(`"${r}"`)),
    ["cooldown", "no_spot", "no_option", "order_failed"].filter(r => !se.includes(`"${r}"`)), []);
  check("البوابات المبكرة تعدّ فقط",
    ["already_active", "live_in_alpaca", "past_last_entry", "max_open_positions", "day_stopped", "daily_loss_cap", "no_signal"]
      .every(r => se.includes(`bumpSigCount(state, "${r}")`)), "missing", "all present");
}

} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(` نجح ${pass} | فشل ${fail}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
