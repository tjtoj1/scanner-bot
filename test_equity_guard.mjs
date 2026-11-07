#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// test_equity_guard.mjs
//
// Guards the equity-drawdown early stop on v21 and LAB: equity 15% below
// the running peak stops NEW ENTRIES, stickily, without force-closing
// anything, and resumes only through the owner-edited resume file.
//
// The guard is extracted FROM THE REAL SOURCE by text and executed over a
// real temp state file, so the concurrency test exercises the actual
// read-modify-write rather than a re-implementation of it. grab() throws
// when a regex stops matching rather than letting an assertion pass
// vacuously.
// ════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE_SHA = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();

const lf = s => s.replace(/\r\n/g, "\n");
const showAt = (sha, f) => lf(execFileSync("git", ["show", `${sha}:${f}`], { encoding: "utf8", maxBuffer: 1 << 28 }));
const SRC = { v21: lf(fs.readFileSync("scan_v21.js", "utf8")), lab: lf(fs.readFileSync("scan_lab.js", "utf8")) };
const FILE = { v21: "scan_v21.js", lab: "scan_lab.js" };
const STATEFILE = { v21: "state_v21.json", lab: "state_lab.json" };

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
  threshold: /const EQUITY_DRAWDOWN_HALT = [\d.]+;[^\n]*/,
  botId: /const EQUITY_BOT_ID        = "[^"]+";/,
  resumeFile: /const EQUITY_RESUME_FILE   = "[^"]+";/,
  merge: /function mergeEquityGuard\(a = \{\}, b = \{\}\) \{[\s\S]*?\n\}/,
  saveState: /function saveState\(s\) \{\n  let out = s;[\s\S]*?\n\}/,
  amend: /function amendEquityGuard\(state, mutate\) \{[\s\S]*?\n\}/,
  loadResume: /function loadEquityResume\(\) \{[\s\S]*?\n\}/,
  resumeFor: /function equityResumeFor\(halt, todayUtc\) \{[\s\S]*?\n\}/,
  update: /async function updateEquityGuard\(state, equityNow\) \{[\s\S]*?\n  return \{ halted: false, unknown: false, peak: g\.peak \};\n\}/,
  // pinned regions, per bot
  alpaca: /async function alpaca\([\s\S]*?\n\}/,
  monitor: /async function monitorPosition\([\s\S]*?\n\}/,
  calcQty: /function calcQty\([\s\S]*?\n\}/,
  readPk: /function readDayPeak\(\) \{[\s\S]*?\n\}/,
  bumpPk: /function bumpDayPeak\(candidate\) \{[\s\S]*?\n\}/,
  dayCtx: /const realizedDay = getTodayRealizedDay\(\);\n  const dayTotal[\s\S]*?\n  \};/,
  getQuote: /async function getQuote\(optSym\) \{[\s\S]*?\n\}/,
  ownedQty: /async function getOwnedQty\([\s\S]*?\n\}/,
};

// ── build the real guard over a real temp state file ──────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eqguard-"));

// Every instance gets its OWN directory. Sharing one made each new
// makeGuard() overwrite the previous instance's state_*.json, which
// silently invalidated whole sections — the kind of cross-talk that makes
// a suite report green for the wrong reason.
let guardSeq = 0;
function makeGuard(bot, { today = "2026-11-07", tgResult = 12345, dir = null } = {}) {
  dir = dir || fs.mkdtempSync(path.join(TMP, `g${guardSeq++}-`));
  const statePath = path.join(dir, STATEFILE[bot]);
  const resumePath = path.join(dir, "equity_guard_resume.json");
  const tgCalls = [];
  const fsStub = {
    readFileSync: (p, enc) => fs.readFileSync(
      p === STATEFILE[bot] ? statePath : (p === "equity_guard_resume.json" ? resumePath : p), enc),
    writeFileSync: (p, data) => fs.writeFileSync(p === STATEFILE[bot] ? statePath : p, data),
  };
  const body =
    `${grab(SRC[bot], RE.threshold, "threshold")}\n`
    + `${grab(SRC[bot], RE.botId, "botId")}\n`
    + `${grab(SRC[bot], RE.resumeFile, "resumeFile")}\n`
    + `function loadState() { try { return JSON.parse(fs.readFileSync("${STATEFILE[bot]}", "utf8")); } catch { return {}; } }\n`
    + `${grab(SRC[bot], RE.saveState, `saveState/${bot}`).replace(STATEFILE[bot], STATEFILE[bot])}\n`
    + `function getToday() { return today; }\n`
    + `async function tg(text) { tgCalls.push(text); return tgResult; }\n`
    + `${grab(SRC[bot], RE.merge, "merge")}\n`
    + `${grab(SRC[bot], RE.amend, "amend")}\n`
    + `${grab(SRC[bot], RE.loadResume, "loadResume")}\n`
    + `${grab(SRC[bot], RE.resumeFor, "resumeFor")}\n`
    + `${grab(SRC[bot], RE.update, "update")}\n`
    + `return { updateEquityGuard, amendEquityGuard, mergeEquityGuard, loadEquityResume, equityResumeFor,`
    + ` loadState, saveState, EQUITY_DRAWDOWN_HALT };`;
  const api = new Function("fs", "today", "tgResult", "tgCalls", "console", body)(
    fsStub, today, tgResult, tgCalls, { log() {}, error() {}, warn() {} });
  return { ...api, tgCalls, statePath, resumePath,
    writeState: s => fs.writeFileSync(statePath, JSON.stringify(s, null, 2)),
    readState: () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } },
    writeResume: v => fs.writeFileSync(resumePath, typeof v === "string" ? v : JSON.stringify(v)),
    clearResume: () => { try { fs.unlinkSync(resumePath); } catch {} } };
}

