// ============================================================
// TIER-1 DAILY STOP RULES — TEST SUITE. No network, no API keys.
//
// getTodayRealizedDay(), getTodayRealizedPnl() and the scanEntry gate are
// EXTRACTED BY TEXT from the real scan_v21.js / scan_lab.js and run
// against a stubbed fs. If a regex stops matching, the suite throws
// instead of silently testing nothing.
//
// Regression baseline: origin/main (the branch point), against which the
// old getTodayRealizedPnl() is replayed on the REAL outcomes files and
// compared value-for-value, and the tier-2 force-close paths are asserted
// unchanged by text.
//
// Run:  node test_daily_stop.mjs
// ============================================================
import fs from "fs";
import { execFileSync } from "child_process";

const BASE_REF = "origin/main";
const FILES = { v21: "scan_v21.js", lab: "scan_lab.js" };
const OUTCOMES = { v21: "outcomes_v21.jsonl", lab: "outcomes_lab.jsonl" };
const lf = s => s.replace(/\r\n/g, "\n");

const src = {}, base = {};
for (const [bot, file] of Object.entries(FILES)) {
  src[bot]  = lf(fs.readFileSync(file, "utf8"));
  base[bot] = lf(execFileSync("git", ["show", `${BASE_REF}:${file}`], { maxBuffer: 1 << 28 }).toString());
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

function capture(fn) {
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: fn(), lines }; }
  finally { Object.assign(console, orig); }
}

// ════════════════════════════════════════════════════════════
// Extraction + builders
// ════════════════════════════════════════════════════════════
const RE = {
  day:   /function getTodayRealizedDay\(\) \{[\s\S]*?\n\}/,
  wrap:  /function getTodayRealizedPnl\(\) \{ return getTodayRealizedDay\(\)\.net; \}/,
  oldFn: /function getTodayRealizedPnl\(\) \{\n  const today = getToday\(\);[\s\S]*?\n\}/,
  loss:  /const STOP_DAY_LOSS\s*=\s*-?\d+;/,
  arm:   /const PROFIT_ARM\s*=\s*-?\d+;/,
  give:  /const PROFIT_GIVEBACK\s*=\s*-?\d+;/,
};

const CONSTS = bot => [
  grab(src[bot], RE.loss, `STOP_DAY_LOSS/${bot}`),
  grab(src[bot], RE.arm,  `PROFIT_ARM/${bot}`),
  grab(src[bot], RE.give, `PROFIT_GIVEBACK/${bot}`),
].join("\n");

// The real getTodayRealizedDay, closed over a fake fs and a fixed "today".
function makeDay(bot, fileText, today = "2026-10-20") {
  const fn = grab(src[bot], RE.day, `getTodayRealizedDay/${bot}`);
  const wrap = grab(src[bot], RE.wrap, `getTodayRealizedPnl wrapper/${bot}`);
  const fsStub = {
    readFileSync: () => { if (fileText === null) throw new Error("ENOENT"); return fileText; },
  };
  return new Function("fs", "getToday",
    `${CONSTS(bot)}\n${fn}\n${wrap}\nreturn { getTodayRealizedDay, getTodayRealizedPnl };`
  )(fsStub, () => today);
}

// The ORIGINAL getTodayRealizedPnl from origin/main, same fake fs.
function makeOld(bot, fileText, today = "2026-10-20") {
  const fn = grab(base[bot], RE.oldFn, `old getTodayRealizedPnl/${bot}`);
  const fsStub = {
    readFileSync: () => { if (fileText === null) throw new Error("ENOENT"); return fileText; },
  };
  return new Function("fs", "getToday", `${fn}\nreturn getTodayRealizedPnl;`)(fsStub, () => today);
}

// Build a JSONL log. `trades` is a list of pnl values (in intended close
// order); exitTime is synthesised one minute apart.
const DAY = "2026-10-20";
function logOf(trades, { day = DAY, reverse = false, extraDays = [] } = {}) {
  const rows = trades.map((pnl, i) => ({
    day, tradeId: `SYM_${i}`, pnl,
    exitTime: new Date(Date.parse(`${day}T14:00:00Z`) + i * 60000).toISOString(),
  }));
  if (reverse) rows.reverse();
  return [...rows, ...extraDays].map(r => JSON.stringify(r)).join("\n") + "\n";
}
const otherDay = (day, pnl, i = 0) => ({
  day, tradeId: `OTHER_${day}_${i}`, pnl,
  exitTime: new Date(Date.parse(`${day}T14:00:00Z`) + i * 60000).toISOString(),
});

