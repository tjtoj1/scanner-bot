// ============================================================
// PHASE 1 (detection only) TEST SUITE — no network, no API keys.
//
// Every function under test is EXTRACTED BY TEXT from the real
// scan_*.js files and run with stubbed alpaca / getOwnedQty / tg /
// alertOps / fs. So the code exercised here is literally the code that
// ships, not a copy of it — if a source line changes and the extraction
// regex no longer matches, this suite fails loudly rather than silently
// testing nothing.
//
// The regression checks additionally re-extract logTrade from
// `git show origin/main:scan_*.js` (the version before this change) and
// compare both outputs on identical input, so pnl / pnlPct / win /
// reason / fillSource are proven byte-for-byte unchanged.
//
// Run:  node test_stop_detect.mjs
// ============================================================
import fs from "fs";
import { execFileSync } from "child_process";

const FILES = {
  v21:  "scan_v21.js",
  lab:  "scan_lab.js",
  wvad: "scan_wvad.js",
};

const src  = {};   // current working-tree source
const base = {};   // the same file at origin/main (pre-change)
for (const [bot, file] of Object.entries(FILES)) {
  src[bot] = fs.readFileSync(file, "utf8");
  base[bot] = execFileSync("git", ["show", `origin/main:${file}`], { maxBuffer: 1 << 28 }).toString();
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── capture console.error/warn/log without losing the test output ──
function capture(fn) {
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: fn(), lines }; }
  finally { Object.assign(console, orig); }
}
async function captureAsync(fn) {
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: await fn(), lines }; }
  finally { Object.assign(console, orig); }
}

// ════════════════════════════════════════════════════════════
// Builders: the real source text, closed over stubs
// ════════════════════════════════════════════════════════════
const HELPERS = bot => [
  grab(src[bot], /function brief\(x, max = 500\) \{[\s\S]*?\n\}/, `brief/${bot}`),
  grab(src[bot], /function stopOrderIdOrNull\(label, raw\) \{[\s\S]*?\n\}/, `stopOrderIdOrNull/${bot}`),
].join("\n");

const makeHelpers = bot =>
  new Function(`${HELPERS(bot)}\nreturn { brief, stopOrderIdOrNull };`)();

const makeIsoOrNull = () =>
  new Function(`${grab(src.v21, /function isoOrNull\(v\) \{[\s\S]*?\n\}/, "isoOrNull")}\nreturn isoOrNull;`)();

// updateStopOrder, closed over stubs. Returns the live `pos` so the test
// can read what the function wrote back onto it.
function makeUpdateStopOrder(bot, { alpaca, getOwnedQty, tg }) {
  const fn = grab(src[bot], /async function updateStopOrder\(pos, newStopPrice\) \{[\s\S]*?\n\}/, `updateStopOrder/${bot}`);
  return new Function("alpaca", "getOwnedQty", "tg",
    `${HELPERS(bot)}\n${fn}\nreturn updateStopOrder;`)(alpaca, getOwnedQty, tg);
}

function makeGetExitFill(alpaca) {
  const t = grab(src.v21, /const FILL_LOOKUP_TIMEOUT_MS = \d+;/, "FILL_LOOKUP_TIMEOUT_MS");
  const g = grab(src.v21, /async function getExitFill\(pos\) \{[\s\S]*?\n\}/, "getExitFill");
  return new Function("alpaca",
    `${grab(src.v21, /function isoOrNull\(v\) \{[\s\S]*?\n\}/, "isoOrNull")}\n${t}\n${g}\nreturn getExitFill;`)(alpaca);
}

// logTrade from either the current tree or origin/main, with fs stubbed.
function makeLogTrade(bot, text) {
  const re = bot === "v21"
    ? /function logTrade\(pos, symbol, exitPremium, reason, fillSource, exitStockPrice, exitFill = null\) \{[\s\S]*?\n\}/
    : /function logTrade\(pos, symbol, exitPremium, reason, fillSource, exitStockPrice\) \{[\s\S]*?\n\}/;
  const fn = grab(text, re, `logTrade/${bot}`);
  const written = [];
  const fsStub = {
    readFileSync: () => "",                       // empty outcomes file: no duplicate
    appendFileSync: (_f, line) => written.push(line),
  };
  const lt = new Function("fs", "getToday", "OUTCOMES_FILE",
    `${fn}\nreturn logTrade;`)(fsStub, () => "2026-10-14", "outcomes_wvad.jsonl");
  return { logTrade: lt, written };
}

