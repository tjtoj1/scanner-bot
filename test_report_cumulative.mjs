#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// test_report_cumulative.mjs
//
// Guards the CUMULATIVE section of the daily report: the window totals,
// the all-time totals, the fill-based win definition, the reported-only
// label for WVAD, the equity-guard status line, and that none of it can
// throw the report away.
//
// The functions are extracted FROM daily_report.js by text and executed
// with stubs — daily_report.js is a top-level script that sends Telegram
// on import, so it cannot be imported. grab() throws when a regex stops
// matching rather than letting an assertion pass vacuously.
// ════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE_SHA = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const lf = s => s.replace(/\r\n/g, "\n");
const SRC = lf(fs.readFileSync("daily_report.js", "utf8"));
const showAt = (sha, f) => lf(execFileSync("git", ["show", `${sha}:${f}`], { encoding: "utf8", maxBuffer: 1 << 28 }));

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

const RE = {
  from: /const CUMULATIVE_FROM = "[\d-]+";/,
  effPnl: /function effPnl\(r\) \{[\s\S]*?\n\}/,
  cumulative: /function cumulative\(rows, val\) \{[\s\S]*?\n\}/,
  fmt: /function fmtCumulative\(c\) \{[\s\S]*?\n\}/,
  lines: /function cumulativeLines\(allRows, \{ reported = false \} = \{\}\) \{[\s\S]*?\n\}/,
  guard: /function equityGuardLine\(stateFile\) \{[\s\S]*?\n\}/,
  readJSON: /function readJSON\(path, fallback\) \{[\s\S]*?\n\}/,
  botSection: /function buildBotSection\([\s\S]*?\n\}/,
  stats: /function stats\(rows\) \{[\s\S]*?\n\}/,
  fillLine: /function fillLine\(rows\) \{[\s\S]*?\n\}/,
  pctLine: /function pctLine\(rows, portfolioValue\) \{[\s\S]*?\n\}/,
  detect: /function detectPatterns\(rows\) \{[\s\S]*?\n\}/,
  suggest: /function suggestV21Improvement\(todayRows, allRows\) \{[\s\S]*?\n\}/,
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "repcum-"));

// Build the cumulative API over a stubbed fs rooted at a temp dir, so
// equityGuardLine's relative reads are controlled.
function makeApi(dir) {
  const fsStub = {
    readFileSync: (p, enc) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(dir, p), enc),
  };
  return new Function("fs", "console",
    `${grab(SRC, RE.from, "from")}\n`
    + `${grab(SRC, RE.readJSON, "readJSON")}\n`
    + `${grab(SRC, RE.effPnl, "effPnl")}\n`
    + `${grab(SRC, RE.cumulative, "cumulative")}\n`
    + `${grab(SRC, RE.fmt, "fmt")}\n`
    + `${grab(SRC, RE.lines, "lines")}\n`
    + `${grab(SRC, RE.guard, "guard")}\n`
    + `return { CUMULATIVE_FROM, effPnl, cumulative, fmtCumulative, cumulativeLines, equityGuardLine };`
  )(fsStub, { log() {}, error() {}, warn() {} });
}
const api = makeApi(TMP);

console.log("════════════════════════════════════════════════════════════");
console.log(" test_report_cumulative — cumulative section of the daily report");
console.log(`  base: ${BASE_SHA.slice(0, 12)}`);
console.log("════════════════════════════════════════════════════════════");

// ── 1) the window constant ────────────────────────────────────────────
console.log("\n── 1) one constant for the window ──");
check("CUMULATIVE_FROM is 2026-10-23", api.CUMULATIVE_FROM === "2026-10-23", api.CUMULATIVE_FROM, "2026-10-23");
check("it is declared exactly once", (SRC.match(/const CUMULATIVE_FROM =/g) || []).length === 1);
check("no other hard-coded 2026-10-23 anywhere in the file",
  (SRC.match(/2026-10-23/g) || []).length === 1, (SRC.match(/2026-10-23/g) || []).length, 1);
check("the window start is read from the constant, never inlined",
  /r\.day >= CUMULATIVE_FROM/.test(grab(SRC, RE.lines, "lines")), "inlined", "uses the constant");