console.log("════════════════════════════════════════════════════════════");
console.log(" test_equity_guard — 15% equity drawdown early stop");
console.log(`  base: ${BASE_SHA.slice(0, 12)}`);
console.log("════════════════════════════════════════════════════════════");

// ── 1) the threshold and its boundary ─────────────────────────────────
console.log("\n── 1) threshold and boundary ──");
for (const bot of ["v21", "lab"]) {
  check(`${bot}: EQUITY_DRAWDOWN_HALT is 0.15`,
    /const EQUITY_DRAWDOWN_HALT = 0\.15;/.test(SRC[bot]), grab(SRC[bot], RE.threshold, "t"), "0.15");
  check(`${bot}: EQUITY_BOT_ID is "${bot}"`,
    new RegExp(`const EQUITY_BOT_ID        = "${bot}";`).test(SRC[bot]), grab(SRC[bot], RE.botId, "b"), bot);
}
{
  const g = makeGuard("lab");
  g.writeState({ _equityGuard: { peak: 1000 } });
  // exactly 15% down must HALT (the rule says "falls 15% below")
  let r = await g.updateEquityGuard({}, 850);
  check("exactly -15.0% halts", r.halted === true, r, { halted: true });
  g.writeState({ _equityGuard: { peak: 1000 } });
  r = await g.updateEquityGuard({}, 850.01);
  check("one cent above the line does NOT halt", r.halted === false, r, { halted: false });
  g.writeState({ _equityGuard: { peak: 1000 } });
  r = await g.updateEquityGuard({}, 849.99);
  check("one cent below the line halts", r.halted === true, r, { halted: true });
}

// ── 2) the peak: seeded from the first reading, monotonic ─────────────
console.log("\n── 2) peak seeding and monotonicity ──");
{
  const g = makeGuard("lab");
  g.writeState({});
  let r = await g.updateEquityGuard({}, 5000);
  check("first reading seeds the peak (no historical seeding)", r.peak === 5000, r.peak, 5000);
  check("and does not halt on day one", r.halted === false, r, { halted: false });
  check("the peak is persisted", g.readState()._equityGuard.peak === 5000, g.readState()._equityGuard, 5000);
  check("peakAt is stamped", typeof g.readState()._equityGuard.peakAt === "string");

  r = await g.updateEquityGuard({}, 5600);
  check("a higher equity raises the peak", r.peak === 5600, r.peak, 5600);
  r = await g.updateEquityGuard({}, 5100);
  check("a lower equity does NOT lower the peak", r.peak === 5600, r.peak, 5600);
  const atBefore = g.readState()._equityGuard.peakAt;
  r = await g.updateEquityGuard({}, 5600);
  check("an equal equity does not rewrite peakAt", g.readState()._equityGuard.peakAt === atBefore);
  r = await g.updateEquityGuard({}, 4759);          // -15.02% of 5600
  check("the drop from the raised peak halts", r.halted === true, r, { halted: true });
}