// The item-(ج) alert block, lifted verbatim out of the reconcile path.
function makeAlertBlock(bot) {
  const block = grab(src[bot], /\s*if \(unprotected\.length\) \{[\s\S]*?\n      \}/, `alert block/${bot}`);
  const sendName = bot === "wvad" ? "alertOps" : "tg";
  const todayBinding = bot === "wvad" ? "" : "const getToday = () => __today;";
  const todayVar = bot === "wvad" ? "const today = __today;" : "";
  return new Function("state", "unprotected", "__today", "saveState", sendName,
    `${todayBinding}\n${todayVar}\nreturn (async () => {${block}\n})();`);
}

// ════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════════");
console.log(" PHASE 1 — detection-only test suite (no network, no keys)");
console.log("═══════════════════════════════════════════════════════════");

// ── 1) 422 rejection, no id ────────────────────────────────
console.log("\n── 1) رفض 422 بلا id ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const { stopOrderIdOrNull } = makeHelpers(bot);
  const body = { code: 42210000, message: "stop price must be below the current price" };
  const { out, lines } = capture(() => stopOrderIdOrNull("SPY entry stop", body));
  check(`${bot}: يُرجع null`, out === null, out, null);
  check(`${bot}: يسجّل REJECTED`, lines.some(l => l.includes("REJECTED")), lines, "…REJECTED…");
  check(`${bot}: جسم الرد كامل في اللوق`, lines.some(l => l.includes("42210000") && l.includes("stop price must be below")), lines, "body logged");
}

// ── 2) network exception (the catch path, kept distinct) ───
console.log("\n── 2) استثناء شبكي — مسار catch، مميّز عن الرفض ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const boom = async () => { throw new Error("The operation was aborted"); };
  const u = makeUpdateStopOrder(bot, {
    alpaca: boom,
    getOwnedQty: async () => 4,
    tg: async () => null,
  });
  const pos = { optionSymbol: "SPY261014P00760000", qty: 4, stopOrderId: "OLD-1", msgId: 1 };
  const { lines } = await captureAsync(() => u(pos, 1.05));
  check(`${bot}: لا يرمي للأعلى`, true, "no throw", "no throw");
  check(`${bot}: يميّز THREW عن REJECTED`,
    lines.some(l => l.includes("THREW")) && !lines.some(l => l.includes("REJECTED")),
    lines, "THREW, not REJECTED");
  check(`${bot}: stopOrderId لم يُلمس (الوقف القديم ما زال حياً نظرياً)`,
    pos.stopOrderId === "OLD-1", pos.stopOrderId, "OLD-1");
}

// ── 3) success ─────────────────────────────────────────────
console.log("\n── 3) نجاح ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const { stopOrderIdOrNull } = makeHelpers(bot);
  const { out, lines } = capture(() => stopOrderIdOrNull("SPY entry stop", { id: "ORD-NEW", status: "new" }));
  check(`${bot}: يُرجع المعرّف`, out === "ORD-NEW", out, "ORD-NEW");
  check(`${bot}: لا سطر خطأ`, !lines.some(l => l.includes("REJECTED")), lines, "no error line");
}
{
  const u = makeUpdateStopOrder("v21", {
    alpaca: async (p, m) => (m === "DELETE" ? {} : { id: "ORD-NEW" }),
    getOwnedQty: async () => 4,
    tg: async () => null,
  });
  const pos = { optionSymbol: "SPY261014P00760000", qty: 4, stopOrderId: "OLD-1" };
  await captureAsync(() => u(pos, 1.05));
  check("v21: المعرّف الجديد مكتوب على pos", pos.stopOrderId === "ORD-NEW", pos.stopOrderId, "ORD-NEW");
}