const LIMITS = {
  v21: { loss: -280, arm: 170, give: 85 },
  lab: { loss: -500, arm: 300, give: 150 },
};

console.log("\n═══════════════════════════════════════════════════════════");
console.log(" TIER-1 DAILY STOP RULES — no network, no keys");
console.log(`  baseline: ${BASE_REF}`);
console.log("═══════════════════════════════════════════════════════════");

// ── 0) the constants really are what was approved ─────────
console.log("\n── 0) الثوابت المعتمدة ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  check(`${bot}: STOP_DAY_LOSS = ${L.loss}`, grab(src[bot], RE.loss).includes(String(L.loss)), grab(src[bot], RE.loss), L.loss);
  check(`${bot}: PROFIT_ARM = ${L.arm}`, new RegExp(`=\\s*${L.arm};`).test(grab(src[bot], RE.arm)), grab(src[bot], RE.arm), L.arm);
  check(`${bot}: PROFIT_GIVEBACK = ${L.give}`, new RegExp(`=\\s*${L.give};`).test(grab(src[bot], RE.give)), grab(src[bot], RE.give), L.give);
}
check("lab: الثوابت داخل كتلة HARD SAFETY LIMITS (بعيدة عن التهيئة الذاتية)",
  /HARD SAFETY LIMITS[\s\S]*?const STOP_DAY_LOSS[\s\S]*?const MARKET_OPEN_UTC/.test(src.lab), "n/a", "inside the block");
check("lab: لا يوجد STOP_DAY_LOSS في strategy_lab.json params",
  !/STOP_DAY_LOSS|PROFIT_ARM|PROFIT_GIVEBACK/.test(lf(fs.readFileSync("strategy_lab.json", "utf8"))), "n/a", "absent");

// ── 1) empty / unreadable log fails open ──────────────────
console.log("\n── 1) سجل فارغ أو غير مقروء ⇒ يفشل مفتوحاً ──");
for (const bot of ["v21", "lab"]) {
  const miss = makeDay(bot, null).getTodayRealizedDay();
  check(`${bot}: ENOENT ⇒ {net:0,peak:0,stopped:false,reason:null}`,
    eq(miss, { net: 0, peak: 0, stopped: false, reason: null }), miss, { net: 0, peak: 0, stopped: false, reason: null });
  const empty = makeDay(bot, "").getTodayRealizedDay();
  check(`${bot}: ملف فارغ ⇒ نفس الشكل`, eq(empty, { net: 0, peak: 0, stopped: false, reason: null }), empty, "zeros");
  const junk = makeDay(bot, "not json\n{broken\n").getTodayRealizedDay();
  check(`${bot}: أسطر تالفة تُتجاهل بلا رمي`, eq(junk, { net: 0, peak: 0, stopped: false, reason: null }), junk, "zeros");
}

// ── 2) loss boundary: exact ──────────────────────────────
console.log("\n── 2) حدّ الخسارة — الحدود بالضبط ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  const at = makeDay(bot, logOf([L.loss])).getTodayRealizedDay();
  check(`${bot}: net == ${L.loss} ⇒ متوقف (loss)`,
    at.stopped && at.reason === "loss" && at.net === L.loss, at, { stopped: true, reason: "loss" });
  const just = makeDay(bot, logOf([L.loss + 1])).getTodayRealizedDay();
  check(`${bot}: net == ${L.loss + 1} ⇒ غير متوقف`,
    just.stopped === false && just.reason === null && just.net === L.loss + 1, just, { stopped: false });
}

// ── 3) giveback boundary: exact ──────────────────────────
console.log("\n── 3) حماية الربح — الحدود بالضبط ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  // peak exactly ARM, then down to exactly GIVEBACK
  const hit = makeDay(bot, logOf([L.arm, L.give - L.arm])).getTodayRealizedDay();
  check(`${bot}: قمة ${L.arm} ثم صافي ${L.give} ⇒ متوقف (giveback)`,
    hit.stopped && hit.reason === "giveback" && hit.peak === L.arm && hit.net === L.give,
    hit, { stopped: true, reason: "giveback", peak: L.arm, net: L.give });
  // peak one dollar short of ARM, same landing
  const noArm = makeDay(bot, logOf([L.arm - 1, L.give - (L.arm - 1)])).getTodayRealizedDay();
  check(`${bot}: قمة ${L.arm - 1} ثم صافي ${L.give} ⇒ غير متوقف (لم يتسلّح)`,
    noArm.stopped === false && noArm.peak === L.arm - 1 && noArm.net === L.give, noArm, { stopped: false });
  // armed, lands one dollar ABOVE giveback
  const above = makeDay(bot, logOf([L.arm, L.give + 1 - L.arm])).getTodayRealizedDay();
  check(`${bot}: تسلّح ثم صافي ${L.give + 1} (فوق العتبة) ⇒ غير متوقف`,
    above.stopped === false && above.net === L.give + 1, above, { stopped: false });
}

