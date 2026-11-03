#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// test_effective_pnl.mjs
//
// Guards the day-level-only switch to fill-accurate P&L: the day replay
// inside getTodayRealizedDay() now sums effectivePnl(r) instead of r.pnl,
// in scan_v21.js and scan_lab.js, and NOTHING else moved.
//
// How it works, same as the sibling suites: regions are extracted FROM THE
// REAL SOURCE by text and executed with stubs, so the test cannot drift
// away from the shipped code. grab() throws when a regex stops matching
// rather than letting an assertion pass vacuously.
//
// BASE_SHA is the commit this change was written against. It is pinned:
// origin/main moves on its own (the Railway runner commits state every
// cycle), so comparing against a moving ref would make this suite
// non-deterministic.
// ════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE_SHA = "133285b4c9476995728d23d9cdc5920ddb1991f4";

const lf = s => s.replace(/\r\n/g, "\n");
const showAt = (sha, file) => lf(execFileSync("git", ["show", `${sha}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

const FILES = { v21: "scan_v21.js", lab: "scan_lab.js" };
const OUTCOMES = { v21: "outcomes_v21.jsonl", lab: "outcomes_lab.jsonl" };
const LIMITS = { v21: { loss: -280, dll: -600, floor: 170 }, lab: { loss: -500, dll: -1000, floor: 300 } };

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

const RE = {
  effPnl: /function effectivePnl\(r\) \{[\s\S]*?\n\}/,
  day: /function getTodayRealizedDay\(\) \{[\s\S]*?\n\}/,
  wrap: /function getTodayRealizedPnl\(\) \{ return getTodayRealizedDay\(\)\.net; \}/,
  loss: /const STOP_DAY_LOSS\s*=\s*-?\d+;/,
  floor: /const PROFIT_FLOOR\s*=\s*-?\d+;/,
  enabled: /const PROFIT_FLOOR_ENABLED = (true|false);/,
  dllV21: /const DAILY_LOSS_LIMIT\s*=\s*-?\d+;/,
  dllLab: /const MAX_DAILY_LOSS\s+=\s*\d+;[^\n]*/,
  pfFn: /function profitFloor\(_peakTotal\) \{ return PROFIT_FLOOR; \}/,
  ctx: /const realizedDay = getTodayRealizedDay\(\);\n  const dayTotal[\s\S]*?\n  \};/,
  logTrade: /\nfunction logTrade\(pos, symbol, exitPremium, reason, fillSource, exitStockPrice, exitFill = null\) \{[\s\S]*?\n\}/,
  // LAB-only learner regions. v21 has no self-tuner.
  tuningBucket: /function tuningBucket\(r\) \{[\s\S]*?\n\}/,
  computeMetric: /function computeMetric\(metricName, records\) \{[\s\S]*?\n\}/,
  computeCombos: /function computeCombos\(records, previousCombos\) \{[\s\S]*?\n\}/,
  cooldownSet: /state\._cooldowns\[`\$\{symbol\}_\$\{pos\.signal\}`\] = Date\.now\(\) \+ COOLDOWN_DURATION;/,
  cooldownGate: /if \(state\._cooldowns\[cooldownKey\] && state\._cooldowns\[cooldownKey\] > Date\.now\(\)\) \{[\s\S]*?\n  \}/,
  // v21 and LAB serialise the record differently, so the win flag is
  // matched on its own rather than on its surrounding line.
  winField: /win: pnl > 0,/,
};

// The comment block the change added, stripped so the FUNCTION BODY can be
// compared byte for byte against BASE_SHA. Only the one accumulation line
// is allowed to differ.
const normaliseDay = text => text
  .replace(/^.*Fill-accurate where the fill is known.*\n/m, "")
  .replace(/^.*the ONLY line in this file that switched.*\n/m, "")
  .replace(/^.*\(tuningBucket, computeMetric, combos\), the `win` flag.*\n/m, "")
  .replace(/^.*cooldown and daily_report\.js all still read `r\.pnl`\..*\n/m, "")
  .replace("net += effectivePnl(r);", "net += r.pnl;");

// Build the real day replay, with the real helper, over a stubbed fs.
function makeDay(bot, fileText, today = "2026-10-20") {
  const fsStub = { readFileSync: () => { if (fileText === null) throw new Error("ENOENT"); return fileText; } };
  const consts = [
    grab(src[bot], RE.loss, `STOP_DAY_LOSS/${bot}`),
    grab(src[bot], RE.floor, `PROFIT_FLOOR/${bot}`),
    grab(src[bot], RE.pfFn, `profitFloor/${bot}`),
  ].join("\n");
  return new Function("fs", "getToday",
    `${consts}\n${grab(src[bot], RE.effPnl, `effPnl/${bot}`)}\n` +
    `${grab(src[bot], RE.day, `day/${bot}`)}\n${grab(src[bot], RE.wrap, `wrap/${bot}`)}\n` +
    `return { getTodayRealizedDay, getTodayRealizedPnl, effectivePnl };`)(fsStub, () => today);
}

// The same replay with the FALSY implementation (`r.pnlAtFill || r.pnl`)
// substituted in — the trap this change had to avoid. Used in section 6 to
// prove the difference is real on real data, not hypothetical.
function makeFalsy(bot, fileText, today = "2026-10-20") {
  const fsStub = { readFileSync: () => { if (fileText === null) throw new Error("ENOENT"); return fileText; } };
  const helper = grab(src[bot], RE.effPnl, `effPnl/${bot}`)
    .replace("(typeof r.pnlAtFill === \"number\") ? r.pnlAtFill : r.pnl", "r.pnlAtFill || r.pnl");
  if (!/r\.pnlAtFill \|\| r\.pnl/.test(helper)) throw new Error("falsy substitution failed — the helper body changed shape");
  const consts = [grab(src[bot], RE.loss, "loss"), grab(src[bot], RE.floor, "floor"), grab(src[bot], RE.pfFn, "pf")].join("\n");
  return new Function("fs", "getToday",
    `${consts}\n${helper}\n${grab(src[bot], RE.day, `day/${bot}`)}\n${grab(src[bot], RE.wrap, `wrap/${bot}`)}\n` +
    `return { getTodayRealizedDay, getTodayRealizedPnl };`)(fsStub, () => today);
}

// The frozen pnl-only replay, for the real-history regression.
function makeReported(bot, fileText, today = "2026-10-20") {
  const fsStub = { readFileSync: () => { if (fileText === null) throw new Error("ENOENT"); return fileText; } };
  const helper = "function effectivePnl(r) { return r.pnl; }";
  const consts = [grab(src[bot], RE.loss, "loss"), grab(src[bot], RE.floor, "floor"), grab(src[bot], RE.pfFn, "pf")].join("\n");
  return new Function("fs", "getToday",
    `${consts}\n${helper}\n${grab(src[bot], RE.day, `day/${bot}`)}\n${grab(src[bot], RE.wrap, `wrap/${bot}`)}\n` +
    `return { getTodayRealizedDay, getTodayRealizedPnl };`)(fsStub, () => today);
}

const rec = o => JSON.stringify({
  day: "2026-10-20", symbol: "NVDA", reason: "alpaca_stop",
  exitTime: "2026-10-20T15:00:00.000Z", pnl: 0, ...o,
});
const logOf = lines => lines.join("\n") + "\n";

console.log("═══════════════════════════════════════════════════════════");
console.log(" test_effective_pnl — day-level fill-accurate P&L");
console.log(`  pinned base: ${BASE_SHA.slice(0, 12)}`);
console.log("═══════════════════════════════════════════════════════════");

// ════════════════════════════════════════════════════════════
// 1) effectivePnl() semantics
// ════════════════════════════════════════════════════════════
console.log("\n── 1) semantics of effectivePnl(r) ──");
for (const bot of ["v21", "lab"]) {
  const { effectivePnl: f } = makeDay(bot, logOf([rec({})]));
  check(`${bot}: a number is used`, f({ pnl: 100, pnlAtFill: 42 }) === 42, f({ pnl: 100, pnlAtFill: 42 }), 42);
  check(`${bot}: ZERO is used, not treated as falsy`, f({ pnl: 132, pnlAtFill: 0 }) === 0, f({ pnl: 132, pnlAtFill: 0 }), 0);
  check(`${bot}: a negative number is used`, f({ pnl: 10, pnlAtFill: -77 }) === -77, f({ pnl: 10, pnlAtFill: -77 }), -77);
  check(`${bot}: a fractional number is used`, f({ pnl: 10, pnlAtFill: -0.5 }) === -0.5, f({ pnl: 10, pnlAtFill: -0.5 }), -0.5);
  check(`${bot}: undefined falls back to pnl`, f({ pnl: 55, pnlAtFill: undefined }) === 55, f({ pnl: 55, pnlAtFill: undefined }), 55);
  check(`${bot}: a missing key falls back to pnl`, f({ pnl: 55 }) === 55, f({ pnl: 55 }), 55);
  check(`${bot}: null falls back to pnl`, f({ pnl: 55, pnlAtFill: null }) === 55, f({ pnl: 55, pnlAtFill: null }), 55);
  check(`${bot}: a numeric STRING falls back to pnl`, f({ pnl: 55, pnlAtFill: "42" }) === 55, f({ pnl: 55, pnlAtFill: "42" }), 55);
  check(`${bot}: false falls back to pnl`, f({ pnl: 55, pnlAtFill: false }) === 55, f({ pnl: 55, pnlAtFill: false }), 55);
  check(`${bot}: an object falls back to pnl`, f({ pnl: 55, pnlAtFill: {} }) === 55, f({ pnl: 55, pnlAtFill: {} }), 55);
  // typeof NaN === "number", so NaN IS taken. Asserted rather than wished
  // away: logTrade never writes NaN (it writes a rounded number or omits
  // the field), and a silent fallback here would hide a corrupt log.
  check(`${bot}: NaN is taken (typeof NaN === "number") and is visible, not masked`,
    Number.isNaN(f({ pnl: 55, pnlAtFill: NaN })), f({ pnl: 55, pnlAtFill: NaN }), "NaN");
  check(`${bot}: the helper reads ONLY pnlAtFill and pnl`,
    /^function effectivePnl\(r\) \{\n  return \(typeof r\.pnlAtFill === "number"\) \? r\.pnlAtFill : r\.pnl;\n\}$/
      .test(grab(src[bot], RE.effPnl, "effPnl")),
    grab(src[bot], RE.effPnl, "effPnl"), "the exact approved one-liner");
}

// ════════════════════════════════════════════════════════════
// 2) the helper is the same in both bots, and new in both
// ════════════════════════════════════════════════════════════
console.log("\n── 2) the helper is identical across the two bots ──");
check("effectivePnl() is byte-identical in scan_v21.js and scan_lab.js",
  grab(src.v21, RE.effPnl, "v21") === grab(src.lab, RE.effPnl, "lab"),
  { v21: grab(src.v21, RE.effPnl, "v21"), lab: grab(src.lab, RE.effPnl, "lab") }, "identical");
for (const bot of ["v21", "lab"]) {
  check(`${bot}: the helper did not exist at ${BASE_SHA.slice(0, 8)}`,
    !/function effectivePnl\(/.test(base[bot]), "already present", "new");
  check(`${bot}: the helper sits immediately before getTodayRealizedDay()`,
    /function effectivePnl\(r\) \{[\s\S]*?\n\}\n\nfunction getTodayRealizedDay\(\) \{/.test(src[bot]),
    "elsewhere", "adjacent");
  check(`${bot}: exactly one definition of it`,
    (src[bot].match(/function effectivePnl\(/g) || []).length === 1,
    (src[bot].match(/function effectivePnl\(/g) || []).length, 1);
}

// ════════════════════════════════════════════════════════════
// 3) the day replay, over synthetic records
// ════════════════════════════════════════════════════════════
console.log("\n── 3) the day replay under effectivePnl ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  const D = makeDay(bot, logOf([
    rec({ pnl: 500, pnlAtFill: 100, exitTime: "2026-10-20T14:00:00.000Z" }),
    rec({ pnl: 50, exitTime: "2026-10-20T15:00:00.000Z" }),
  ])).getTodayRealizedDay();
  check(`${bot}: net mixes fill-accurate and reported records`, D.net === 150, D.net, 150);
  check(`${bot}: peak follows the fill-accurate running net`, D.peak === 150, D.peak, 150);

  // A record whose fill P&L is zero must contribute zero, not its pnl.
  const Z = makeDay(bot, logOf([rec({ pnl: 999, pnlAtFill: 0 }), rec({ pnl: 10, exitTime: "2026-10-20T16:00:00.000Z" })]))
    .getTodayRealizedDay();
  check(`${bot}: a pnlAtFill of 0 contributes 0`, Z.net === 10, Z.net, 10);

  // The stop latches off the fill-accurate net, and a later recovery
  // cannot clear it.
  const S = makeDay(bot, logOf([
    rec({ pnl: 0, pnlAtFill: L.loss, exitTime: "2026-10-20T14:00:00.000Z" }),
    rec({ pnl: 0, pnlAtFill: 5000, exitTime: "2026-10-20T15:00:00.000Z" }),
  ])).getTodayRealizedDay();
  check(`${bot}: STOP_DAY_LOSS (${L.loss}) latches on the fill-accurate net`, S.stopped === true, S, { stopped: true });
  check(`${bot}: reason is "loss"`, S.reason === "loss", S.reason, "loss");
  check(`${bot}: a later recovery does not clear the latch`, S.stopped === true && S.net === L.loss + 5000, S, "still stopped");

  // The mirror case: a day that LOOKS stopped on reported pnl but is not
  // on fills, and the reverse. Both directions must be driven by fills.
  const notStopped = makeDay(bot, logOf([rec({ pnl: L.loss, pnlAtFill: -1 })])).getTodayRealizedDay();
  check(`${bot}: reported-only breach does NOT stop when the fill is fine`,
    notStopped.stopped === false && notStopped.net === -1, notStopped, { stopped: false, net: -1 });
  const nowStopped = makeDay(bot, logOf([rec({ pnl: -1, pnlAtFill: L.loss })])).getTodayRealizedDay();
  check(`${bot}: fill-only breach DOES stop when reported looks fine`,
    nowStopped.stopped === true && nowStopped.net === L.loss, nowStopped, { stopped: true, net: L.loss });

  // One cent above the line must not trip it.
  const just = makeDay(bot, logOf([rec({ pnl: 0, pnlAtFill: L.loss + 1 })])).getTodayRealizedDay();
  check(`${bot}: ${L.loss + 1} does not trip the stop`, just.stopped === false, just, { stopped: false });

  // Ordering: the latch depends on the running net, so records must be
  // replayed in exitTime order whatever the file order.
  const seq = [
    rec({ pnl: 0, pnlAtFill: L.loss, exitTime: "2026-10-20T14:00:00.000Z" }),
    rec({ pnl: 0, pnlAtFill: 5000, exitTime: "2026-10-20T15:00:00.000Z" }),
  ];
  const fwd = makeDay(bot, logOf(seq)).getTodayRealizedDay();
  const rev = makeDay(bot, logOf(seq.slice().reverse())).getTodayRealizedDay();
  check(`${bot}: file order does not change the outcome`,
    fwd.stopped === rev.stopped && fwd.net === rev.net && fwd.peak === rev.peak, { fwd, rev }, "equal");

  // Other days, a malformed line and a missing file must all be survivable.
  const other = makeDay(bot, logOf([
    rec({ pnl: 0, pnlAtFill: 10 }),
    rec({ day: "2026-10-19", pnl: 0, pnlAtFill: -99999 }),
    "{ not json",
  ])).getTodayRealizedDay();
  check(`${bot}: another day's records are ignored`, other.net === 10, other.net, 10);
  check(`${bot}: a malformed line is skipped`, other.stopped === false, other, { stopped: false });
  const miss = makeDay(bot, null).getTodayRealizedDay();
  check(`${bot}: a missing outcomes file reads as a flat day`,
    miss.net === 0 && miss.peak === 0 && miss.stopped === false, miss, { net: 0, peak: 0, stopped: false });

  // getTodayRealizedPnl() must stay a thin wrapper over the same net.
  const W = makeDay(bot, logOf([rec({ pnl: 999, pnlAtFill: -12 })]));
  check(`${bot}: getTodayRealizedPnl() returns the same fill-accurate net`,
    W.getTodayRealizedPnl() === W.getTodayRealizedDay().net && W.getTodayRealizedPnl() === -12,
    W.getTodayRealizedPnl(), -12);
}

// ════════════════════════════════════════════════════════════
// 4) ONE line changed, and only that line
// ════════════════════════════════════════════════════════════
console.log(`\n── 4) only the accumulation line moved vs ${BASE_SHA.slice(0, 8)} ──`);
for (const bot of ["v21", "lab"]) {
  const now = grab(src[bot], RE.day, `day/${bot}`);
  check(`${bot}: getTodayRealizedDay() identical after normalising the sum line`,
    normaliseDay(now) === grab(base[bot], RE.day, `day/${bot}@base`),
    "changed beyond the one accumulation line", "identical");
  check(`${bot}: the new line is present`, /\n    net \+= effectivePnl\(r\);\n/.test(now), "missing", "present");
  check(`${bot}: the old line is gone`, !/net \+= r\.pnl;/.test(now), "still there", "gone");
  check(`${bot}: exactly one accumulation line`,
    (now.match(/net \+= /g) || []).length === 1, (now.match(/net \+= /g) || []).length, 1);
  check(`${bot}: getTodayRealizedPnl() byte-identical`,
    grab(src[bot], RE.wrap, "wrap") === grab(base[bot], RE.wrap, "wrap@base"), "changed", "identical");
  check(`${bot}: the DAY CONTEXT block byte-identical`,
    grab(src[bot], RE.ctx, "ctx") === grab(base[bot], RE.ctx, "ctx@base"), "changed", "identical");
  check(`${bot}: logTrade() byte-identical`,
    grab(src[bot], RE.logTrade, "logTrade") === grab(base[bot], RE.logTrade, "logTrade@base"), "changed", "identical");
  check(`${bot}: the win flag still comes from reported pnl`,
    grab(src[bot], RE.winField, "win") === grab(base[bot], RE.winField, "win@base"), "changed", "identical");
  // effectivePnl must be CALLED in exactly one place: the day replay.
  // (The identifier also appears in its own doc comment, so comment lines
  // are excluded rather than counted.)
  const codeLines = src[bot].split("\n").filter(l => !l.trim().startsWith("//"));
  const defs = codeLines.filter(l => /function effectivePnl\(/.test(l)).length;
  const calls = codeLines.filter(l => /(?<!function )effectivePnl\(r\)/.test(l) && !/function effectivePnl/.test(l)).length;
  check(`${bot}: exactly one definition and one call site in code`,
    defs === 1 && calls === 1, { defs, calls }, { defs: 1, calls: 1 });
  check(`${bot}: the single call site is the day replay's accumulation`,
    codeLines.filter(l => /effectivePnl\(r\)/.test(l) && !/function/.test(l))[0].trim() === "net += effectivePnl(r);",
    codeLines.filter(l => /effectivePnl\(r\)/.test(l) && !/function/.test(l)), "net += effectivePnl(r);");
  // Whole-file diff: the ONLY non-comment line that changed is the sum.
  const dayNow = now.split("\n"), dayBase = grab(base[bot], RE.day, "base").split("\n");
  const codeOf = ls => ls.map(l => l.trim()).filter(l => l && !l.startsWith("//"));
  const cn = codeOf(dayNow), cb = codeOf(dayBase);
  const differing = cn.filter((l, i) => l !== cb[i]);
  check(`${bot}: exactly one differing code line in the function`,
    cn.length === cb.length && differing.length === 1 && differing[0] === "net += effectivePnl(r);",
    { lines: [cn.length, cb.length], differing }, ["net += effectivePnl(r);"]);
}

// ════════════════════════════════════════════════════════════
// 5) the thresholds were NOT retuned, and still read the same net
// ════════════════════════════════════════════════════════════
console.log("\n── 5) thresholds untouched, consumers unchanged ──");
check(`v21 STOP_DAY_LOSS still ${LIMITS.v21.loss}`, grab(src.v21, RE.loss, "l") === `const STOP_DAY_LOSS     = ${LIMITS.v21.loss};`.replace(/\s+=/, m => m), /= *-280;/.test(grab(src.v21, RE.loss, "l")), "-280");
for (const bot of ["v21", "lab"]) {
  for (const [label, re] of [["STOP_DAY_LOSS", RE.loss], ["PROFIT_FLOOR", RE.floor],
                             ["PROFIT_FLOOR_ENABLED", RE.enabled], ["profitFloor()", RE.pfFn]]) {
    check(`${bot}: ${label} byte-identical to base`,
      grab(src[bot], re, label) === grab(base[bot], re, `${label}@base`), grab(src[bot], re, label), "identical");
  }
}
check("v21: DAILY_LOSS_LIMIT byte-identical to base",
  grab(src.v21, RE.dllV21, "dll") === grab(base.v21, RE.dllV21, "dll@base"), grab(src.v21, RE.dllV21, "dll"), "identical");
check("lab: MAX_DAILY_LOSS byte-identical to base",
  grab(src.lab, RE.dllLab, "mdl") === grab(base.lab, RE.dllLab, "mdl@base"), grab(src.lab, RE.dllLab, "mdl"), "identical");

// Every day-level consumer must still route through the one replay, so the
// fill-accurate net reaches all of them without any of them being edited.
const CONSUMERS = {
  v21: [
    [/if \(getTodayRealizedPnl\(\) <= DAILY_LOSS_LIMIT\) \{/, "monitor daily-loss flatten"],
    [/const day = getTodayRealizedDay\(\);\n  if \(day\.stopped\) \{/, "entry gate: day stopped"],
    [/if \(day\.net <= DAILY_LOSS_LIMIT\) \{/, "entry gate: daily loss limit"],
    [/const realizedDay = getTodayRealizedDay\(\);\n  const dayTotal = realizedDay\.net \+ unrealPl;/, "profit floor day total"],
    [/const dayNow = getTodayRealizedDay\(\);\n  if \(dayNow\.net <= DAILY_LOSS_LIMIT/, "loss breaker alert"],
  ],
  lab: [
    [/if \(getTodayRealizedPnl\(\) <= -MAX_DAILY_LOSS\) \{/, "monitor daily-loss flatten"],
    [/const day = getTodayRealizedDay\(\);\n  if \(day\.stopped\) \{/, "entry gate: day stopped"],
    [/if \(day\.net <= -MAX_DAILY_LOSS\) \{/, "entry gate: daily loss cap"],
    [/const realizedDay = getTodayRealizedDay\(\);\n  const dayTotal = realizedDay\.net \+ unrealPl;/, "profit floor day total"],
    [/const dayNow = getTodayRealizedDay\(\);\n  if \(dayNow\.net <= -MAX_DAILY_LOSS/, "loss breaker alert"],
  ],
};
for (const [bot, list] of Object.entries(CONSUMERS)) {
  for (const [re, label] of list) {
    check(`${bot}: ${label} still reads the shared replay, unedited`,
      re.test(src[bot]) && re.test(base[bot]), { now: re.test(src[bot]), base: re.test(base[bot]) }, "present in both");
  }
}

// ════════════════════════════════════════════════════════════
// 6) the falsy trap, proven on real data
// ════════════════════════════════════════════════════════════
console.log("\n── 6) `||` would reintroduce the gap (real records) ──");
for (const bot of ["v21", "lab"]) {
  const real = lf(fs.readFileSync(OUTCOMES[bot], "utf8"));
  const zeroDays = [...new Set(real.split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.pnlAtFill === 0).map(r => r.day))];
  check(`${bot}: the log really contains a pnlAtFill === 0 record`, zeroDays.length >= 1, zeroDays.length, ">= 1");
  for (const d of zeroDays) {
    const good = makeDay(bot, real, d).getTodayRealizedDay();
    const bad = makeFalsy(bot, real, d).getTodayRealizedDay();
    check(`${bot} ${d}: the falsy form gives a different net (${bad.net} vs ${good.net})`,
      bad.net !== good.net, { falsy: bad.net, correct: good.net }, "different");
    check(`${bot} ${d}: the falsy net is the more flattering one`,
      bad.net > good.net, { falsy: bad.net, correct: good.net }, "falsy > correct");
  }
}
// The one case where it changes a DECISION, not just a number.
{
  const real = lf(fs.readFileSync(OUTCOMES.v21, "utf8"));
  const good = makeDay("v21", real, "2026-10-29").getTodayRealizedDay();
  const bad = makeFalsy("v21", real, "2026-10-29").getTodayRealizedDay();
  check("v21 2026-10-29: correct form nets -291 and FIRES STOP_DAY_LOSS",
    good.net === -291 && good.stopped === true, good, { net: -291, stopped: true });
  check("v21 2026-10-29: falsy form nets -159 and does NOT fire",
    bad.net === -159 && bad.stopped === false, bad, { net: -159, stopped: false });
}

// ════════════════════════════════════════════════════════════
// 7) the learner is untouched (reduced to byte-identity)
// ════════════════════════════════════════════════════════════
console.log(`\n── 7) learner regions byte-identical to ${BASE_SHA.slice(0, 8)} ──`);
for (const [label, re] of [["tuningBucket()", RE.tuningBucket], ["computeMetric()", RE.computeMetric],
                           ["computeCombos()", RE.computeCombos], ["cooldown write", RE.cooldownSet],
                           ["cooldown gate", RE.cooldownGate]]) {
  check(`lab: ${label} byte-identical`,
    grab(src.lab, re, label) === grab(base.lab, re, `${label}@base`), "changed", "identical");
}
check("lab: the learner still sums r.pnl, not effectivePnl",
  /const netPnl = records\.reduce\(\(a, r\) => a \+ r\.pnl, 0\);/.test(src.lab)
  && /byReason\[bucket\]\.pnl \+= r\.pnl;/.test(src.lab)
  && /const pnl = subset\.reduce\(\(a, x\) => a \+ x\.r\.pnl, 0\);/.test(src.lab),
  "a learner site switched", "all three still r.pnl");
check("lab: no effectivePnl( call anywhere after the replay",
  src.lab.indexOf("effectivePnl(r);") === src.lab.lastIndexOf("effectivePnl(r);"), "more than one call", "one call");

// ════════════════════════════════════════════════════════════
// 8) real-history regression: EXACTLY these changes, nothing else
// ════════════════════════════════════════════════════════════
console.log("\n── 8) real history: the complete set of behavioural changes ──");

// Pre-declared from the real logs at BASE_SHA. Any day not listed here must
// be bit-identical to the reported-pnl replay in net, peak, stopped and the
// daily-loss comparison. Any day listed must change by exactly this much.
const EXPECTED = {
  v21: {
    "2026-10-23": { net: [523, 514], peak: [523, 514] },
    "2026-10-26": { net: [-2, -66], peak: [0, 40] },
    "2026-10-27": { net: [-207, -177], peak: [63, 96] },
    "2026-10-28": { net: [-379, -486] },
    "2026-10-29": { net: [-168, -291], peak: [132, 0], stopped: [false, true], stopAt: "2026-10-29T14:49:40.791Z" },
    "2026-10-30": { net: [59, 19], peak: [59, 19] },
    "2026-11-02": { net: [194, 145], peak: [194, 145] },
  },
  lab: {
    "2026-10-23": { net: [330, 256], peak: [364, 290] },
    "2026-10-26": { net: [273, 164], peak: [273, 164] },
    "2026-10-27": { net: [306, 206], peak: [343, 247] },
    "2026-10-28": { net: [-318, -429], peak: [135, 124] },
    "2026-10-29": { net: [-388, -449] },
    "2026-10-30": { net: [305, 271], peak: [305, 271] },
    "2026-11-02": { net: [-395, -502], peak: [38, 0], stopped: [false, true], stopAt: "2026-11-02T18:05:43.061Z" },
  },
};

for (const bot of ["v21", "lab"]) {
  const real = lf(fs.readFileSync(OUTCOMES[bot], "utf8"));
  const recs = real.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const days = [...new Set(recs.map(r => r.day))].sort();
  const dll = LIMITS[bot].dll;
  const exp = EXPECTED[bot];

  let unexpected = [], wrong = [], unchangedOk = 0;
  for (const d of days) {
    const neu = makeDay(bot, real, d).getTodayRealizedDay();
    const old = makeReported(bot, real, d).getTodayRealizedDay();
    const e = exp[d];
    const differs = neu.net !== old.net || neu.peak !== old.peak || neu.stopped !== old.stopped
      || (neu.net <= dll) !== (old.net <= dll);
    if (!e) {
      if (differs) unexpected.push({ day: d, old, neu });
      else unchangedOk++;
      continue;
    }
    const want = { net: e.net[1], peak: e.peak ? e.peak[1] : old.peak, stopped: e.stopped ? e.stopped[1] : old.stopped };
    const oldWant = { net: e.net[0], peak: e.peak ? e.peak[0] : null };
    if (neu.net !== want.net || neu.peak !== want.peak || neu.stopped !== want.stopped
        || old.net !== oldWant.net || (e.peak && old.peak !== oldWant.peak)) {
      wrong.push({ day: d, old, neu, want, oldWant });
    }
    // The daily-loss limit must NOT start firing anywhere.
    if ((neu.net <= dll) !== (old.net <= dll)) wrong.push({ day: d, dll: [old.net <= dll, neu.net <= dll] });
  }

  check(`${bot}: ${days.length - Object.keys(exp).length} days outside the covered window are bit-identical`,
    unexpected.length === 0 && unchangedOk === days.length - Object.keys(exp).length,
    { unexpected, unchangedOk }, { unexpected: [], unchangedOk: days.length - Object.keys(exp).length });
  check(`${bot}: each of the ${Object.keys(exp).length} changed days changes by exactly the recorded amount`,
    wrong.length === 0, wrong, []);
  check(`${bot}: every expected day is present in the log`,
    Object.keys(exp).every(d => days.includes(d)), Object.keys(exp).filter(d => !days.includes(d)), []);
}

// The two decisions that actually flip, named and timed.
for (const [bot, day, expectedAt] of [["v21", "2026-10-29", "2026-10-29T14:49:40.791Z"],
                                      ["lab", "2026-11-02", "2026-11-02T18:05:43.061Z"]]) {
  const real = lf(fs.readFileSync(OUTCOMES[bot], "utf8"));
  const neu = makeDay(bot, real, day).getTodayRealizedDay();
  const old = makeReported(bot, real, day).getTodayRealizedDay();
  check(`${bot} ${day}: STOP_DAY_LOSS ${LIMITS[bot].loss} did NOT fire on reported pnl`,
    old.stopped === false, old, { stopped: false });
  check(`${bot} ${day}: STOP_DAY_LOSS ${LIMITS[bot].loss} DOES fire on fill-accurate pnl`,
    neu.stopped === true && neu.reason === "loss", neu, { stopped: true, reason: "loss" });
  // The firing time: the exitTime of the record whose running net first
  // crossed the line.
  const recs = real.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.day === day).sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
  let run = 0, at = null;
  for (const r of recs) { run += (typeof r.pnlAtFill === "number") ? r.pnlAtFill : r.pnl; if (at === null && run <= LIMITS[bot].loss) at = r.exitTime; }
  check(`${bot} ${day}: it would have fired at ${expectedAt}`, at === expectedAt, at, expectedAt);
}

// Only those two days flip a stop, across both whole logs.
for (const bot of ["v21", "lab"]) {
  const real = lf(fs.readFileSync(OUTCOMES[bot], "utf8"));
  const days = [...new Set(real.split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l).day; } catch { return null; } }).filter(Boolean))].sort();
  const flipped = days.filter(d => makeDay(bot, real, d).getTodayRealizedDay().stopped
                                !== makeReported(bot, real, d).getTodayRealizedDay().stopped);
  const want = bot === "v21" ? ["2026-10-29"] : ["2026-11-02"];
  check(`${bot}: exactly one day flips the stop, and it is ${want[0]}`,
    JSON.stringify(flipped) === JSON.stringify(want), flipped, want);
}

// ════════════════════════════════════════════════════════════
// 9) daily_report.js untouched (reduced to byte-identity)
// ════════════════════════════════════════════════════════════
console.log(`\n── 9) daily_report.js byte-identical to ${BASE_SHA.slice(0, 8)} ──`);
{
  const now = lf(fs.readFileSync("daily_report.js", "utf8"));
  check("daily_report.js whole file byte-identical", now === showAt(BASE_SHA, "daily_report.js"), "changed", "identical");
  check("daily_report.js still has no effectivePnl reference", !/effectivePnl/.test(now), "present", "absent");
  check("scan_wvad.js whole file byte-identical",
    lf(fs.readFileSync("scan_wvad.js", "utf8")) === showAt(BASE_SHA, "scan_wvad.js"), "changed", "identical");
  check("runner.js whole file byte-identical",
    lf(fs.readFileSync("runner.js", "utf8")) === showAt(BASE_SHA, "runner.js"), "changed", "identical");
}

console.log("\n═══════════════════════════════════════════════════════════");
console.log(` passed ${pass} | failed ${fail}`);
console.log("═══════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