// ── 4) DELETE succeeds, POST rejected ─────────────────────
console.log("\n── 4) DELETE ناجح + POST مرفوض ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const calls = [];
  const u = makeUpdateStopOrder(bot, {
    alpaca: async (path, method) => {
      calls.push(`${method || "GET"} ${path}`);
      if (method === "DELETE") return {};                       // cancel succeeded
      return { code: 40310000, message: "insufficient qty available for order" };
    },
    getOwnedQty: async () => 4,
    tg: async () => null,
  });
  const pos = { optionSymbol: "SPY261014P00760000", qty: 4, stopOrderId: "OLD-1", msgId: 1 };
  const { lines } = await captureAsync(() => u(pos, 1.05));
  check(`${bot}: الوقف القديم أُلغي فعلاً`, calls.some(c => c.startsWith("DELETE")), calls, "DELETE issued");
  check(`${bot}: stopOrderId أصبح null لا المعرّف الملغى`, pos.stopOrderId === null, pos.stopOrderId, null);
  check(`${bot}: الرفض وجسمه في اللوق`,
    lines.some(l => l.includes("REJECTED") && l.includes("40310000")), lines, "REJECTED + body");
}

// ── 5) a WRONG ownedQty = 0 ───────────────────────────────
console.log("\n── 5) ownedQty=0 خاطئ (المركز موجود فعلاً) ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const calls = [];
  const u = makeUpdateStopOrder(bot, {
    alpaca: async (path, method) => { calls.push(`${method || "GET"} ${path}`); return {}; },
    getOwnedQty: async () => 0,          // Alpaca wrongly says "flat"
    tg: async () => null,
  });
  const pos = { optionSymbol: "IWM261013P00240000", qty: 9, stopOrderId: "OLD-1", msgId: 1 };
  await captureAsync(() => u(pos, 0.78));
  check(`${bot}: الوقف أُلغي`, calls.some(c => c.startsWith("DELETE")), calls, "DELETE issued");
  check(`${bot}: ولم يُوضع بديل`, !calls.some(c => c.startsWith("POST")), calls, "no POST");
  check(`${bot}: stopOrderId = null ⇒ المرحلة 1 ستكشفه في التسوية`, pos.stopOrderId === null, pos.stopOrderId, null);
}
// and the detection itself fires on exactly that state
for (const bot of ["v21", "lab", "wvad"]) {
  let sent = null, saved = 0;
  const state = { IWM: { active: true, optionSymbol: "IWM261013P00240000", entryPremium: 0.745, stopOrderId: null } };
  await makeAlertBlock(bot)(state, ["IWM"], "2026-10-14", () => saved++, async t => { sent = t; });
  check(`${bot}: التنبيه أُرسل عن المركز غير المحمي`, !!sent && sent.includes("IWM"), sent, "alert naming IWM");
  check(`${bot}: العلم حُفظ في الحالة`,
    eq(state._noStopAlerted, { day: "2026-10-14", symbols: ["IWM"] }), state._noStopAlerted, { day: "2026-10-14", symbols: ["IWM"] });
  check(`${bot}: saveState نُفِّذ قبل الإرسال`, saved === 1, saved, 1);
}

// ── 6) the flag suppresses a repeat, across a reload ──────
console.log("\n── 6) العلم يمنع التكرار — وبعد إعادة تحميل الحالة من القرص ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const mk = () => ({ IWM: { active: true, optionSymbol: "IWM261013P00240000", entryPremium: 0.745, stopOrderId: null } });
  let n = 0;
  const send = async () => { n++; };
  const state = mk();
  await makeAlertBlock(bot)(state, ["IWM"], "2026-10-14", () => {}, send);
  await makeAlertBlock(bot)(state, ["IWM"], "2026-10-14", () => {}, send);
  check(`${bot}: تنبيه واحد داخل نفس العملية`, n === 1, n, 1);

  // simulate the child dying and a NEW process loading state from disk
  const reloaded = JSON.parse(JSON.stringify(state));
  await makeAlertBlock(bot)(reloaded, ["IWM"], "2026-10-14", () => {}, send);
  check(`${bot}: ولا تنبيه بعد إعادة التحميل (علم مُثابر لا ذاكرة)`, n === 1, n, 1);

  // a new day resets
  await makeAlertBlock(bot)(reloaded, ["IWM"], "2026-10-15", () => {}, send);
  check(`${bot}: يوم جديد ⇒ تنبيه جديد`, n === 2, n, 2);

  // a NEW symbol going unprotected still alerts, and only about the new one
  let txt = null;
  reloaded.QQQ = { active: true, optionSymbol: "QQQ261014P00600000", entryPremium: 1.1, stopOrderId: null };
  await makeAlertBlock(bot)(reloaded, ["IWM", "QQQ"], "2026-10-15", () => {}, async t => { txt = t; });
  check(`${bot}: الرمز الجديد يُنبّه عنه`, !!txt && txt.includes("QQQ"), txt, "alert naming QQQ");
  check(`${bot}: ولا يُعاد ذكر الرمز القديم`, !!txt && !txt.includes("IWM"), txt, "no IWM");
}