// ── 4) STICKY ────────────────────────────────────────────
console.log("\n── 4) اللصوقية (sticky) ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  // arm, dip to giveback, then recover well above
  const rec = makeDay(bot, logOf([L.arm, L.give - L.arm, 500])).getTodayRealizedDay();
  check(`${bot}: تسلّح ← هبوط للعتبة ← تعافٍ إلى ${L.give + 500} ⇒ ما زال متوقفاً (giveback)`,
    rec.stopped && rec.reason === "giveback" && rec.net === L.give + 500,
    rec, { stopped: true, reason: "giveback", net: L.give + 500 });
  // loss stop then full recovery into profit
  const lrec = makeDay(bot, logOf([L.loss, 900])).getTodayRealizedDay();
  check(`${bot}: حدّ الخسارة ← تعافٍ إلى +${L.loss + 900} ⇒ ما زال متوقفاً (loss)`,
    lrec.stopped && lrec.reason === "loss" && lrec.net === L.loss + 900,
    lrec, { stopped: true, reason: "loss" });
  // never armed, big drawdown -> loss only
  const dd = makeDay(bot, logOf([L.arm - 1, -(L.arm - 1) + L.loss])).getTodayRealizedDay();
  check(`${bot}: لم يتسلّح + هبوط حادّ ⇒ السبب loss لا giveback`,
    dd.stopped && dd.reason === "loss", dd, { stopped: true, reason: "loss" });
}

// ── 5) first condition wins ──────────────────────────────
console.log("\n── 5) أي شرط يسبق هو السبب المسجَّل ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  // giveback occurs at trade 2, loss at trade 3
  const gFirst = makeDay(bot, logOf([L.arm, L.give - L.arm, L.loss - L.give])).getTodayRealizedDay();
  check(`${bot}: giveback أولاً ثم loss ⇒ السبب "giveback"`,
    gFirst.stopped && gFirst.reason === "giveback" && gFirst.net === L.loss, gFirst, { reason: "giveback" });
  // loss occurs at trade 1, then the day climbs and givebacks later
  const lFirst = makeDay(bot, logOf([L.loss, L.arm - L.loss, L.give - L.arm])).getTodayRealizedDay();
  check(`${bot}: loss أولاً ثم giveback ⇒ السبب "loss"`,
    lFirst.stopped && lFirst.reason === "loss" && lFirst.net === L.give, lFirst, { reason: "loss" });
  // both true on the SAME record is impossible (loss < giveback), so the
  // loss branch must win when a single record lands at or below both
  const same = makeDay(bot, logOf([L.arm, L.loss - L.arm])).getTodayRealizedDay();
  check(`${bot}: سجل واحد يهبط تحت العتبتين ⇒ loss له الأسبقية`,
    same.stopped && same.reason === "loss", same, { reason: "loss" });
}

// ── 6) ordering and day isolation ────────────────────────
console.log("\n── 6) الترتيب وعزل الأيام ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  const trades = [L.arm, L.give - L.arm, 500];
  const fwd = makeDay(bot, logOf(trades)).getTodayRealizedDay();
  const rev = makeDay(bot, logOf(trades, { reverse: true })).getTodayRealizedDay();
  check(`${bot}: ترتيب الملف معكوساً ⇒ نفس النتيجة بالضبط`, eq(fwd, rev), rev, fwd);

  const withOthers = makeDay(bot, logOf(trades, {
    extraDays: [otherDay("2026-10-19", -9999), otherDay("2026-10-21", 9999), otherDay("2026-10-19", -500, 1)],
  })).getTodayRealizedDay();
  check(`${bot}: سجلات أيام أخرى تُتجاهل تماماً`, eq(withOthers, fwd), withOthers, fwd);

  const onlyOthers = makeDay(bot, JSON.stringify(otherDay("2026-10-19", -9999)) + "\n").getTodayRealizedDay();
  check(`${bot}: لا سجل لليوم ⇒ أصفار`, eq(onlyOthers, { net: 0, peak: 0, stopped: false, reason: null }), onlyOthers, "zeros");
}