// ── 2) effPnl: the fill-based value ───────────────────────────────────
console.log("\n── 2) effPnl ──");
check("a number is used", api.effPnl({ pnl: 100, pnlAtFill: 42 }) === 42);
check("ZERO is used, not treated as falsy", api.effPnl({ pnl: 132, pnlAtFill: 0 }) === 0,
  api.effPnl({ pnl: 132, pnlAtFill: 0 }), 0);
check("a negative is used", api.effPnl({ pnl: 10, pnlAtFill: -77 }) === -77);
check("undefined falls back to pnl", api.effPnl({ pnl: 55 }) === 55);
check("null falls back to pnl", api.effPnl({ pnl: 55, pnlAtFill: null }) === 55);
check("a numeric string falls back to pnl", api.effPnl({ pnl: 55, pnlAtFill: "42" }) === 55);

// ── 3) the fixture, with exact hand-computed numbers ──────────────────
console.log("\n── 3) fixture with exact numbers ──");
//  day         pnl   pnlAtFill   effective   in window?
//  2026-10-20  +100  (none)      +100        NO  (before the window)
//  2026-10-20  -40   (none)       -40        NO
//  2026-10-23  +60   +50          +50        yes   win
//  2026-10-23  -30   (none)       -30        yes   loss
//  2026-10-24  +20   -10          -10        yes   LOSS on fills, win on reported
//  2026-10-24  +90   (none)       +90        yes   win
//  2026-10-27  -25    0            0         yes   neither (0 is not > 0)
//
// window effective: n=5, days=3, wins = {+50, +90} = 2 → WR 40%
//   net = 50 - 30 - 10 + 90 + 0 = +100
//   gp = 50 + 90 = 140 ; gl = 30 + 10 = 40 ; PF = 3.50
// all-time effective: n=7, days=4, wins = {+100, +50, +90} = 3 → WR 43%
//   net = 100 - 40 + 50 - 30 - 10 + 90 + 0 = +160
//   gp = 100 + 50 + 90 = 240 ; gl = 40 + 30 + 10 = 80 ; PF = 3.00
const FIX = [
  { day: "2026-10-20", pnl: 100 },
  { day: "2026-10-20", pnl: -40 },
  { day: "2026-10-23", pnl: 60, pnlAtFill: 50 },
  { day: "2026-10-23", pnl: -30 },
  { day: "2026-10-24", pnl: 20, pnlAtFill: -10 },
  { day: "2026-10-24", pnl: 90 },
  { day: "2026-10-27", pnl: -25, pnlAtFill: 0 },
];
const win = FIX.filter(r => r.day >= "2026-10-23");
{
  const c = api.cumulative(win, api.effPnl);
  check("window: days = 3", c.days === 3, c.days, 3);
  check("window: trades = 5", c.n === 5, c.n, 5);
  check("window: wins = 2 (the +20/-10 trade is a LOSS on fills)", c.wins === 2, c.wins, 2);
  check("window: WR = 40%", c.wr === 40, c.wr, 40);
  check("window: net = +100", c.net === 100, c.net, 100);
  check("window: PF = 3.50 (gp 140 / gl 40)", c.pf === 3.5, c.pf, 3.5);
  // the zero-fill trade must count as neither a win nor a loss
  check("a pnlAtFill of 0 is neither a win nor a loss", c.wins === 2 && c.pf === 3.5);
}
{
  const c = api.cumulative(FIX, api.effPnl);
  check("all-time: days = 4", c.days === 4, c.days, 4);
  check("all-time: trades = 7", c.n === 7, c.n, 7);
  check("all-time: WR = 43%", c.wr === 43, c.wr, 43);
  check("all-time: net = +160", c.net === 160, c.net, 160);
  check("all-time: PF = 3.00 (gp 240 / gl 80)", c.pf === 3, c.pf, 3);
}
{
  // The SAME fixture on reported pnl gives different numbers — which is
  // the whole reason the fill-based definition is stated explicitly.
  const c = api.cumulative(win, r => r.pnl);
  check("reported-pnl window: wins = 3 (not 2)", c.wins === 3, c.wins, 3);
  check("reported-pnl window: WR = 60% (not 40%)", c.wr === 60, c.wr, 60);
  check("reported-pnl window: net = +115 (not +100)", c.net === 115, c.net, 115);
  // gp = 60+20+90 = 170 ; gl = 30+25 = 55 ; 170/55 = 3.09
  check("reported-pnl window: PF = 3.09 (gp 170 / gl 55)", c.pf === 3.09, c.pf, 3.09);
}