// ── 7) three symbols = ONE aggregated message ─────────────
console.log("\n── 7) ثلاثة رموز ⇒ رسالة واحدة مُجمَّعة ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const msgs = [];
  const state = {
    SPY:  { active: true, optionSymbol: "SPY261014P00760000", entryPremium: 0.8, stopOrderId: null },
    QQQ:  { active: true, optionSymbol: "QQQ261014P00600000", entryPremium: 1.1, stopOrderId: null },
    NVDA: { active: true, optionSymbol: "NVDA261017P00220000", entryPremium: 2.1, stopOrderId: null },
  };
  await makeAlertBlock(bot)(state, ["SPY", "QQQ", "NVDA"], "2026-10-14", () => {}, async t => msgs.push(t));
  check(`${bot}: رسالة واحدة لا ثلاث`, msgs.length === 1, msgs.length, 1);
  check(`${bot}: تذكر الرموز الثلاثة`,
    msgs[0] && ["SPY", "QQQ", "NVDA"].every(s => msgs[0].includes(s)), msgs[0], "all three");
  check(`${bot}: وتذكر رمز العقد`, msgs[0] && msgs[0].includes("SPY261014P00760000"), msgs[0], "option symbol");
  check(`${bot}: العلم يحمل الثلاثة`,
    eq(state._noStopAlerted.symbols, ["SPY", "QQQ", "NVDA"]), state._noStopAlerted, ["SPY", "QQQ", "NVDA"]);
}
// an empty list must send nothing at all
for (const bot of ["v21", "lab", "wvad"]) {
  let n = 0;
  const state = {};
  await makeAlertBlock(bot)(state, [], "2026-10-14", () => {}, async () => { n++; });
  check(`${bot}: لا مراكز غير محمية ⇒ لا رسالة ولا علم`,
    n === 0 && state._noStopAlerted === undefined, { n, flag: state._noStopAlerted }, { n: 0, flag: undefined });
}

// ── 8) logTrade: new fields + byte-for-byte regression ────
console.log("\n── 8) logTrade: الحقول الجديدة + انحدار بايت ببايت ──");
const POS_FULL = {
  signal: "PUT", optionSymbol: "NVDA261012P00227500", strike: 227.5,
  entryPremium: 2.135, qty: 2, entryTime: 1791814547496,
  level: 227.21, ladder1: true, ladder2: false,
  stopPct: 5, trailPct: undefined, peakPct: 10.304449648711953,
  stopOrderId: "d420c7d1-aaaa-bbbb-cccc-000000000001", hardStopPrice: 1.39,
  entryStockPrice: 227.4, vwapAtEntry: 227.1, rsiAtEntry: 41.2, volumeRatio: 1.8,
  signalType: "breakout", entryConditions: { x: 1 }, strategyVersion: "v7",
  wvadSumAtEntry: -12.5, signalLineAtEntry: -3.1, atrAtEntry: 1.2, slStock: 230.1, dte: 0,
};
const POS_BARE = {   // a position with no ladder, no stop order at all
  signal: "CALL", optionSymbol: "SPY261014C00780000", strike: 780,
  entryPremium: 0.8, qty: 6, entryTime: 1791814545475, level: 778.675,
  stopOrderId: null, hardStopPrice: 0.52,
};
const EXIT_FILL = { price: 2.2, confirmed: true, source: "stop_order", filledAt: "2026-10-12T14:25:02.000Z" };