// ── 7) peak tracks the running max, not the final net ────
console.log("\n── 7) القمة = أعلى تراكمي، لا الصافي النهائي ──");
for (const bot of ["v21", "lab"]) {
  const d = makeDay(bot, logOf([100, 50, -30, 10])).getTodayRealizedDay();
  check(`${bot}: قمة 150 وصافي 130`, d.peak === 150 && d.net === 130, d, { peak: 150, net: 130 });
  const neg = makeDay(bot, logOf([-50, -10])).getTodayRealizedDay();
  check(`${bot}: يوم سالب بالكامل ⇒ القمة 0 لا -50`, neg.peak === 0 && neg.net === -60, neg, { peak: 0, net: -60 });
}

// ── 8) REGRESSION: getTodayRealizedPnl() on the REAL logs ─
console.log("\n── 8) انحدار: getTodayRealizedPnl() على السجلات الحقيقية ──");
for (const bot of ["v21", "lab"]) {
  const real = lf(fs.readFileSync(OUTCOMES[bot], "utf8"));
  const days = [...new Set(real.split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l).day; } catch { return null; }
  }).filter(Boolean))].sort();
  let mismatch = 0, checked = 0;
  for (const d of days) {
    const now = makeDay(bot, real, d).getTodayRealizedPnl();
    const old = makeOld(bot, real, d)();
    if (now !== old) mismatch++;
    checked++;
  }
  check(`${bot}: الصافي مطابق على كل الأيام (${checked} يوماً، ${real.split("\n").filter(Boolean).length} سجلاً)`,
    mismatch === 0 && checked > 0, { checked, mismatch }, { checked, mismatch: 0 });
  // and the wrapper is literally net
  const d0 = makeDay(bot, real, days[days.length - 1]);
  check(`${bot}: الغلاف يُرجع net حرفياً`,
    d0.getTodayRealizedPnl() === d0.getTodayRealizedDay().net, d0.getTodayRealizedPnl(), d0.getTodayRealizedDay().net);
}

// ── 9) REGRESSION: tier-2 paths unchanged (by text) ──────
console.log("\n── 9) انحدار: مسارات الطبقة 2 كما هي (نصّاً) ──");
const TIER2 = {
  v21: [
    ["DAILY_LOSS_LIMIT constant", /const DAILY_LOSS_LIMIT\s*=\s*-600;/],
    ["monitorPosition force-close", /if \(getTodayRealizedPnl\(\) <= DAILY_LOSS_LIMIT\) \{\n    await closePosition\(state, symbol, pos, currentPremium, "daily_loss_breaker", "order_fill"\);\n    return;\n  \}/],
  ],
  lab: [
    ["MAX_DAILY_LOSS constant", /const MAX_DAILY_LOSS\s*=\s*1000;/],
    ["monitorPosition force-close", /if \(getTodayRealizedPnl\(\) <= -MAX_DAILY_LOSS\) \{\n    await closePosition\(state, symbol, pos, currentPremium, "daily_loss_breaker", "order_fill"\);\n    return;\n  \}/],
  ],
};
for (const bot of ["v21", "lab"]) {
  for (const [label, re] of TIER2[bot]) {
    const inNew = re.test(src[bot]), inOld = re.test(base[bot]);
    check(`${bot}: ${label} موجود في الأصل وفي الجديد بلا تغيير`, inOld && inNew, { inOld, inNew }, { inOld: true, inNew: true });
  }
  // the force-close must NOT have learned about tier 1
  const monitor = grab(src[bot], /async function monitorPosition\([\s\S]*?\n\}/, `monitorPosition/${bot}`);
  check(`${bot}: monitorPosition لا يذكر أي ثابت من الطبقة 1`,
    !/STOP_DAY_LOSS|PROFIT_ARM|PROFIT_GIVEBACK|getTodayRealizedDay/.test(monitor), "mentions tier 1", "clean");
  // alpaca() untouched
  const alp = grab(src[bot], /async function alpaca\([\s\S]*?\n\}/, `alpaca/${bot}`);
  const alpOld = grab(base[bot], /async function alpaca\([\s\S]*?\n\}/, `alpaca-old/${bot}`);
  check(`${bot}: alpaca() لم تُلمس`, alp === alpOld, "changed", "identical");
}
// WVAD must be untouched entirely
const wv = lf(fs.readFileSync("scan_wvad.js", "utf8"));
const wvOld = lf(execFileSync("git", ["show", `${BASE_REF}:scan_wvad.js`], { maxBuffer: 1 << 28 }).toString());
check("wvad: scan_wvad.js غير معدَّل إطلاقاً", wv === wvOld, "changed", "identical");