// ── 4) edge cases in cumulative() ─────────────────────────────────────
console.log("\n── 4) edges ──");
{
  const z = api.cumulative([], api.effPnl);
  check("empty rows: n = 0, days = 0, WR = 0, net = 0", z.n === 0 && z.days === 0 && z.wr === 0 && z.net === 0, z, "zeros");
  check("empty rows: PF is null, not 0", z.pf === null, z.pf, null);
  const allWin = api.cumulative([{ day: "d1", pnl: 10 }, { day: "d1", pnl: 5 }], api.effPnl);
  check("no losses: PF is Infinity, not a number", allWin.pf === Infinity, allWin.pf, Infinity);
  const allLoss = api.cumulative([{ day: "d1", pnl: -10 }], api.effPnl);
  check("no wins: PF = 0", allLoss.pf === 0, allLoss.pf, 0);
  const flat = api.cumulative([{ day: "d1", pnl: 0 }], api.effPnl);
  check("only flat trades: PF is null", flat.pf === null, flat.pf, null);
  check("only flat trades: WR = 0", flat.wr === 0, flat.wr, 0);
  const dup = api.cumulative([{ day: "d1", pnl: 1 }, { day: "d1", pnl: 2 }, { day: "d2", pnl: 3 }], api.effPnl);
  check("days counts DISTINCT days, not trades", dup.days === 2 && dup.n === 3, dup, { days: 2, n: 3 });
}
{
  const f = api.fmtCumulative;
  check("PF renders with 2 decimals", /PF 3\.50/.test(f({ days: 1, n: 1, wr: 0, net: 0, pf: 3.5 })));
  check("PF null renders as —", /PF —/.test(f({ days: 0, n: 0, wr: 0, net: 0, pf: null })));
  check("PF Infinity renders as ∞", /PF ∞/.test(f({ days: 1, n: 1, wr: 100, net: 1, pf: Infinity })));
  check("a positive net carries a + sign", /\+\$100/.test(f({ days: 1, n: 1, wr: 0, net: 100, pf: 1 })));
  // The sign precedes the $, so a loss reads "-$50" and never "$-50".
  const neg = f({ days: 1, n: 1, wr: 0, net: -50, pf: 1 });
  check("a negative net renders as -$50", /صافي -\$50 /.test(neg), neg, "صافي -$50");
  check("…and never as $-50", !neg.includes("$-"), neg, "no $- form");
}

// ── 5) the rendered lines ─────────────────────────────────────────────
console.log("\n── 5) the two lines ──");
{
  const out = api.cumulativeLines(FIX);
  check("the window line carries the required label",
    out.includes("📈 تراكمي منذ 2026-10-23:"), out.split("\n")[0], "📈 تراكمي منذ 2026-10-23:");
  check("the all-time line carries the required label",
    out.includes("📊 منذ البداية:"), out.split("\n")[1], "📊 منذ البداية:");
  check("the window line has the fixture's window numbers",
    /3 يوم \| 5 صفقة \| WR 40% \| صافي \+\$100 \| PF 3\.50/.test(out), out, "window numbers");
  check("the all-time line has the fixture's all-time numbers",
    /4 يوم \| 7 صفقة \| WR 43% \| صافي \+\$160 \| PF 3\.00/.test(out), out, "all-time numbers");
  check("exactly two lines", out.trim().split("\n").length === 2, out.trim().split("\n").length, 2);
  check("no (مُبلَّغ) tag when fills are in play", !out.includes("مُبلَّغ"), out, "no tag");
}
{
  const out = api.cumulativeLines(FIX, { reported: true });
  check("reported mode tags BOTH lines (مُبلَّغ)",
    (out.match(/\(مُبلَّغ\)/g) || []).length === 2, (out.match(/\(مُبلَّغ\)/g) || []).length, 2);
  check("reported mode uses pnl, so WR is 60% not 40%", /WR 60%/.test(out), out, "WR 60%");
  check("reported mode net is +115 not +100", /\+\$115/.test(out), out, "+$115");
}
{
  check("empty rows ⇒ a single غير متاح line",
    api.cumulativeLines([]) === "📈 تراكمي منذ 2026-10-23: غير متاح\n", api.cumulativeLines([]), "غير متاح");
  check("a non-array ⇒ غير متاح, not a throw", api.cumulativeLines(null).includes("غير متاح"));
  check("undefined ⇒ غير متاح", api.cumulativeLines(undefined).includes("غير متاح"));
  // rows exist but none fall in the window: the all-time line must still render
  const before = api.cumulativeLines([{ day: "2026-01-01", pnl: 5 }]);
  check("rows all before the window ⇒ the window line says so",
    before.includes("لا صفقات في هذه النافذة"), before, "لا صفقات في هذه النافذة");
  check("…and the all-time line still renders its numbers",
    /منذ البداية: 1 يوم \| 1 صفقة/.test(before), before, "all-time still shown");
}
{
  // Never throws, whatever the rows look like.
  const nasty = [null, undefined, 7, "x", {}, { day: "2026-10-24" }, { pnl: 5 }, { day: {}, pnl: NaN }];
  let threw = null;
  let out = "";
  try { out = api.cumulativeLines(nasty); } catch (e) { threw = e; }
  check("malformed rows do not throw", threw === null, threw && threw.message, "no throw");
  check("…and still produce a line", typeof out === "string" && out.length > 0, out, "a string");
}