for (const bot of ["v21", "lab", "wvad"]) {
  const now = makeLogTrade(bot, src[bot]);
  const old = makeLogTrade(bot, base[bot]);
  const args = bot === "v21"
    ? [POS_FULL, "NVDA", 2.16, "alpaca_stop", "quote_at_detection", 227.0, EXIT_FILL]
    : [POS_FULL, "NVDA", 2.16, "alpaca_stop", "quote_at_detection", 227.0];

  capture(() => now.logTrade(...args));
  capture(() => old.logTrade(...args));
  const rNew = JSON.parse(now.written[0]);
  const rOld = JSON.parse(old.written[0]);

  // (a) byte-for-byte: every field the OLD version wrote is identical
  const changed = Object.keys(rOld).filter(k => JSON.stringify(rOld[k]) !== JSON.stringify(rNew[k]));
  check(`${bot}: لا حقل قديم تغيّر (${Object.keys(rOld).length} حقلاً)`, changed.length === 0, changed, []);

  // (b) the five fields named in the condition, checked explicitly
  for (const k of ["pnl", "pnlPct", "win", "reason", "fillSource"]) {
    check(`${bot}: ${k} مطابق تماماً (${JSON.stringify(rNew[k])})`,
      JSON.stringify(rOld[k]) === JSON.stringify(rNew[k]), rNew[k], rOld[k]);
  }

  // (c) the serialized prefix is unchanged, so logTrade's substring
  //     duplicate guard ('"tradeId":"…"') still matches as before
  const oldLine = old.written[0].trimEnd().replace(/\}$/, "");
  check(`${bot}: التسلسل القديم بادئة حرفية للجديد (حارس التكرار سليم)`,
    now.written[0].startsWith(oldLine), now.written[0].slice(0, 80) + "…", oldLine.slice(0, 80) + "…");

  // (d) the new fields are present and correct
  const wantNew = {
    ladder1: true, ladder2: false, stopPct: 5, trailPct: null,
    peakPct: 10.3, stopOrderIdAtExit: "d420c7d1-aaaa-bbbb-cccc-000000000001", hardStopPrice: 1.39,
  };
  for (const [k, v] of Object.entries(wantNew)) {
    check(`${bot}: ${k} = ${JSON.stringify(v)}`, JSON.stringify(rNew[k]) === JSON.stringify(v), rNew[k], v);
  }
  check(`${bot}: peakPct مُدوَّر لخانة واحدة كما pnlPct`, rNew.peakPct === 10.3, rNew.peakPct, 10.3);

  // (e) a bare position must not produce undefined or NaN anywhere
  const bare = makeLogTrade(bot, src[bot]);
  const bareArgs = bot === "v21"
    ? [POS_BARE, "SPY", 0.86, "ladder_stop", "order_fill", 779.0, null]
    : [POS_BARE, "SPY", 0.86, "ladder_stop", "order_fill", 779.0];
  capture(() => bare.logTrade(...bareArgs));
  const rBare = JSON.parse(bare.written[0]);
  check(`${bot}: مركز بلا سلّم ⇒ ladder1=false وstopPct=null`,
    rBare.ladder1 === false && rBare.stopPct === null, { l: rBare.ladder1, s: rBare.stopPct }, { l: false, s: null });
  check(`${bot}: stopOrderIdAtExit=null يرصد "بلا وقف"`, rBare.stopOrderIdAtExit === null, rBare.stopOrderIdAtExit, null);
  check(`${bot}: لا NaN ولا undefined في السجل`,
    !/NaN|undefined/.test(bare.written[0]), bare.written[0].slice(0, 120), "clean");
}

// v21 only: exitFilledAt
console.log("\n── 8b) v21: exitFilledAt ──");
{
  const a = makeLogTrade("v21", src.v21);
  capture(() => a.logTrade(POS_FULL, "NVDA", 2.16, "alpaca_stop", "quote_at_detection", 227.0, EXIT_FILL));
  const r = JSON.parse(a.written[0]);
  check("exitFilledAt من filledAt", r.exitFilledAt === "2026-10-12T14:25:02.000Z", r.exitFilledAt, EXIT_FILL.filledAt);
  check("exitFillPrice/Confirmed/Source لم تتغيّر",
    r.exitFillPrice === 2.2 && r.exitPriceConfirmed === true && r.exitFillSource === "stop_order",
    [r.exitFillPrice, r.exitPriceConfirmed, r.exitFillSource], [2.2, true, "stop_order"]);

  const b = makeLogTrade("v21", src.v21);
  capture(() => b.logTrade(POS_FULL, "NVDA", 2.16, "ladder_stop", "order_fill", 227.0, null));
  const r2 = JSON.parse(b.written[0]);
  check("مسار محلي (exitFill=null) ⇒ exitFilledAt=null والثلاثية null",
    r2.exitFilledAt === null && r2.exitFillPrice === null && r2.exitPriceConfirmed === null && r2.exitFillSource === null,
    [r2.exitFilledAt, r2.exitFillPrice, r2.exitPriceConfirmed, r2.exitFillSource], [null, null, null, null]);
}