// ── 3) unknown equity: refuse, never latch, never reset the peak ──────
console.log("\n── 3) unknown equity ──");
for (const bad of [NaN, undefined, null, "4500", 0, -100, {}, [], Infinity, -Infinity]) {
  const g = makeGuard("lab");
  g.writeState({ _equityGuard: { peak: 5000, peakAt: "2026-11-01T00:00:00.000Z" } });
  const st = {};
  const r = await g.updateEquityGuard(st, bad);
  const after = g.readState()._equityGuard;
  const label = typeof bad === "object" && bad !== null ? JSON.stringify(bad) : String(bad);
  check(`${label}: unknown=true, halted=false`, r.unknown === true && r.halted === false, r, { unknown: true, halted: false });
  check(`${label}: peak untouched at 5000`, after.peak === 5000, after.peak, 5000);
  check(`${label}: no halt latched`, after.halt === undefined, after.halt, undefined);
}
{
  // A string that happens to parse is still rejected — the guard requires
  // a real number, because parseFloat of an error body gives NaN and a
  // coerced string would hide a shape change.
  const g = makeGuard("lab");
  g.writeState({ _equityGuard: { peak: 5000 } });
  const r = await g.updateEquityGuard({}, "4000");
  check("a numeric STRING is treated as unknown, not as 4000", r.unknown === true, r, { unknown: true });
}

// ── 4) the latch is sticky, and recovery does not resume ──────────────
console.log("\n── 4) stickiness ──");
{
  const g = makeGuard("lab");
  g.writeState({ _equityGuard: { peak: 5000 } });
  let r = await g.updateEquityGuard({}, 4200);
  check("halt latches", r.halted === true, r, { halted: true });
  const h = g.readState()._equityGuard.halt;
  check("halt records equityAtHalt", h.equityAtHalt === 4200, h.equityAtHalt, 4200);
  check("halt records peakAtHalt", h.peakAtHalt === 5000, h.peakAtHalt, 5000);
  check("halt records pctFromPeak", h.pctFromPeak === -16, h.pctFromPeak, -16);
  check("halt stamps haltedAt", typeof h.haltedAt === "string");

  // Full recovery, and well above the old peak.
  r = await g.updateEquityGuard({}, 9999);
  check("equity far above the peak does NOT resume", r.halted === true, r, { halted: true });
  check("haltedAt is unchanged by the recovery", g.readState()._equityGuard.halt.haltedAt === h.haltedAt);
  check("the peak is NOT raised while halted (no read happens)",
    g.readState()._equityGuard.peak === 5000, g.readState()._equityGuard.peak, 5000);
  // Unknown equity while halted stays halted.
  r = await g.updateEquityGuard({}, NaN);
  check("unknown equity while halted stays halted", r.halted === true, r, { halted: true });
}