// ── 6) the equity-guard line ──────────────────────────────────────────
console.log("\n── 6) equity guard status ──");
{
  const w = (name, obj) => fs.writeFileSync(path.join(TMP, name), typeof obj === "string" ? obj : JSON.stringify(obj));
  w("s_active.json", { NVDA: { active: true }, _equityGuard: { peak: 5000, rev: 3 } });
  check("guard present, no halt ⇒ نشط",
    api.equityGuardLine("s_active.json") === "🛡 الحارس: نشط\n", api.equityGuardLine("s_active.json"), "نشط");

  w("s_halt.json", { _equityGuard: { peak: 5000, halt: { haltedAt: "2026-11-17T15:04:22.000Z", pctFromPeak: -16.6 } } });
  check("guard halted ⇒ موقوف منذ <haltedAt>",
    api.equityGuardLine("s_halt.json") === "🛡 الحارس: موقوف منذ 2026-11-17T15:04:22.000Z\n",
    api.equityGuardLine("s_halt.json"), "موقوف منذ 2026-11-17T15:04:22.000Z");

  w("s_noguard.json", { NVDA: { active: false } });
  check("no _equityGuard key ⇒ غير متاح",
    api.equityGuardLine("s_noguard.json") === "🛡 الحارس: غير متاح\n", api.equityGuardLine("s_noguard.json"), "غير متاح");

  check("missing file ⇒ غير متاح", api.equityGuardLine("does_not_exist.json").includes("غير متاح"));
  w("s_bad.json", "{ not json");
  check("unparseable file ⇒ غير متاح", api.equityGuardLine("s_bad.json").includes("غير متاح"));
  w("s_wrongtype.json", { _equityGuard: "halted" });
  check("_equityGuard of the wrong type ⇒ غير متاح", api.equityGuardLine("s_wrongtype.json").includes("غير متاح"));
  w("s_halt_noat.json", { _equityGuard: { halt: {} } });
  check("a halt with no haltedAt ⇒ نشط, not a broken line",
    api.equityGuardLine("s_halt_noat.json") === "🛡 الحارس: نشط\n", api.equityGuardLine("s_halt_noat.json"), "نشط");
  w("s_null.json", { _equityGuard: null });
  check("_equityGuard null ⇒ غير متاح", api.equityGuardLine("s_null.json").includes("غير متاح"));
  let threw = null;
  try { api.equityGuardLine(null); } catch (e) { threw = e; }
  check("a null path does not throw", threw === null, threw && threw.message, "no throw");
  // READ-ONLY: nothing may be written
  const beforeFiles = fs.readdirSync(TMP).sort().join(",");
  api.equityGuardLine("s_active.json"); api.equityGuardLine("nope.json");
  check("reading the guard writes nothing", fs.readdirSync(TMP).sort().join(",") === beforeFiles);
}

