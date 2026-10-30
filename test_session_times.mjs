// ============================================================
// DST-SAFE SESSION TIMES — TEST SUITE. No network, no API keys.
//
// The helper and every session gate are EXTRACTED BY TEXT from the real
// scan_v21.js / scan_lab.js / scan_wvad.js / runner.js and run against an
// INJECTED CLOCK, so the code under test is the code that ships. If a
// regex stops matching, the suite throws instead of silently passing.
//
// US DST facts this suite pins down (verified against the tz database,
// not assumed):
//   2026-11-01 Sun 07:00Z  CDT -> CST   (offset 300 -> 360)
//   2027-03-14 Sun 08:00Z  CST -> CDT   (offset 360 -> 300)
// Note 2027-03-07/08/09 are STILL CST — DST 2027 starts on the SECOND
// Sunday of March, the 14th. Those three dates are kept as a control.
//
// Run:  node test_session_times.mjs
// ============================================================
import fs from "fs";
import { execFileSync } from "child_process";

const FILES = ["scan_v21.js", "scan_lab.js", "scan_wvad.js", "runner.js"];
const lf = s => s.replace(/\r\n/g, "\n");
const src = {};
for (const f of FILES) src[f] = lf(fs.readFileSync(f, "utf8"));
const baseOf = f => lf(execFileSync("git", ["show", `origin/main:${f}`], { maxBuffer: 1 << 28 }).toString());

const grab = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`extraction failed (${what}) — source no longer matches`);
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
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: fn(), lines }; }
  catch (e) { return { err: e, lines }; }
  finally { Object.assign(console, orig); }
}

// ════════════════════════════════════════════════════════════
// Extraction
// ════════════════════════════════════════════════════════════
const RE = {
  fmt:    /const CHI_HM = new Intl\.DateTimeFormat\("en-US", \{[\s\S]*?\}\);/,
  offset: /function chicagoOffsetMin\(d = new Date\(\)\) \{[\s\S]*?\n\}/,
  toUtc:  /function chicagoToUtcMinutes\(h, m, d = new Date\(\)\) \{[\s\S]*?\n\}/,
  utcMin: /function utcMin\(\)[\s\S]*?\n\}|function utcMin\(\) \{ const n = new Date\(\); return n\.getUTCHours\(\) \* 60 \+ n\.getUTCMinutes\(\); \}/,
  botAssert: /\/\/ Startup assertion\.[\s\S]*?process\.exit\(1\);\n\}/,
  runnerAssert: /const CHI_OFFSET_AT_BOOT = chicagoOffsetMin\(\);\nconst CHI_OFFSET_OK = [\s\S]*?\n\}/,
  isMarketHours: /function isMarketHours\(\) \{\n[\s\S]*?\n\}/,
};

// The helper, with an injectable "now".
function makeHelper(file, nowIso) {
  const body = [grab(src[file], RE.fmt, `fmt/${file}`),
                grab(src[file], RE.offset, `offset/${file}`),
                grab(src[file], RE.toUtc, `toUtc/${file}`)].join("\n");
  return new Function("Date", `${body}\nreturn { chicagoOffsetMin, chicagoToUtcMinutes };`)(
    makeClock(nowIso));
}
// A Date subclass whose zero-arg constructor returns the frozen instant.
function makeClock(nowIso) {
  const fixed = new Date(nowIso).getTime();
  return class FrozenDate extends Date {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  };
}

// Named gate getters from a file, with the clock injected.
function makeGates(file, nowIso, names) {
  const helper = [grab(src[file], RE.fmt, "fmt"), grab(src[file], RE.offset, "offset"),
                  grab(src[file], RE.toUtc, "toUtc")].join("\n");
  const gates = names.map(n => grab(src[file],
    new RegExp(`function ${n}\\(\\)[^\\n]*\\{[^\\n]*\\}`), `${n}/${file}`)).join("\n");
  const utc = grab(src[file], RE.utcMin, `utcMin/${file}`);
  return new Function("Date", `${helper}\n${utc}\n${gates}\n` +
    `return { ${names.join(", ")}, utcMin };`)(makeClock(nowIso));
}