// ── 5) CONCURRENT CHILDREN: the halt must survive ─────────────────────
console.log("\n── 5) two children writing state_*.json concurrently ──");
{
  // The hazard: scan and monitor children both rewrite the whole state
  // file. A guard mutated only in memory is erased by whichever saves
  // last. Each child here holds its OWN stale in-memory object, exactly
  // as a real child does.
  const g = makeGuard("lab");
  g.writeState({ NVDA: { active: true }, _equityGuard: { peak: 5000 } });

  const scanChild = g.loadState();      // both children read the same file
  const monitorChild = g.loadState();

  // The scan child latches the halt via the real amend path.
  const r1 = await g.updateEquityGuard(scanChild, 4100);
  check("scan child latches the halt", r1.halted === true, r1, { halted: true });
  check("the halt is on disk", !!g.readState()._equityGuard.halt, g.readState()._equityGuard, "halt present");

  // Now the monitor child, holding state from BEFORE the halt, does what
  // monitorPosition does at the end of a cycle: a wholesale saveState of
  // its own stale object. It knows nothing about the guard.
  const haltBefore = g.readState()._equityGuard.halt.haltedAt;
  monitorChild.NVDA = { active: false, closed: true };
  g.saveState(monitorChild);
  check("a stale wholesale save does NOT erase the halt",
    g.readState()._equityGuard?.halt?.haltedAt === haltBefore, g.readState()._equityGuard, haltBefore);
  check("and the stale child's own fields were still written",
    g.readState().NVDA.closed === true, g.readState().NVDA, { closed: true });
  check("the peak also survives the stale save",
    g.readState()._equityGuard.peak === 5000, g.readState()._equityGuard.peak, 5000);

  // The reverse order too: the stale child saves first, then the guard
  // child latches. Both orderings must end halted.
  const gRev = makeGuard("lab");
  gRev.writeState({ NVDA: { active: true }, _equityGuard: { peak: 5000 } });
  const stale = gRev.loadState();
  gRev.saveState(stale);                                 // stale write first
  const rRev = await gRev.updateEquityGuard(gRev.loadState(), 4100);
  check("reverse order: stale save then latch ⇒ halted", rRev.halted === true, rRev, { halted: true });

  // A monitor child that saves repeatedly must not wear the halt away.
  for (let i = 0; i < 5; i++) g.saveState(monitorChild);
  check("five more stale saves still do not erase it",
    g.readState()._equityGuard?.halt?.haltedAt === haltBefore, g.readState()._equityGuard, haltBefore);

  // And the guard is still halted when read back through the real path.
  const r2 = await g.updateEquityGuard(g.loadState(), 9999);
  check("still halted after the stale saves, even at a recovered equity",
    r2.halted === true, r2, { halted: true });

  // The amend path itself must never lose a concurrent halt: a child that
  // re-reads and merges keeps the other child's halt.
  const g2 = makeGuard("lab");
  g2.writeState({ _equityGuard: { peak: 5000 } });
  const childA = g2.loadState();
  await g2.updateEquityGuard(childA, 4100);              // A latches, on disk
  const haltA = g2.readState()._equityGuard.halt.haltedAt;
  // B must look like a REAL child: its guard came from loadState() at the
  // same base revision A started from, not from thin air. A guard with no
  // rev at all is pre-revision state and deliberately loses to anything
  // revisioned — asserted separately below.
  const childB = g2.loadState();
  childB._equityGuard = { ...childB._equityGuard, peak: 5200 };   // B saw a higher peak
  const merged = g2.amendEquityGuard(childB, guard => { /* B bumps nothing extra */ });
  check("amend MERGES: B's write keeps A's halt", merged.halt?.haltedAt === haltA, merged.halt, haltA);
  check("amend MERGES: the peak is the maximum of both views", merged.peak === 5200, merged.peak, 5200);
  check("a guard with NO rev loses to a revisioned one (pre-revision state is older)",
    g2.mergeEquityGuard({ rev: 0, peak: 1 }, { peak: 9999 }).peak === 1,
    g2.mergeEquityGuard({ rev: 0, peak: 1 }, { peak: 9999 }).peak, 1);
  check("the merged result is persisted", g2.readState()._equityGuard.halt?.haltedAt === haltA);
  check("amend copies the result back into the caller's object",
    childB._equityGuard.halt?.haltedAt === haltA, childB._equityGuard, "carries the halt");

  // Interleaved: A reads, B reads, A saves, B saves — through amend both
  // times, which is the whole point of the pattern.
  const g3 = makeGuard("lab");
  g3.writeState({ _equityGuard: { peak: 6000 } });
  const a3 = g3.loadState(), b3 = g3.loadState();
  await g3.updateEquityGuard(a3, 5000);                   // A latches (-16.7%)
  const h3 = g3.readState()._equityGuard.halt.haltedAt;
  g3.amendEquityGuard(b3, guard => {                      // B, stale, raises the peak
    if (!Number.isFinite(guard.peak) || 6100 > guard.peak) { guard.peak = 6100; }
  });
  const fin = g3.readState()._equityGuard;
  check("interleaved amends: halt survives", fin.halt?.haltedAt === h3, fin.halt, h3);
  check("interleaved amends: peak is the max", fin.peak === 6100, fin.peak, 6100);
}