// ── 10) the scanEntry gate itself ────────────────────────
console.log("\n── 10) بوابة scanEntry ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  const entry = grab(src[bot], /const day = getTodayRealizedDay\(\);\n  if \(day\.stopped\) \{[\s\S]*?\n  \}/, `gate/${bot}`);
  check(`${bot}: البوابة تستخدم day.stopped وتُرجِع`, /day\.stopped/.test(entry) && /return;/.test(entry), entry.slice(0, 60), "day.stopped + return");
  // the gate runs before the first network call in scanEntry
  const fn = grab(src[bot], bot === "v21"
    ? /async function scanEntry\(state, symbol, portfolio, liveInAlpaca\) \{[\s\S]*?\n\}/
    : /async function scanEntry\(state, strategy, symbol, liveInAlpaca\) \{[\s\S]*?\n\}/, `scanEntry/${bot}`);
  const gateAt = fn.indexOf("getTodayRealizedDay()");
  const firstAwait = fn.search(/await (getBars|checkBreakout|getLatestPrice|alpaca|findOption)/);
  check(`${bot}: البوابة قبل أول نداء شبكي في scanEntry`,
    gateAt > -1 && firstAwait > -1 && gateAt < firstAwait, { gateAt, firstAwait }, "gate first");
  // tier 2 still checked in scanEntry too
  check(`${bot}: الطبقة 2 ما زالت مفحوصة في scanEntry`,
    bot === "v21" ? /day\.net <= DAILY_LOSS_LIMIT/.test(fn) : /day\.net <= -MAX_DAILY_LOSS/.test(fn),
    "missing", "present");
}

// ── 11) the alert block ──────────────────────────────────
console.log("\n── 11) تنبيه مرة واحدة يومياً ──");
for (const bot of ["v21", "lab"]) {
  const alert = grab(src[bot], /if \(dayNow\.stopped && state\._dayStoppedAlerted !== today\) \{[\s\S]*?\n  \}/, `alert/${bot}`);
  const saveIdx = alert.indexOf("saveState(state)");
  const tgIdx = alert.search(/await tg\(/);
  check(`${bot}: العلم يُحفظ قبل الإرسال`, saveIdx > -1 && tgIdx > -1 && saveIdx < tgIdx, { saveIdx, tgIdx }, "save first");
  check(`${bot}: العلم مُخزَّن في الحالة ببادئة _`, /state\._dayStoppedAlerted = today;/.test(alert), "missing", "present");
  check(`${bot}: الرسالة تذكر السبب والعتبات`,
    /حدّ الخسارة اليومي/.test(alert) && /حماية الربح/.test(alert) &&
    /STOP_DAY_LOSS/.test(alert) && /PROFIT_ARM/.test(alert) && /PROFIT_GIVEBACK/.test(alert),
    "incomplete", "both reasons + thresholds");
  check(`${bot}: الرسالة تنصّ أن المراكز المفتوحة لا تُغلق قسرياً`,
    /لا إغلاق قسري/.test(alert), "missing", "present");
  check(`${bot}: تنبيه الطبقة 2 منفصل وما زال قائماً`,
    /state\._lossBreakerAlerted !== today/.test(src[bot]), "missing", "present");
}
// daily_report.js enumerates state keys — the new flag must be filtered out
const dr = lf(fs.readFileSync("daily_report.js", "utf8"));
const enumLines = dr.split("\n").filter(l => /Object\.keys\(\w*State\)/.test(l));
check(`daily_report: كل أسطر تعداد مفاتيح الحالة (${enumLines.length}) تُرشِّح البادئة _`,
  enumLines.length === 3 && enumLines.every(l => l.includes('!k.startsWith("_")')), enumLines.length, 3);

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(` نجح ${pass} | فشل ${fail}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