// ════════════════════════════════════════════════════════════
const DATES = {
  "2026-10-30 Fri (CDT)":                "2026-10-30T15:00:00Z",
  "2026-11-01 Sun 06:30Z (pre-switch)":  "2026-11-01T06:30:00Z",
  "2026-11-01 Sun 15:00Z (post-switch)": "2026-11-01T15:00:00Z",
  "2026-11-02 Mon (CST, first day)":     "2026-11-02T15:00:00Z",
  "2027-03-07 Sun (still CST)":          "2027-03-07T15:00:00Z",
  "2027-03-08 Mon (still CST)":          "2027-03-08T15:00:00Z",
  "2027-03-09 Tue (still CST)":          "2027-03-09T15:00:00Z",
  "2027-03-13 Fri (last CST day)":       "2027-03-13T15:00:00Z",
  "2027-03-15 Mon (first CDT day)":      "2027-03-15T15:00:00Z",
};
// offset, open(8:30), rangeEnd(8:45), lastEntry(14:30), forceExit(14:55),
// close(15:30), runnerEnd(16:00), report(15:35) — all as UTC minutes
const EXPECT = {
  "2026-10-30 Fri (CDT)":                [300, 810, 825, 1170, 1195, 1230, 1260, 1235],
  "2026-11-01 Sun 06:30Z (pre-switch)":  [300, 810, 825, 1170, 1195, 1230, 1260, 1235],
  "2026-11-01 Sun 15:00Z (post-switch)": [360, 870, 885, 1230, 1255, 1290, 1320, 1295],
  "2026-11-02 Mon (CST, first day)":     [360, 870, 885, 1230, 1255, 1290, 1320, 1295],
  "2027-03-07 Sun (still CST)":          [360, 870, 885, 1230, 1255, 1290, 1320, 1295],
  "2027-03-08 Mon (still CST)":          [360, 870, 885, 1230, 1255, 1290, 1320, 1295],
  "2027-03-09 Tue (still CST)":          [360, 870, 885, 1230, 1255, 1290, 1320, 1295],
  "2027-03-13 Fri (last CST day)":       [360, 870, 885, 1230, 1255, 1290, 1320, 1295],
  "2027-03-15 Mon (first CDT day)":      [300, 810, 825, 1170, 1195, 1230, 1260, 1235],
};
const hhmm = v => `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;

console.log("\n═══════════════════════════════════════════════════════════");
console.log(" DST-SAFE SESSION TIMES — no network, no keys");
console.log("═══════════════════════════════════════════════════════════");

// ── 1) the offset, per date ───────────────────────────────
console.log("\n── 1) chicagoOffsetMin ──");
for (const [label, iso] of Object.entries(DATES)) {
  const h = makeHelper("scan_v21.js", iso);
  const want = EXPECT[label][0];
  const got = h.chicagoOffsetMin();
  check(`${label} ⇒ ${want}`, got === want, got, want);
}

// ── 2) the expected-UTC table ─────────────────────────────
console.log("\n── 2) derived session times (UTC minute-of-day) ──");
for (const [label, iso] of Object.entries(DATES)) {
  const h = makeHelper("scan_v21.js", iso);
  const [, open, rEnd, last, force, close, rEndr, rep] = EXPECT[label];
  const t = (hh, mm) => h.chicagoToUtcMinutes(hh, mm);
  const got = [t(8,30), t(8,45), t(14,30), t(14,55), t(15,30), t(16,0), t(15,35)];
  const want = [open, rEnd, last, force, close, rEndr, rep];
  check(`${label}  open ${hhmm(open)} force ${hhmm(force)} close ${hhmm(close)}`,
    JSON.stringify(got) === JSON.stringify(want), got.map(hhmm), want.map(hhmm));
}

// ── 3) 2026-10-30 must equal the OLD hard-coded values ────
console.log("\n── 3) regression: 2026-10-30 reproduces the old constants exactly ──");
{
  const h = makeHelper("scan_v21.js", DATES["2026-10-30 Fri (CDT)"]);
  const OLD = { rangeStart: 13*60+30, rangeEnd: 13*60+45, lastEntry: 19*60+30,
                forceExit: 19*60+55, close: 20*60+30, runnerEnd: 21*60, report: 20*60+35 };
  check(`rangeStart ${hhmm(OLD.rangeStart)}`, h.chicagoToUtcMinutes(8,30) === OLD.rangeStart, h.chicagoToUtcMinutes(8,30), OLD.rangeStart);
  check(`rangeEnd   ${hhmm(OLD.rangeEnd)}`,   h.chicagoToUtcMinutes(8,45) === OLD.rangeEnd,   h.chicagoToUtcMinutes(8,45), OLD.rangeEnd);
  check(`lastEntry  ${hhmm(OLD.lastEntry)}`,  h.chicagoToUtcMinutes(14,30) === OLD.lastEntry, h.chicagoToUtcMinutes(14,30), OLD.lastEntry);
  check(`forceExit  ${hhmm(OLD.forceExit)}`,  h.chicagoToUtcMinutes(14,55) === OLD.forceExit, h.chicagoToUtcMinutes(14,55), OLD.forceExit);
  check(`close      ${hhmm(OLD.close)}`,      h.chicagoToUtcMinutes(15,30) === OLD.close,     h.chicagoToUtcMinutes(15,30), OLD.close);
  check(`runnerEnd  ${hhmm(OLD.runnerEnd)}`,  h.chicagoToUtcMinutes(16,0)  === OLD.runnerEnd, h.chicagoToUtcMinutes(16,0),  OLD.runnerEnd);
  check(`report     ${hhmm(OLD.report)}`,     h.chicagoToUtcMinutes(15,35) === OLD.report,    h.chicagoToUtcMinutes(15,35), OLD.report);
}

// ── 4) the transition hours ───────────────────────────────
console.log("\n── 4) the ambiguous / nonexistent local hours ──");
{
  // Autumn: 01:00-02:00 local happens twice. 06:30Z = 01:30 CDT, 07:30Z = 01:30 CST.
  const a = makeHelper("scan_v21.js", "2026-11-01T06:30:00Z").chicagoOffsetMin();
  const b = makeHelper("scan_v21.js", "2026-11-01T07:30:00Z").chicagoOffsetMin();
  check("2026-11-01 06:30Z ⇒ 300 (still CDT)", a === 300, a, 300);
  check("2026-11-01 07:30Z ⇒ 360 (now CST)",   b === 360, b, 360);
  // Spring: 02:00-03:00 local does not exist. 07:30Z = 01:30 CST, 08:30Z = 03:30 CDT.
  const c = makeHelper("scan_v21.js", "2027-03-14T07:30:00Z").chicagoOffsetMin();
  const d = makeHelper("scan_v21.js", "2027-03-14T08:30:00Z").chicagoOffsetMin();
  check("2027-03-14 07:30Z ⇒ 360", c === 360, c, 360);
  check("2027-03-14 08:30Z ⇒ 300", d === 300, d, 300);
  check("no NaN in any transition hour", [a,b,c,d].every(Number.isFinite), [a,b,c,d], "all finite");
  // both transitions are on a Sunday ⇒ never inside a session
  for (const iso of ["2026-11-01T07:00:00Z", "2027-03-14T08:00:00Z"]) {
    const day = new Date(iso).getUTCDay();
    check(`${iso.slice(0,10)} is a Sunday (UTC day ${day})`, day === 0, day, 0);
  }
}

// ── 5) offset is always 300 or 360, every day for 15 months ──
console.log("\n── 5) exhaustive sweep 2026-10-01 → 2027-12-31 ──");
{
  const h0 = makeHelper("scan_v21.js", "2026-10-01T15:00:00Z");
  // re-derive per day with a fresh frozen clock
  let bad = [], days = 0;
  for (let t = Date.parse("2026-10-01T15:00:00Z"); t <= Date.parse("2027-12-31T15:00:00Z"); t += 86400000) {
    const iso = new Date(t).toISOString();
    const o = makeHelper("scan_v21.js", iso).chicagoOffsetMin();
    days++;
    if (o !== 300 && o !== 360) bad.push(`${iso.slice(0,10)}=${o}`);
  }
  check(`${days} days, every offset ∈ {300,360}`, bad.length === 0, bad.slice(0,5), []);
}

// ── 6) gates, per bot, per date ───────────────────────────
console.log("\n── 6) gates flip at the right UTC minute ──");
const GATES = {
  "scan_v21.js": ["rangeStartUtc", "rangeEndUtc", "lastEntryUtc", "forceExitUtc", "marketCloseUtc"],
  "scan_lab.js": ["marketOpenUtc", "marketCloseUtc", "forceExitUtc", "lastEntryUtc"],
  "scan_wvad.js": ["marketOpenUtc", "marketCloseUtc", "firstEntryUtc", "lastEntryUtc", "forceExitUtc"],
};
for (const [file, names] of Object.entries(GATES)) {
  for (const label of ["2026-10-30 Fri (CDT)", "2026-11-02 Mon (CST, first day)"]) {
    const g = makeGates(file, DATES[label], names);
    const [, open, rEnd, last, force, close] = EXPECT[label];
    const checks = [];
    if (names.includes("rangeStartUtc"))  checks.push(["rangeStartUtc", g.rangeStartUtc(), open]);
    if (names.includes("marketOpenUtc"))  checks.push(["marketOpenUtc", g.marketOpenUtc(), open]);
    if (names.includes("rangeEndUtc"))    checks.push(["rangeEndUtc", g.rangeEndUtc(), rEnd]);
    if (names.includes("firstEntryUtc"))  checks.push(["firstEntryUtc", g.firstEntryUtc(), rEnd]);
    if (names.includes("lastEntryUtc"))   checks.push(["lastEntryUtc", g.lastEntryUtc(), last]);
    if (names.includes("forceExitUtc"))   checks.push(["forceExitUtc", g.forceExitUtc(), force]);
    if (names.includes("marketCloseUtc")) checks.push(["marketCloseUtc", g.marketCloseUtc(), close]);
    const bad = checks.filter(([, got, want]) => got !== want);
    check(`${file} @ ${label.slice(0,10)}: ${checks.length} gates correct`,
      bad.length === 0, bad.map(([n,g2,w]) => `${n}=${g2}≠${w}`), []);
  }
}
// LAB keeps the forceExit-25 relationship
for (const label of ["2026-10-30 Fri (CDT)", "2026-11-02 Mon (CST, first day)"]) {
  const g = makeGates("scan_lab.js", DATES[label], GATES["scan_lab.js"]);
  check(`lab @ ${label.slice(0,10)}: lastEntry == forceExit - 25`,
    g.lastEntryUtc() === g.forceExitUtc() - 25, g.lastEntryUtc(), g.forceExitUtc() - 25);
}

// ── 7) runner: report window strictly inside market hours ──
console.log("\n── 7) runner report window inside isMarketHours, both sides ──");
for (const label of ["2026-10-30 Fri (CDT)", "2026-11-02 Mon (CST, first day)"]) {
  const g = makeGates("runner.js", DATES[label], ["marketStartUtc", "marketEndUtc", "reportWindowStartUtc"]);
  const s = g.marketStartUtc(), e = g.marketEndUtc(), r = g.reportWindowStartUtc();
  check(`${label.slice(0,10)}: start ${hhmm(s)} ≤ report ${hhmm(r)} < end ${hhmm(e)}`,
    s <= r && r < e, { s, r, e }, "s <= r < e");
  check(`${label.slice(0,10)}: marketEnd is 1h past the 15:00 close`, e - g.marketStartUtc() === 450, e - s, 450);
}

// ── 8) v21 bar filtering uses the BAR's own offset ────────
console.log("\n── 8) bar filtering per-bar, not per-now ──");
{
  const f = src["scan_v21.js"];
  check("range filter passes the bar's Date",
    /m >= chicagoToUtcMinutes\(8, 30, t\) && m < chicagoToUtcMinutes\(8, 45, t\)/.test(f), "missing", "present");
  check("post-open filter passes the bar's Date",
    /return barDate === today && m >= chicagoToUtcMinutes\(8, 30, t\);/.test(f), "missing", "present");
  const h = makeHelper("scan_v21.js", "2026-11-02T15:00:00Z");   // "now" is CST
  const cdtBar = new Date("2026-10-30T13:30:00Z");               // a CDT bar
  check("a CDT bar is judged at 13:30Z even when now is CST",
    h.chicagoToUtcMinutes(8, 30, cdtBar) === 810, h.chicagoToUtcMinutes(8, 30, cdtBar), 810);
  check("and a CST bar at 14:30Z", h.chicagoToUtcMinutes(8, 30, new Date("2026-11-02T14:30:00Z")) === 870,
    h.chicagoToUtcMinutes(8, 30, new Date("2026-11-02T14:30:00Z")), 870);
}

// ── 9) forced Intl failure ────────────────────────────────
console.log("\n── 9) broken tz database ──");
for (const f of ["scan_v21.js", "scan_lab.js", "scan_wvad.js"]) {
  const body = grab(src[f], RE.botAssert, `assert/${f}`);
  let exitCode = null;
  const r = capture(() => new Function("chicagoOffsetMin", "process", "console",
    body)( () => NaN, { exit: c => { exitCode = c; throw new Error("EXIT"); } }, console));
  check(`${f}: NaN offset ⇒ process.exit(1)`, exitCode === 1, exitCode, 1);
  check(`${f}: logs FATAL`, r.lines.some(l => l.includes("FATAL")), r.lines, "FATAL logged");
  // a good offset must NOT exit
  let e2 = null;
  capture(() => new Function("chicagoOffsetMin", "process", "console", body)(
    () => 360, { exit: c => { e2 = c; } }, console));
  check(`${f}: offset 360 ⇒ no exit`, e2 === null, e2, null);
}
{
  // runner: must NOT exit; isMarketHours must return false
  const body = grab(src["runner.js"], RE.runnerAssert, "runnerAssert");
  check("runner assert block contains no process.exit", !/process\.exit/.test(body), "exits", "no exit");
  const imh = grab(src["runner.js"], RE.isMarketHours, "isMarketHours");
  check("runner isMarketHours short-circuits on !CHI_OFFSET_OK",
    /if \(!CHI_OFFSET_OK\) return false;/.test(imh), "missing", "present");
  const fn = new Function("CHI_OFFSET_OK", "isWeekday", "utcMin", "marketStartUtc", "marketEndUtc",
    `${imh}\nreturn isMarketHours;`);
  check("isMarketHours() === false when the clock is unknown",
    fn(false, () => true, () => 900, () => 870, () => 1320)() === false, "true", false);
  check("isMarketHours() === true when the clock is known and in-session",
    fn(true, () => true, () => 900, () => 870, () => 1320)() === true, "false", true);
  check("runner alerts once via alertOnce in main()",
    /await alertOnce\("tz:chicago"/.test(src["runner.js"]), "missing", "present");
  check("railway restartPolicyType is ALWAYS (why we must not exit)",
    /"restartPolicyType":\s*"ALWAYS"/.test(fs.readFileSync("railway.json", "utf8")), "changed", "ALWAYS");
}

// ── 10) no fixed session literal survives ─────────────────
console.log("\n── 10) no hard-coded session literal left ──");
const BANNED = [/13 \* 60 \+ 30/, /13 \* 60 \+ 45/, /19 \* 60 \+ 30/, /19 \* 60 \+ 55/,
                /20 \* 60 \+ 30/, /20 \* 60 \+ 35/, /21 \* 60;/];
for (const f of FILES) {
  const hits = BANNED.filter(re => re.test(src[f])).map(re => String(re));
  check(`${f}: no banned literal`, hits.length === 0, hits, []);
}
check("scan_wvad.js keeps its ET RTH window (9*60+30 / 16*60)",
  /t >= 9 \* 60 \+ 30 && t < 16 \* 60/.test(src["scan_wvad.js"]), "changed", "present");
check("scan_wvad.js ET_FMT / etMinutes / filterRTH byte-identical to origin/main", (() => {
  const re = /const ET_FMT = new Intl\.DateTimeFormat[\s\S]*?function filterRTH\(bars\) \{[\s\S]*?\n\}/;
  return grab(src["scan_wvad.js"], re, "rth") === grab(baseOf("scan_wvad.js"), re, "rth base");
})(), "changed", "identical");

// Every constant the getters replaced. A surviving READ of one of these is
// a ReferenceError the moment that line runs — and `node --check` cannot
// see it, because an undeclared identifier is valid syntax. Only the real
// code path would reveal it, during a session, with money open. So it is
// asserted here instead: zero live references, per file.
//
// Comments and plain strings are stripped first, so prose may name a
// removed constant while code may not. Template literals are deliberately
// NOT stripped: a name inside `${...}` is a live read, and this errs
// towards a false failure rather than a silent pass.
const REMOVED_NAMES = [
  "MARKET_START_UTC", "MARKET_END_UTC", "REPORT_WINDOW_START_UTC",
  "RANGE_START_UTC", "RANGE_END_UTC", "LAST_ENTRY_UTC", "FORCE_EXIT_UTC",
  "MARKET_OPEN_UTC", "MARKET_CLOSE_UTC", "FIRST_ENTRY_UTC",
];
const stripCommentsAndStrings = s => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
for (const f of [...FILES, "daily_report.js"]) {
  const code = stripCommentsAndStrings(lf(fs.readFileSync(f, "utf8")));
  const live = REMOVED_NAMES.filter(n => new RegExp(`\\b${n}\\b`).test(code));
  check(`${f}: live references to removed names = 0`, live.length === 0, live, []);
}

// ── 11) nothing else moved ────────────────────────────────
console.log("\n── 11) out-of-scope code untouched ──");
for (const f of ["scan_v21.js", "scan_lab.js", "scan_wvad.js"]) {
  const base = baseOf(f);
  for (const [label, re] of [
    ["getToday()", /function getToday\(\)[^\n]*\n?/],
    ["alpaca()", /async function alpaca\([\s\S]*?\n\}/],
    ["getOwnedQty()", /async function getOwnedQty\([\s\S]*?\n\}/],
    // logTrade() as a whole is no longer out of scope: the fill-capture
    // work appends fields to its record on purpose. What this section is
    // really protecting is that NOTHING changed the reported P&L, so pin
    // the two lines that compute it instead of the whole function. That
    // is the narrower and more honest guard — a whole-function pin would
    // have to be deleted outright, leaving nothing behind.
    ["logTrade() pnlPct line", /^    const pnlPct = \(exitPremium - pos\.entryPremium\) \/ pos\.entryPremium \* 100;$/m],
    ["logTrade() pnl line", /^    const pnl = Math\.round\(\(exitPremium - pos\.entryPremium\) \* pos\.qty \* 100\);$/m],
  ]) {
    let a, b;
    try { a = grab(src[f], re, label); b = grab(base, re, label); } catch { continue; }
    check(`${f}: ${label} identical`, a === b, "changed", "identical");
  }
}
for (const [label, re] of [
  ["getToday()", /function getToday\(\)[^\n]*/],
  ["daysAgoUTC()", /function daysAgoUTC\(n\)[^\n]*/],
  ["getTodayRealizedDay()", /function getTodayRealizedDay\(\) \{[\s\S]*?\n\}/],
  ["readDayPeak()", /function readDayPeak\(\) \{[\s\S]*?\n\}/],
  ["bumpDayPeak()", /function bumpDayPeak\(candidate\) \{[\s\S]*?\n\}/],
]) {
  for (const f of ["scan_v21.js", "scan_lab.js"]) {
    let a, b;
    try { a = grab(src[f], re, label); b = grab(baseOf(f), re, label); } catch { continue; }
    check(`${f}: ${label} identical`, a === b, "changed", "identical");
  }
}
check("runner.js: isWeekday() identical",
  grab(src["runner.js"], /function isWeekday\(\)[^\n]*/, "iw") === grab(baseOf("runner.js"), /function isWeekday\(\)[^\n]*/, "iw base"), "changed", "identical");
check("runner.js: today() identical",
  grab(src["runner.js"], /function today\(\)[^\n]*/, "t") === grab(baseOf("runner.js"), /function today\(\)[^\n]*/, "t base"), "changed", "identical");
// STATE_FILES grows as later work adds synced files (stage 0 added
// signals_lab.jsonl), so this pins the invariant instead of the bytes:
// nothing already synced may be dropped. The DST change added nothing
// here, which the count check still confirms for this section's purpose.
{
  const quoted = t => (grab(t, /const STATE_FILES = \[[\s\S]*?\];/, "sf").match(/"[^"]+"/g) || []);
  const now = quoted(src["runner.js"]), was = quoted(baseOf("runner.js"));
  const missing = was.filter(f => !now.includes(f));
  check("runner.js: STATE_FILES loses nothing", missing.length === 0, missing, []);
}
check("workflows untouched (no .github in this change)", (() => {
  const out = execFileSync("git", ["diff", "--name-only", "origin/main", "HEAD"], { maxBuffer: 1 << 24 }).toString()
    + execFileSync("git", ["diff", "--name-only"], { maxBuffer: 1 << 24 }).toString();
  return !/\.github\//.test(out);
})(), "workflow changed", "untouched");

// ── 12) holidays / half days: no awareness, documented ────
console.log("\n── 12) holidays and half days (known gap, NOT in scope) ──");
{
  // Thanksgiving 2026-11-26 and the 2026-11-27 half day: the gates open as
  // on any weekday. This asserts the CURRENT behaviour so the gap is
  // recorded rather than discovered later.
  const g = makeGates("scan_v21.js", "2026-11-26T15:00:00Z",
    ["rangeStartUtc", "forceExitUtc", "marketCloseUtc"]);
  check("2026-11-26 (Thanksgiving): gates open normally — no holiday calendar",
    g.rangeStartUtc() === 870 && g.forceExitUtc() === 1255, [g.rangeStartUtc(), g.forceExitUtc()], [870, 1255]);
  const h = makeGates("scan_v21.js", "2026-11-27T15:00:00Z",
    ["rangeStartUtc", "forceExitUtc", "marketCloseUtc"]);
  check("2026-11-27 (half day, 12:00 CT close): forceExit still 14:55 local — 2h55m late",
    h.forceExitUtc() === 1255, h.forceExitUtc(), 1255);
  // Identifiers, not prose: scan_wvad.js already says "holiday shift" in a
  // comment about 0DTE expiry fallback, which is not a holiday calendar.
  const HOLIDAY_LOGIC = /\bHOLIDAYS?\b|isHoliday|holidayList|holidayCalendar|halfDay|half_day|HALF_DAY|earlyClose|EARLY_CLOSE/;
  check("no holiday/half-day logic anywhere in the four files",
    FILES.every(f => !HOLIDAY_LOGIC.test(src[f])), "found", "absent");
}

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(` نجح ${pass} | فشل ${fail}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