// ── 6) mergeEquityGuard in isolation ─────────────────────────────────
console.log("\n── 6) merge semantics ──");
{
  const g = makeGuard("lab");
  const m = g.mergeEquityGuard;
  check("peak is the maximum", m({ peak: 10 }, { peak: 20 }).peak === 20);
  check("peak max is order-independent", m({ peak: 20 }, { peak: 10 }).peak === 20);
  check("a missing peak loses to a present one", m({}, { peak: 7 }).peak === 7);
  check("two empty views give no peak key", m({}, {}).peak === undefined);
  check("peakAt follows the winning peak", m({ peak: 10, peakAt: "A" }, { peak: 20, peakAt: "B" }).peakAt === "B");
  const hEarly = { haltedAt: "2026-11-07T10:00:00.000Z", alertedAt: null };
  const hLate = { haltedAt: "2026-11-07T12:00:00.000Z", alertedAt: "2026-11-07T12:00:01.000Z" };
  check("a halt from either side survives", m({ halt: hEarly }, {}).halt.haltedAt === hEarly.haltedAt);
  check("a halt from the other side survives", m({}, { halt: hEarly }).halt.haltedAt === hEarly.haltedAt);
  check("the EARLIER halt wins", m({ halt: hLate }, { halt: hEarly }).halt.haltedAt === hEarly.haltedAt);
  check("an alert sent by either side counts as sent",
    m({ halt: hEarly }, { halt: hLate }).halt.alertedAt === hLate.alertedAt);
  check("no halt anywhere gives no halt key", m({ peak: 1 }, { peak: 2 }).halt === undefined);

  // The revision counter: newer knowledge wins outright, which is what
  // makes an owner resume able to clear a halt and lower the peak.
  const older = { rev: 3, peak: 5000, halt: hEarly };
  const newer = { rev: 4, peak: 4100 };
  check("a strictly newer rev wins outright", m(older, newer).peak === 4100, m(older, newer), { peak: 4100 });
  check("and it can clear a halt", m(older, newer).halt === undefined, m(older, newer).halt, undefined);
  check("rev order does not matter", JSON.stringify(m(newer, older)) === JSON.stringify(m(older, newer)));
  check("a missing rev loses to a present one", m({ peak: 9999 }, { rev: 0, peak: 1 }).peak === 1);
  check("at EQUAL rev the conflict-free rules apply",
    m({ rev: 2, peak: 10 }, { rev: 2, peak: 20 }).peak === 20);
  check("at equal rev a halt from either side still survives",
    m({ rev: 2, halt: hEarly }, { rev: 2, peak: 1 }).halt?.haltedAt === hEarly.haltedAt);
  check("the merged rev is carried", m({ rev: 2, peak: 1 }, { rev: 2, peak: 2 }).rev === 2);
}

// ── 6b) rev advances on every write ──────────────────────────────────
console.log("\n── 6b) revision counter ──");
{
  const g = makeGuard("lab");
  g.writeState({});
  await g.updateEquityGuard({}, 5000);
  const r1 = g.readState()._equityGuard.rev;
  check("the first write sets rev", Number.isFinite(r1), r1, "a number");
  await g.updateEquityGuard(g.loadState(), 5500);
  const r2 = g.readState()._equityGuard.rev;
  check("a peak bump advances rev", r2 > r1, { r1, r2 }, "r2 > r1");
  await g.updateEquityGuard(g.loadState(), 4000);        // latches
  const r3 = g.readState()._equityGuard.rev;
  check("a latch advances rev", r3 > r2, { r2, r3 }, "r3 > r2");
  // A no-op read while halted must NOT advance rev (nothing was written).
  await g.updateEquityGuard(g.loadState(), 4000);
  check("a halted no-op does not advance rev", g.readState()._equityGuard.rev === r3,
    g.readState()._equityGuard.rev, r3);
}