// ── 7) the existing report is untouched ───────────────────────────────
console.log(`\n── 7) existing lines unchanged vs ${BASE_SHA.slice(0, 8)} ──`);
{
  const base = showAt(BASE_SHA, "daily_report.js");
  for (const [label, re] of [
    ["stats()", RE.stats], ["fillLine()", RE.fillLine], ["pctLine()", RE.pctLine],
  ]) {
    check(`${label} byte-identical`, grab(SRC, re, label) === grab(base, re, `${label}@base`), "changed", "identical");
  }
  // The daily block's own lines, verbatim.
  for (const frag of [
    "📋 ${s.n} صفقة | WR ${s.wr}% | صافي ${s.net>=0?\"+\":\"\"}$${s.net}\\n",
    "🥇 أفضل: ${best.symbol} ${best.signal} ${best.pnlPct.toFixed(1)}%",
    "🥉 أسوأ: ${worst.symbol} ${worst.signal} ${worst.pnlPct.toFixed(1)}%",
    "📌 مفتوحة الآن: ${activeSymbols.join(\", \")}",
    "حسب الرمز: ", "حسب الاتجاه: ", "حسب سبب الخروج: ",
  ]) {
    check(`daily line kept: ${frag.slice(0, 26)}…`, SRC.includes(frag) && base.includes(frag), "missing", "present");
  }
  check("the cumulative block is appended AFTER the open-positions line",
    SRC.indexOf("📌 مفتوحة الآن") < SRC.indexOf("cumulativeLines(cum.allRows"), "before", "after");
  check("buildBotSection still takes portfolioValue positionally",
    /function buildBotSection\(title, todayRows, activeSymbols, portfolioValue = 0, cum = null\)/.test(SRC),
    "signature changed incompatibly", "portfolioValue kept in place");
  check("no state or outcomes file is written anywhere",
    !/writeFileSync\((?!"report_state\.json")/.test(SRC), "writes something else", "report_state.json only");
  check("report_state.json is still the only write",
    (SRC.match(/writeFileSync\(/g) || []).length === 1, (SRC.match(/writeFileSync\(/g) || []).length, 1);
}

// ── 8) the two misleading texts are gone ──────────────────────────────
console.log("\n── 8) removed texts ──");
{
  const codeOnly = SRC.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  check("the Railway-scheduling suggestion no longer prints",
    !codeOnly.includes("جدولة Railway"), "still printed", "gone");
  check("the monitoring-lag note no longer prints",
    !codeOnly.includes("احتمال تأخر مراقبة"), "still printed", "gone");
  check("both WERE in the base (so this test is not vacuous)",
    showAt(BASE_SHA, "daily_report.js").includes("جدولة Railway")
    && showAt(BASE_SHA, "daily_report.js").includes("احتمال تأخر مراقبة"), "not in base", "in base");
  check("the alpaca_stop RATIO is kept (only the false lead was dropped)",
    /أُغلقت عبر alpaca_stop/.test(codeOnly), "ratio dropped too", "ratio kept");
  check("the removal is explained in a comment, not silent",
    /REMOVED:/.test(SRC) && (SRC.match(/REMOVED:/g) || []).length === 2,
    (SRC.match(/REMOVED:/g) || []).length, 2);
  // detectPatterns must still work and no longer produce the lag note
  const dp = new Function("groupBy", `${grab(SRC, RE.detect, "detect")}\nreturn detectPatterns;`)(
    (rows, key) => { const g = {}; for (const r of rows) (g[r[key]] ||= []).push(r); return g; });
  const lateRows = [
    { symbol: "SPY", signal: "CALL", reason: "alpaca_stop", win: true, pnl: 1, pnlPct: 1,
      entryTime: "2026-11-17T14:00:00Z", exitTime: "2026-11-17T17:00:00Z" },
    { symbol: "QQQ", signal: "PUT", reason: "ladder_stop", win: true, pnl: 1, pnlPct: 1,
      entryTime: "2026-11-17T14:05:00Z", exitTime: "2026-11-17T18:00:00Z" },
  ];
  const notes = dp(lateRows);
  check("detectPatterns still runs and returns an array", Array.isArray(notes), notes, "an array");
  check("…and emits no monitoring-lag note for a 3-hour alpaca_stop",
    !notes.some(x => /تأخر مراقبة/.test(x)), notes, "no lag note");
}

// ── 9) scope: only daily_report.js and this test changed ──────────────
console.log("\n── 9) scope ──");
{
  const changed = execFileSync("git", ["diff", "--name-only", BASE_SHA], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  const allowed = new Set(["daily_report.js", "test_report_cumulative.mjs"]);
  // The invariant is that no PRODUCTION file but daily_report.js moved.
  // Test files are exempt: three sibling suites pinned daily_report.js
  // byte-identical and had to be narrowed on this same branch, which is a
  // test-only change. The per-file byte-identity list below is the strong
  // form of this check for every production file that matters.
  const isTest = f => /^test_.*\.mjs$/.test(f);
  const strayTracked = changed.filter(f => !allowed.has(f) && !isTest(f));
  check("no production file outside daily_report.js changed", strayTracked.length === 0, strayTracked, []);
  const strayTests = changed.filter(f => isTest(f) && !allowed.has(f));
  check(`only the narrowed scope pins changed among tests (${strayTests.length})`,
    strayTests.every(f => ["test_equity_guard.mjs", "test_combo_policy.mjs", "test_effective_pnl.mjs"].includes(f)),
    strayTests, "the three narrowed suites only");
  for (const f of ["scan_v21.js", "scan_lab.js", "scan_wvad.js", "runner.js",
                   "state_v21.json", "state_lab.json", "state_wvad.json",
                   "outcomes_v21.jsonl", "outcomes_lab.jsonl", "outcomes_wvad.jsonl",
                   "strategy_lab.json", "report_state.json"]) {
    check(`${f} byte-identical to base`,
      lf(fs.readFileSync(f, "utf8")) === showAt(BASE_SHA, f), "changed", "identical");
  }
  check("this test file is the only new tracked-or-untracked addition in scope",
    untracked.every(f => allowed.has(f) || ["daily_stop.patch", "diff_lab.txt", "diff_v21.txt",
      "goals_baseline.txt", "test_daily_stop.txt"].includes(f)),
    untracked, "only the known artefacts");
}

// ── 10) the real files reproduce the owner's hand-check ───────────────
console.log("\n── 10) real outcomes reproduce the stated figures ──");
{
  const readJSONL = f => { try {
    return fs.readFileSync(f, "utf8").split("\n").filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; } };
  const EXPECT = {
    "outcomes_v21.jsonl":  { days: 15, n: 55,  wr: 58, net: -1034, pf: 0.68, reported: false, label: "v21" },
    "outcomes_lab.jsonl":  { days: 18, n: 207, wr: 60, net: 3960,  pf: 1.58, reported: false, label: "LAB" },
    "outcomes_wvad.jsonl": { days: 18, n: 69,  wr: 52, net: -55,   pf: 0.98, reported: true,  label: "WVAD" },
  };
  for (const [f, e] of Object.entries(EXPECT)) {
    const rows = readJSONL(f).filter(r => r.day >= api.CUMULATIVE_FROM);
    const c = api.cumulative(rows, e.reported ? (r => r.pnl) : api.effPnl);
    check(`${e.label}: days = ${e.days}`, c.days === e.days, c.days, e.days);
    check(`${e.label}: trades = ${e.n}`, c.n === e.n, c.n, e.n);
    check(`${e.label}: WR = ${e.wr}%`, c.wr === e.wr, c.wr, e.wr);
    check(`${e.label}: net = ${e.net}`, c.net === e.net, c.net, e.net);
    check(`${e.label}: PF = ${e.pf}`, c.pf === e.pf, c.pf, e.pf);
  }
  // WVAD really has no fills, which is why its line is labelled (مُبلَّغ)
  const wv = readJSONL("outcomes_wvad.jsonl");
  check("WVAD carries no pnlAtFill on any row (so the مُبلَّغ label is accurate)",
    wv.length > 0 && wv.every(r => typeof r.pnlAtFill !== "number"),
    wv.filter(r => typeof r.pnlAtFill === "number").length, 0);
  // v21/LAB do carry fills, so their unlabelled lines are fill-based
  for (const [f, label] of [["outcomes_v21.jsonl", "v21"], ["outcomes_lab.jsonl", "LAB"]]) {
    const n = readJSONL(f).filter(r => typeof r.pnlAtFill === "number").length;
    check(`${label} has fill-covered rows (${n}), so its line is fill-based`, n > 0, n, "> 0");
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n════════════════════════════════════════════════════════════");
console.log(` passed ${pass} | failed ${fail}`);
console.log("════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