// getExitFill now carries filledAt on all five return shapes
console.log("\n── 8c) getExitFill: filledAt على كل المسارات ──");
{
  const POS = { optionSymbol: "SPY261008P00760000", qty: 4, entryTime: 1791800000000, stopOrderId: "ORD-1" };
  const T = ms => new Date(POS.entryTime + ms).toISOString();

  let g = makeGetExitFill(async () => ({ status: "filled", filled_avg_price: "1.07", filled_qty: "4", filled_at: T(60000) }));
  let r = await captureAsync(() => g(POS));
  check("طبقة 1 نظيفة ⇒ filledAt من filled_at",
    eq(r.out, { price: 1.07, confirmed: true, source: "stop_order", filledAt: T(60000) }), r.out, "stop_order + filledAt");

  g = makeGetExitFill(async () => ({ status: "filled", filled_avg_price: "1.07", filled_qty: "3", filled_at: T(60000) }));
  r = await captureAsync(() => g(POS));
  check("طبقة 1 بكمية مختلفة ⇒ confirmed=false مع filledAt",
    r.out.confirmed === false && r.out.source === "stop_order_qty_mismatch" && r.out.filledAt === T(60000), r.out, "qty_mismatch + filledAt");

  g = makeGetExitFill(async () => ({ status: "filled", filled_avg_price: "1.07", filled_qty: "4", filled_at: "not-a-date" }));
  r = await captureAsync(() => g(POS));
  check("filled_at غير صالح ⇒ filledAt=null بلا رمي", r.out.filledAt === null && r.out.confirmed === true, r.out, "filledAt null");

  const act = (o = {}) => ({ symbol: POS.optionSymbol, side: "sell", price: "1.11", qty: "2", order_id: "OS-1", transaction_time: T(30000), ...o });
  g = makeGetExitFill(async path => path.startsWith("/orders/")
    ? { status: "canceled" }
    : [act(), act({ transaction_time: T(90000), price: "1.09" })]);
  r = await captureAsync(() => g(POS));
  check("طبقة 2 ⇒ filledAt هو أحدث تنفيذ",
    r.out.source === "fill_activity" && r.out.filledAt === T(90000), r.out, `fill_activity @ ${T(90000)}`);

  g = makeGetExitFill(async () => { throw new Error("boom"); });
  r = await captureAsync(() => g(POS));
  check("فشل كل الطبقات ⇒ الشكل الكامل بـfilledAt=null",
    eq(r.out, { price: null, confirmed: false, source: "none", filledAt: null }), r.out, "miss shape");
}

// brief(): the 500-char bound and no-throw contract
console.log("\n── إضافي) brief(): حدّ 500 حرف ولا يرمي أبداً ──");
for (const bot of ["v21", "lab", "wvad"]) {
  const { brief } = makeHelpers(bot);
  const long = { message: "x".repeat(3000) };
  const s = brief(long);
  check(`${bot}: الطول محدود`, s.length <= 500 + 30, s.length, "≤530");
  check(`${bot}: يذكر ما حُذف`, s.includes("chars]"), s.slice(-30), "…[+N chars]");
  const circular = {}; circular.self = circular;
  let threw = false;
  try { brief(circular); } catch { threw = true; }
  check(`${bot}: لا يرمي على مرجع دائري`, !threw, threw, false);
  check(`${bot}: undefined ⇒ (empty)`, brief(undefined) === "(empty)", brief(undefined), "(empty)");
  check(`${bot}: نص خام يُمرَّر كما هو`, brief("plain text") === "plain text", brief("plain text"), "plain text");
}

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(` نجح ${pass} | فشل ${fail}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