// ── 7) resume: owner-edited file only, bound to this halt ─────────────
console.log("\n── 7) resume ──");
{
  const mk = () => { const g = makeGuard("lab"); g.writeState({ _equityGuard: { peak: 5000 } }); return g; };
  const latch = async g => { await g.updateEquityGuard({}, 4100); return g.readState()._equityGuard.halt.haltedAt; };

  let g = mk(); let h = await latch(g);
  g.clearResume();
  let r = await g.updateEquityGuard(g.loadState(), 4100);
  check("no resume file ⇒ still halted", r.halted === true, r, { halted: true });

  g = mk(); h = await latch(g);
  g.writeResume("{ not json");
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("unparseable resume file ⇒ still halted", r.halted === true);

  g = mk(); h = await latch(g);
  g.writeResume({ resume: "nope" });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("`resume` not an array ⇒ still halted", r.halted === true);

  g = mk(); h = await latch(g);
  g.writeResume({ resume: [{ bot: "lab", clearHaltedAt: "2026-01-01T00:00:00.000Z", resetPeakTo: 4100, expires: "2026-12-31" }] });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("WRONG clearHaltedAt ⇒ still halted (a stale file cannot clear a future halt)", r.halted === true);

  g = mk(); h = await latch(g);
  g.writeResume({ resume: [{ bot: "v21", clearHaltedAt: h, resetPeakTo: 4100, expires: "2026-12-31" }] });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("an entry for the OTHER bot ⇒ still halted", r.halted === true);

  g = mk(); h = await latch(g);
  g.writeResume({ resume: [{ bot: "lab", clearHaltedAt: h, resetPeakTo: 4100, expires: "2026-11-06" }] });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("EXPIRED (yesterday) ⇒ still halted", r.halted === true);

  g = mk(); h = await latch(g);
  g.writeResume({ resume: [{ bot: "lab", clearHaltedAt: h, resetPeakTo: 4100, expires: "2026-11-07" }] });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("expires TODAY is still valid (inclusive)", r.halted === false, r, { halted: false });

  g = mk(); h = await latch(g);
  g.writeResume({ resume: [{ bot: "lab", clearHaltedAt: h, expires: "2026-12-31" }] });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("MISSING resetPeakTo ⇒ rejected, still halted (otherwise it re-halts instantly)", r.halted === true);

  g = mk(); h = await latch(g);
  g.writeResume({ resume: [{ bot: "lab", clearHaltedAt: h, resetPeakTo: 0, expires: "2026-12-31" }] });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("resetPeakTo of 0 ⇒ rejected", r.halted === true);

  // A valid resume, and the cycle after it must not re-halt.
  g = mk(); h = await latch(g);
  g.writeResume({ resume: [{ bot: "lab", clearHaltedAt: h, resetPeakTo: 4100, expires: "2026-12-31" }] });
  r = await g.updateEquityGuard(g.loadState(), 4100);
  check("valid resume clears the halt", r.halted === false, r, { halted: false });
  check("the halt is gone from disk", g.readState()._equityGuard.halt === undefined);
  check("the peak was reset as instructed", g.readState()._equityGuard.peak === 4100, g.readState()._equityGuard.peak, 4100);
  check("resumedAt is stamped", typeof g.readState()._equityGuard.resumedAt === "string");
  const r2 = await g.updateEquityGuard(g.loadState(), 4100);
  check("the NEXT cycle does not immediately re-halt", r2.halted === false, r2, { halted: false });
  check("a resume sends a Telegram message", g.tgCalls.some(t => /استئناف/.test(t)), g.tgCalls.length, ">0");
}

// ── 8) the Telegram alert ─────────────────────────────────────────────
console.log("\n── 8) one alert, correct wording ──");
{
  const g = makeGuard("lab");
  g.writeState({ _equityGuard: { peak: 5000 } });
  await g.updateEquityGuard({}, 4200);
  check("exactly one alert on the latch", g.tgCalls.length === 1, g.tgCalls.length, 1);
  const msg = g.tgCalls[0];
  check('the message STARTS with "تم إيقاف الدخول الجديد"',
    msg.startsWith("تم إيقاف الدخول الجديد"), msg.slice(0, 40), "تم إيقاف الدخول الجديد");
  check("it gives the equity", /\$4200/.test(msg), msg, "$4200");
  check("it gives the peak", /\$5000/.test(msg), msg, "$5000");
  check("it gives the drop percent", /-16%/.test(msg), msg, "-16%");
  check("it says positions were not closed", /لم تُغلق/.test(msg));
  check("it says signal logging continues", /تسجيل الإشارات مستمر/.test(msg));
  check("it says there is no automatic resume", /لا استئناف تلقائي/.test(msg));
  check("it names the resume file", /equity_guard_resume\.json/.test(msg));
  check("alertedAt is stamped after a successful send",
    typeof g.readState()._equityGuard.halt.alertedAt === "string");

  // Subsequent cycles must not re-alert.
  await g.updateEquityGuard(g.loadState(), 4200);
  await g.updateEquityGuard(g.loadState(), 4100);
  check("no further alerts on later cycles", g.tgCalls.length === 1, g.tgCalls.length, 1);

  // A failed send leaves alertedAt null so the next cycle retries.
  const g2 = makeGuard("lab", { tgResult: null });
  g2.writeState({ _equityGuard: { peak: 5000 } });
  await g2.updateEquityGuard({}, 4200);
  check("a failed send leaves alertedAt null", g2.readState()._equityGuard.halt.alertedAt === null,
    g2.readState()._equityGuard.halt.alertedAt, null);
  check("and the attempt was made", g2.tgCalls.length === 1, g2.tgCalls.length, 1);
}

// ── 9) v21 behaves identically ────────────────────────────────────────
console.log("\n── 9) v21 parity ──");
{
  const g = makeGuard("v21");
  g.writeState({});
  let r = await g.updateEquityGuard({}, 5000);
  check("v21 seeds its peak", r.peak === 5000, r.peak, 5000);
  r = await g.updateEquityGuard({}, 4200);
  check("v21 halts at -16%", r.halted === true, r, { halted: true });
  check("v21's alert has the required opening", g.tgCalls[0].startsWith("تم إيقاف الدخول الجديد"));
  check("v21 writes to state_v21.json", fs.existsSync(g.statePath) && g.statePath.endsWith("state_v21.json"),
    g.statePath, "…/state_v21.json");
  // the resume file is shared but entries are bot-scoped
  const h = g.readState()._equityGuard.halt.haltedAt;
  g.writeResume({ resume: [{ bot: "lab", clearHaltedAt: h, resetPeakTo: 4200, expires: "2026-12-31" }] });
  r = await g.updateEquityGuard(g.loadState(), 4200);
  check("a lab entry cannot resume v21", r.halted === true, r, { halted: true });
  g.writeResume({ resume: [{ bot: "v21", clearHaltedAt: h, resetPeakTo: 4200, expires: "2026-12-31" }] });
  r = await g.updateEquityGuard(g.loadState(), 4200);
  check("a v21 entry resumes v21", r.halted === false, r, { halted: false });
  // the two bots' guard bodies must stay in step
  const strip = s => s.replace(/"v21"/g, '"BOT"').replace(/"lab"/g, '"BOT"')
                      .replace(/\[v21 equity\]/g, "[BOT equity]").replace(/\[LAB equity\]/g, "[BOT equity]")
                      .replace(/state_v21\.json/g, "state_BOT.json").replace(/state_lab\.json/g, "state_BOT.json");
  check("updateEquityGuard is identical in both bots modulo the bot name",
    strip(grab(SRC.v21, RE.update, "v21")) === strip(grab(SRC.lab, RE.update, "lab")),
    "they diverge", "identical");
  check("mergeEquityGuard is identical in both bots",
    grab(SRC.v21, RE.merge, "v21") === grab(SRC.lab, RE.merge, "lab"));
  check("amendEquityGuard is identical in both bots",
    grab(SRC.v21, RE.amend, "v21") === grab(SRC.lab, RE.amend, "lab"));
}

// ── 10) the gate: new entries only, never a force-close ───────────────
console.log("\n── 10) the gate stops entries and nothing else ──");
for (const bot of ["v21", "lab"]) {
  const se = grab(SRC[bot], /async function scanEntry\([\s\S]*?\n\}\n/, `scanEntry/${bot}`);
  check(`${bot}: the gate reads dayCtx.equityHalted`, /dayCtx\?\.equityHalted/.test(se));
  check(`${bot}: the gate reads dayCtx.equityUnknown`, /dayCtx\?\.equityUnknown/.test(se));
  check(`${bot}: the gate only ever returns`,
    /equityHalted\) \{[\s\S]{0,400}?\n    return;\n  \}/.test(se), "does more than return", "return only");
  check(`${bot}: the gate never closes a position`,
    !/closePosition/.test(se.slice(se.indexOf("equityHalted"))), "calls closePosition", "never");
  check(`${bot}: scanEntry does not latch or bump (main() owns that)`,
    !/amendEquityGuard|updateEquityGuard/.test(se), "mutates the guard", "read-only");
  check(`${bot}: monitorPosition knows nothing about the guard`,
    !/equityHalted|equityUnknown|_equityGuard/.test(grab(SRC[bot], RE.monitor, `mp/${bot}`)),
    "monitor sees the guard", "clean");
  check(`${bot}: the guard is evaluated once per child in main()`,
    (SRC[bot].match(/await updateEquityGuard\(/g) || []).length === 1,
    (SRC[bot].match(/await updateEquityGuard\(/g) || []).length, 1);
}
check("LAB keeps logging signals while halted",
  /logSignal\(state, snap, "skipped", "equity_drawdown_halt"\)/.test(SRC.lab), "missing", "present");
check("LAB logs the unknown-equity skip too",
  /logSignal\(state, snap, "skipped", "equity_unknown"\)/.test(SRC.lab), "missing", "present");
check("LAB's gate sits after the contract is chosen (snap is complete)",
  SRC.lab.indexOf("snap.cost1") < SRC.lab.indexOf('"equity_drawdown_halt"'), "before snap", "after snap");
check("LAB's gate sits BEFORE the spread fetch (no network call for a refused trade)",
  SRC.lab.indexOf('"equity_drawdown_halt"') < SRC.lab.indexOf("const snapLegs = await snapQuoteLegs"),
  "after the fetch", "before it");
check("v21's gate sits before checkBreakout (cheapest refusal, no shadow log to keep)",
  SRC.v21.indexOf("equityHalted") < SRC.v21.indexOf("const breakout = await checkBreakout"),
  "after checkBreakout", "before it");

// ── 11) scope: pinned regions and the files we must not touch ─────────
console.log(`\n── 11) pinned regions identical to ${BASE_SHA.slice(0, 8)} ──`);
for (const bot of ["v21", "lab"]) {
  const base = showAt(BASE_SHA, FILE[bot]);
  for (const [label, re] of [
    ["alpaca()", RE.alpaca], ["getQuote()", RE.getQuote], ["getOwnedQty()", RE.ownedQty],
    ["calcQty()", RE.calcQty], ["monitorPosition()", RE.monitor],
    ["readDayPeak()", RE.readPk], ["bumpDayPeak()", RE.bumpPk],
    ["DAY CONTEXT block", RE.dayCtx],
  ]) {
    check(`${bot}: ${label} byte-identical`,
      grab(SRC[bot], re, `${label}/${bot}`) === grab(base, re, `${label}/${bot}@base`), "changed", "identical");
  }
}
check("runner.js byte-identical (no STATE_FILES change)",
  lf(fs.readFileSync("runner.js", "utf8")) === showAt(BASE_SHA, "runner.js"), "changed", "identical");
check("equity_guard_resume.json is NOT in STATE_FILES (owner-edited, never container-written)",
  !/equity_guard_resume/.test(lf(fs.readFileSync("runner.js", "utf8"))), "present", "absent");
check("scan_wvad.js byte-identical",
  lf(fs.readFileSync("scan_wvad.js", "utf8")) === showAt(BASE_SHA, "scan_wvad.js"), "changed", "identical");
check("daily_report.js byte-identical",
  lf(fs.readFileSync("daily_report.js", "utf8")) === showAt(BASE_SHA, "daily_report.js"), "changed", "identical");
check("strategy_lab.json byte-identical (no sizing change)",
  lf(fs.readFileSync("strategy_lab.json", "utf8")) === showAt(BASE_SHA, "strategy_lab.json"), "changed", "identical");
for (const bot of ["v21", "lab"]) {
  check(`${bot}: no entry/exit/sizing constant moved`,
    ["TRADE_BUDGET", "MAX_TRADE_BUDGET", "HARD_STOP_PCT", "stopLossPct", "DAILY_LOSS_LIMIT",
     "MAX_DAILY_LOSS", "STOP_DAY_LOSS", "PROFIT_FLOOR", "MAX_DAILY_TRADES", "MAX_OPEN_POSITIONS"]
      .every(k => {
        const re = new RegExp(`^const ${k}\\s*=[^\\n]*$`, "m");
        const a = SRC[bot].match(re), b = showAt(BASE_SHA, FILE[bot]).match(re);
        return (a === null && b === null) || (a && b && a[0] === b[0]);
      }), "a constant moved", "all identical");
}

// ── 12) v21's /account read adds no request ───────────────────────────
console.log("\n── 12) request cost ──");
{
  const base21 = showAt(BASE_SHA, "scan_v21.js");
  const n = s => (s.match(/alpaca\("\/account"\)/g) || []).length;
  check(`v21: still exactly ${n(base21)} alpaca("/account") call(s) — the guard adds none`,
    n(SRC.v21) === n(base21), n(SRC.v21), n(base21));
  check("v21 reads equity off the call it already made",
    /equityNow = parseFloat\(acctInfo\?\.equity\)/.test(SRC.v21), "missing", "present");
  check("v21 keeps portfolio_value for the daily-target logic",
    /portfolio = parseFloat\(acctInfo\.portfolio_value\) \|\| 5000;/.test(SRC.v21), "changed", "unchanged");
  const baseLab = showAt(BASE_SHA, "scan_lab.js");
  check(`lab: adds exactly one alpaca("/account") call (it had ${(baseLab.match(/alpaca\("\/account"\)/g) || []).length})`,
    (SRC.lab.match(/alpaca\("\/account"\)/g) || []).length === 1,
    (SRC.lab.match(/alpaca\("\/account"\)/g) || []).length, 1);
  check("lab's call is in main(), not in scanEntry",
    !/alpaca\("\/account"\)/.test(grab(SRC.lab, /async function scanEntry\([\s\S]*?\n\}\n/, "se")),
    "per ticker", "once per child");
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n════════════════════════════════════════════════════════════");
console.log(` passed ${pass} | failed ${fail}`);
console.log("════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
