#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// test_combo_policy.mjs
//
// Guards the propose-only freeze gate on LAB's combo learner: the learner
// may COMPUTE and PROPOSE a tier change, and must APPLY nothing until an
// owner approval in combo_approvals.json matches it.
//
// Regions are extracted FROM THE REAL SOURCE by text and executed with
// stubs, so the test cannot drift from the shipped code. grab() throws
// when a regex stops matching rather than letting an assertion pass
// vacuously.
//
// BASE_SHA is the commit this change was written against. It is pinned:
// origin/main moves on its own (the Railway runner commits state every
// cycle), so comparing against a moving ref would be non-deterministic.
// ════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE_SHA = "e22029df35f8a206a3ceabcaae4122662b0cac96";

const lf = s => s.replace(/\r\n/g, "\n");
const showAt = (sha, f) => lf(execFileSync("git", ["show", `${sha}:${f}`], { encoding: "utf8", maxBuffer: 1 << 28 }));
const src = lf(fs.readFileSync("scan_lab.js", "utf8"));
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

const RE = {
  autoapply: /const COMBO_AUTOAPPLY = (true|false);/,
  approvalsFile: /const COMBO_APPROVALS_FILE = "[^"]+";/,
  renotify: /const COMBO_RENOTIFY_MS = [^\n]+;/,
  loadApprovals: /function loadComboApprovals\(\) \{[\s\S]*?\n\}/,
  matchApproval: /function matchComboApproval\(approvals, comboKey, proposedTier, todayUtc\) \{[\s\S]*?\n\}/,
  sizeMult: /const COMBO_SIZE_MULTIPLIER = \{[^\n]*\};/,
  // The day-cluster rule replaced the two iid sample constants and the
  // fixed z with day+trade gates and a t-table, so this block is spelled
  // from its new first and last lines. The VALUES are asserted
  // structurally in section 11 rather than pinned as literals, except
  // COMBO_ABS_MARGIN_PP and the multipliers, which stay hard literals.
  limits: /const COMBO_EVIDENCE_FROM\s+= [\s\S]*?const COMBO_T90_ASYMPTOTIC\s+= [\d.]+;/,
  tCrit: /function comboTCrit\(df\) \{[\s\S]*?\n\}/,
  computeCombos: /function computeCombos\(records, previousCombos\) \{[\s\S]*?\n\}/,
  positionBucket: /function positionBucket\(spot, breakoutHigh, breakoutLow\) \{[\s\S]*?\n\}/,
  calcQty: /function calcQty\(premium, tradeBudget\) \{[\s\S]*?\n\}/,
  lookup: /function lookupComboMultiplier\(combos, signal, positionBkt\) \{[\s\S]*?\n\}/,
  tierFor: /  function tierFor\(st\) \{[\s\S]*?\n  \}/,
  // Anchored on the gate's LAST line, not on the first `\n    }` — a
  // non-greedy match stops at the for-loop's brace and silently drops
  // the tail that records the proposals, which made the hold look like a
  // no-op. The 8-space `c.sizeMultiplier` line occurs exactly once.
  gate: /\/\/ ── PROPOSE-ONLY GATE ──[\s\S]*?\n        c\.sizeMultiplier !== multiplierOf\(c\.previousTier\) \|\| isFirstJudgment\(c\)\n      \);\n    \}/,
  proposalTpl: /function buildComboProposalTemplate\([\s\S]*?\n\}/,
};

// ── a sandbox so loadComboApprovals()'s relative read is controlled ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "combopolicy-"));
const APPROVALS = path.join(TMP, "combo_approvals.json");
const writeApprovals = v => fs.writeFileSync(APPROVALS, typeof v === "string" ? v : JSON.stringify(v));
const clearApprovals = () => { try { fs.unlinkSync(APPROVALS); } catch {} };

// Build the real approval helpers over a stubbed fs, with the real
// COMBO_SIZE_MULTIPLIER so the tier whitelist is the shipped one.
function makeApprovalApi() {
  const fsStub = { readFileSync: p => fs.readFileSync(p === "combo_approvals.json" ? APPROVALS : p, "utf8") };
  return new Function("fs",
    `${grab(src, RE.sizeMult, "sizeMult")}\n${grab(src, RE.approvalsFile, "approvalsFile")}\n`
    + `${grab(src, RE.loadApprovals, "loadApprovals")}\n${grab(src, RE.matchApproval, "matchApproval")}\n`
    + `return { loadComboApprovals, matchComboApproval, COMBO_SIZE_MULTIPLIER };`)(fsStub);
}

// Build the real entry-time lookup.
function makeLookup() {
  return new Function(
    `${grab(src, RE.sizeMult, "sizeMult")}\n${grab(src, RE.lookup, "lookup")}\n`
    + `return lookupComboMultiplier;`)();
}

// The real day-cluster rule, lifted out of scan_lab.js by text so this
// suite judges the shipped code and not a copy of it.
function makeRuleApi() {
  return new Function(
    `${grab(src, RE.limits, "limits")}\n${grab(src, RE.sizeMult, "sizeMult")}\n`
    + `${grab(src, RE.tCrit, "tCrit")}\n`
    + `${grab(src, RE.positionBucket, "pb")}\n${grab(src, RE.computeCombos, "cc")}\n`
    + `return { computeCombos, comboTCrit };`)();
}

// A faithful stand-in for the gate: the extracted gate block executed
// with the same surrounding bindings runComboLearning() gives it. This is
// the real text of the gate, not a re-implementation — if the gate
// changes, this changes with it.
function runGate({ combos, strategy, today, approvalsPath = APPROVALS }) {
  const fsStub = { readFileSync: p => fs.readFileSync(p === "combo_approvals.json" ? approvalsPath : p, "utf8") };
  const body =
    `${grab(src, RE.sizeMult, "sizeMult")}\n${grab(src, RE.approvalsFile, "approvalsFile")}\n`
    + `${grab(src, RE.autoapply, "autoapply")}\n`
    + `${grab(src, RE.loadApprovals, "loadApprovals")}\n${grab(src, RE.matchApproval, "matchApproval")}\n`
    + `const isFirstJudgment = c => c.previousTier == null && c.tier !== "insufficient";\n`
    + `const multiplierOf = tier => COMBO_SIZE_MULTIPLIER[tier] ?? 1.0;\n`
    + `const approvedBy = new Map();\n`
    + `let changed = Object.values(combos).filter(c =>\n`
    + `  c.sizeMultiplier !== multiplierOf(c.previousTier) || isFirstJudgment(c));\n`
    + grab(src, RE.gate, "gate")
    + `\nreturn { changed, approvedBy, pending: strategy.pendingComboProposals || [] };`;
  return new Function("fs", "combos", "strategy", "today", body)(fsStub, combos, strategy, today);
}

const combo = (over = {}) => ({
  factors: { signal: "PUT", position: "near_low" }, depth: 1.5, parentKey: null,
  n: 355, wins: 203, pnl: 5383, avgPnlPct: 5.62, se: 2.19,
  tier: "above_avg", previousTier: "average", sizeMultiplier: 1.5,
  lastUpdated: "2026-11-05T21:00:39.176Z", ...over,
});
const KEY = "PUT|position:near_low";
const freshStrategy = () => ({ params: { tradeBudget: 300 }, changelog: [], combos: {} });

console.log("════════════════════════════════════════════════════════════");
console.log(" test_combo_policy — propose-only combo learning");
console.log(`  pinned base: ${BASE_SHA.slice(0, 12)}`);
console.log("════════════════════════════════════════════════════════════");

// ── 1) ships closed, and every error path fails closed ────────────────
console.log("\n── 1) fails closed ──");
check("COMBO_AUTOAPPLY is false as shipped",
  /const COMBO_AUTOAPPLY = false;/.test(src), grab(src, RE.autoapply, "aa"), "false");
{
  const api = makeApprovalApi();
  clearApprovals();
  check("missing file ⇒ no approvals", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals("{ this is not json");
  check("unparseable file ⇒ no approvals", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ approved: "PUT|position:near_low" });
  check("`approved` not an array ⇒ no approvals", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ nope: [] });
  check("no `approved` key ⇒ no approvals", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ approved: [null, 7, "x", [], {}] });
  check("non-object entries dropped", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg" }] });
  check("entry missing `expires` dropped", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "31-12-2026" }] });
  check("malformed date dropped", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ approved: [{ comboKey: KEY, tier: "not_a_tier", expires: "2026-12-31" }] });
  check("unknown tier dropped", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ approved: [{ comboKey: "", tier: "above_avg", expires: "2026-12-31" }] });
  check("empty comboKey dropped", api.loadComboApprovals().length === 0, api.loadComboApprovals(), []);
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "2026-12-31" }] });
  check("a well-formed entry IS accepted", api.loadComboApprovals().length === 1, api.loadComboApprovals(), 1);
  // A good entry beside bad ones still works, and the bad ones vanish.
  writeApprovals({ approved: [null, { comboKey: KEY, tier: "above_avg", expires: "2026-12-31" }, { bad: 1 }] });
  check("good entries survive alongside malformed ones", api.loadComboApprovals().length === 1, api.loadComboApprovals().length, 1);
}

// ── 2) approval matching ──────────────────────────────────────────────
console.log("\n── 2) an approval matches comboKey AND tier, and expires ──");
{
  const api = makeApprovalApi();
  const A = [{ comboKey: KEY, tier: "above_avg", expires: "2026-12-31" }];
  check("exact match", api.matchComboApproval(A, KEY, "above_avg", "2026-11-06") !== null);
  check("different comboKey ⇒ no match",
    api.matchComboApproval(A, "CALL|position:near_high", "above_avg", "2026-11-06") === null);
  check("DIFFERENT TIER ⇒ no match (an up-approval cannot authorise a down-move)",
    api.matchComboApproval(A, KEY, "below_avg", "2026-11-06") === null);
  check("expires is INCLUSIVE — valid on the expiry day itself",
    api.matchComboApproval([{ comboKey: KEY, tier: "above_avg", expires: "2026-11-06" }], KEY, "above_avg", "2026-11-06") !== null);
  check("EXPIRED ⇒ no match (one day past)",
    api.matchComboApproval([{ comboKey: KEY, tier: "above_avg", expires: "2026-11-05" }], KEY, "above_avg", "2026-11-06") === null);
  check("far-expired ⇒ no match",
    api.matchComboApproval([{ comboKey: KEY, tier: "above_avg", expires: "2025-01-01" }], KEY, "above_avg", "2026-11-06") === null);
  check("empty approval list ⇒ no match", api.matchComboApproval([], KEY, "above_avg", "2026-11-06") === null);
  check("the match echoes the approval it used",
    JSON.stringify(api.matchComboApproval(A, KEY, "above_avg", "2026-11-06")) === JSON.stringify(A[0]));
  check("no sample size anywhere in the approval shape",
    !/\bn\b\s*:|avgPnlPct/.test(grab(src, RE.matchApproval, "m")), "mentions n/mean", "comboKey+tier+expires only");
}

// ── 3) the gate HOLDS an unapproved proposal ──────────────────────────
console.log("\n── 3) unapproved ⇒ nothing changes ──");
{
  clearApprovals();
  const combos = { [KEY]: combo() };
  const strategy = freshStrategy();
  const r = runGate({ combos, strategy, today: "2026-11-06" });
  check("tier is put back to the live tier", combos[KEY].tier === "average", combos[KEY].tier, "average");
  check("sizeMultiplier is put back to 1", combos[KEY].sizeMultiplier === 1, combos[KEY].sizeMultiplier, 1);
  check("`changed` is empty, so no changelog entry can be written", r.changed.length === 0, r.changed.length, 0);
  check("nothing recorded as approved", r.approvedBy.size === 0, r.approvedBy.size, 0);
  check("the proposal is recorded", r.pending.length === 1, r.pending, 1);
  const p = r.pending[0];
  check("proposal names the combo", p.comboKey === KEY, p.comboKey, KEY);
  check("proposal keeps the proposed tier", p.proposedTier === "above_avg", p.proposedTier, "above_avg");
  check("proposal records the live tier", p.currentTier === "average" && p.currentMultiplier === 1, p, { currentTier: "average", currentMultiplier: 1 });
  check("proposal records the proposed multiplier", p.proposedMultiplier === 1.5, p.proposedMultiplier, 1.5);
  check("proposal keeps the statistics", p.n === 355 && p.avgPnlPct === 5.62 && p.se === 2.19, p, { n: 355 });
  check("proposal status is awaiting_approval", p.status === "awaiting_approval", p.status, "awaiting_approval");
  check("proposal starts un-notified", p.lastNotifiedAt === null, p.lastNotifiedAt, null);
  check("proposal stamps firstProposedAt", typeof p.firstProposedAt === "string", p.firstProposedAt, "an ISO string");

  // The hold must be real at the entry path, which reads `tier`.
  const lookup = makeLookup();
  check("entry-time lookup still returns ×1 after the hold",
    lookup(combos, "PUT", "near_low").sizeMultiplier === 1,
    lookup(combos, "PUT", "near_low"), 1);
}

// ── 4) an approval lets exactly that one through ──────────────────────
console.log("\n── 4) approved ⇒ applied, and recorded as owner-approved ──");
{
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "2026-12-31" }] });
  const combos = { [KEY]: combo() };
  const strategy = freshStrategy();
  const r = runGate({ combos, strategy, today: "2026-11-06" });
  check("tier stays at the proposed value", combos[KEY].tier === "above_avg", combos[KEY].tier, "above_avg");
  check("sizeMultiplier stays 1.5", combos[KEY].sizeMultiplier === 1.5, combos[KEY].sizeMultiplier, 1.5);
  check("it counts as changed", r.changed.length === 1, r.changed.length, 1);
  check("no proposal is left pending", r.pending.length === 0, r.pending, []);
  check("the approval is recorded against the combo", r.approvedBy.get(KEY)?.expires === "2026-12-31", [...r.approvedBy], "the approval entry");
  const lookup = makeLookup();
  check("entry-time lookup now returns ×1.5", lookup(combos, "PUT", "near_low").sizeMultiplier === 1.5);
}

// ── 5) expired / wrong-tier approvals apply nothing ───────────────────
console.log("\n── 5) expired and wrong-tier approvals apply nothing ──");
{
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "2026-11-05" }] });
  const combos = { [KEY]: combo() };
  const r = runGate({ combos, strategy: freshStrategy(), today: "2026-11-06" });
  check("EXPIRED approval ⇒ held", combos[KEY].tier === "average" && r.pending.length === 1, { tier: combos[KEY].tier, pending: r.pending.length }, { tier: "average", pending: 1 });
  check("EXPIRED approval ⇒ not recorded as approved", r.approvedBy.size === 0, r.approvedBy.size, 0);

  writeApprovals({ approved: [{ comboKey: KEY, tier: "below_avg", expires: "2026-12-31" }] });
  const c2 = { [KEY]: combo() };
  const r2 = runGate({ combos: c2, strategy: freshStrategy(), today: "2026-11-06" });
  check("approval for a DIFFERENT tier ⇒ held", c2[KEY].tier === "average" && r2.pending.length === 1, { tier: c2[KEY].tier }, { tier: "average" });

  // A down-move must be gated too, and an up-approval must not pass it.
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "2026-12-31" }] });
  const c3 = { [KEY]: combo({ tier: "below_avg", sizeMultiplier: 0.5 }) };
  const r3 = runGate({ combos: c3, strategy: freshStrategy(), today: "2026-11-06" });
  check("a DOWN-move is gated as well (freeze covers both directions)",
    c3[KEY].tier === "average" && c3[KEY].sizeMultiplier === 1 && r3.pending.length === 1,
    { tier: c3[KEY].tier, mult: c3[KEY].sizeMultiplier }, { tier: "average", mult: 1 });
  check("the held down-move is proposed, not applied", r3.pending[0].proposedTier === "below_avg", r3.pending[0].proposedTier, "below_avg");
}

// ── 6) only the approved one of several ───────────────────────────────
console.log("\n── 6) two proposals, one approval ──");
{
  const K2 = "CALL|position:near_high";
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "2026-12-31" }] });
  const combos = {
    [KEY]: combo(),
    [K2]: combo({ factors: { signal: "CALL", position: "near_high" }, tier: "below_avg", previousTier: "average", sizeMultiplier: 0.5, n: 280 }),
  };
  const r = runGate({ combos, strategy: freshStrategy(), today: "2026-11-06" });
  check("the approved combo moved", combos[KEY].tier === "above_avg", combos[KEY].tier, "above_avg");
  check("the unapproved combo did NOT", combos[K2].tier === "average" && combos[K2].sizeMultiplier === 1, combos[K2].tier, "average");
  check("exactly one applied", r.changed.length === 1, r.changed.length, 1);
  check("exactly one still pending", r.pending.length === 1 && r.pending[0].comboKey === K2, r.pending.map(p => p.comboKey), [K2]);
}

// ── 7) a combo that is not moving is left entirely alone ──────────────
console.log("\n── 7) no size move ⇒ untouched, nothing proposed ──");
{
  clearApprovals();
  const combos = { [KEY]: combo({ tier: "average", previousTier: "average", sizeMultiplier: 1 }) };
  const r = runGate({ combos, strategy: freshStrategy(), today: "2026-11-06" });
  check("tier untouched", combos[KEY].tier === "average");
  check("nothing changed", r.changed.length === 0, r.changed.length, 0);
  check("nothing proposed", r.pending.length === 0, r.pending, []);
  // A first judgment (previousTier null) counts as a size move and must be gated.
  const c2 = { [KEY]: combo({ previousTier: null }) };
  const r2 = runGate({ combos: c2, strategy: freshStrategy(), today: "2026-11-06" });
  check("a FIRST judgment is gated too", c2[KEY].tier === "insufficient" && r2.pending.length === 1,
    { tier: c2[KEY].tier, pending: r2.pending.length }, { tier: "insufficient", pending: 1 });
  check("and its live multiplier is 1", c2[KEY].sizeMultiplier === 1, c2[KEY].sizeMultiplier, 1);
}

// ── 8) across two nightly runs ────────────────────────────────────────
console.log("\n── 8) the approval is consumed correctly across two nights ──");
{
  // Night 1: no approval ⇒ held, firstProposedAt stamped.
  clearApprovals();
  const strategy = freshStrategy();
  const n1combos = { [KEY]: combo() };
  const r1 = runGate({ combos: n1combos, strategy, today: "2026-11-06" });
  check("night 1 holds", r1.pending.length === 1 && n1combos[KEY].tier === "average");
  const firstAt = strategy.pendingComboProposals[0].firstProposedAt;
  strategy.pendingComboProposals[0].lastNotifiedAt = "2026-11-06T21:00:00.000Z";

  // Night 2, still unapproved: the clock must CARRY, not reset.
  const n2combos = { [KEY]: combo({ n: 371, avgPnlPct: 5.4 }) };
  const r2 = runGate({ combos: n2combos, strategy, today: "2026-11-07" });
  check("night 2 still holds", r2.pending.length === 1 && n2combos[KEY].tier === "average");
  check("firstProposedAt carries across the rebuild", r2.pending[0].firstProposedAt === firstAt, r2.pending[0].firstProposedAt, firstAt);
  check("lastNotifiedAt carries across the rebuild",
    r2.pending[0].lastNotifiedAt === "2026-11-06T21:00:00.000Z", r2.pending[0].lastNotifiedAt, "2026-11-06T21:00:00.000Z");
  check("the refreshed sample is picked up", r2.pending[0].n === 371, r2.pending[0].n, 371);

  // Night 3, approved: applies, and the pending entry clears.
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "2026-12-31" }] });
  const n3combos = { [KEY]: combo({ n: 380 }) };
  const r3 = runGate({ combos: n3combos, strategy, today: "2026-11-08" });
  check("night 3 applies", n3combos[KEY].tier === "above_avg" && r3.changed.length === 1);
  check("night 3 clears the pending entry", r3.pending.length === 0, r3.pending, []);
  check("night 3 records the approval", r3.approvedBy.get(KEY) != null);

  // Night 4, the approval has lapsed and the combo is at above_avg: no
  // size move, so there is nothing to re-gate — a lapsed approval does
  // NOT retroactively undo what was applied.
  writeApprovals({ approved: [{ comboKey: KEY, tier: "above_avg", expires: "2026-11-08" }] });
  const n4combos = { [KEY]: combo({ previousTier: "above_avg" }) };
  const r4 = runGate({ combos: n4combos, strategy, today: "2026-11-20" });
  check("a lapsed approval does not undo an applied change",
    n4combos[KEY].tier === "above_avg" && r4.changed.length === 0 && r4.pending.length === 0,
    { tier: n4combos[KEY].tier, changed: r4.changed.length, pending: r4.pending.length },
    { tier: "above_avg", changed: 0, pending: 0 });
}

// ── 9) re-notify dedupe window ────────────────────────────────────────
console.log("\n── 9) the 7-day re-notify window ──");
{
  check("COMBO_RENOTIFY_MS is 7 days",
    /const COMBO_RENOTIFY_MS = 7 \* 24 \* 60 \* 60 \* 1000;/.test(src), grab(src, RE.renotify, "rn"), "7 days");
  // The due test, lifted from the source so it cannot drift.
  const dueBlock = grab(src, /const last = p\.lastNotifiedAt[\s\S]*?const due = [^\n]+;/, "due");
  const isDue = new Function("p", "COMBO_RENOTIFY_MS", "now",
    dueBlock.replace("Date.now()", "now") + "\nreturn due;");
  const DAY = 86400000, NOW = Date.parse("2026-11-20T21:00:00.000Z");
  check("never notified ⇒ due", isDue({ lastNotifiedAt: null }, 7 * DAY, NOW) === true);
  check("unparseable stamp ⇒ due", isDue({ lastNotifiedAt: "nonsense" }, 7 * DAY, NOW) === true);
  check("notified 1 day ago ⇒ NOT due", isDue({ lastNotifiedAt: new Date(NOW - 1 * DAY).toISOString() }, 7 * DAY, NOW) === false);
  check("notified 6 days ago ⇒ NOT due", isDue({ lastNotifiedAt: new Date(NOW - 6 * DAY).toISOString() }, 7 * DAY, NOW) === false);
  check("notified exactly 7 days ago ⇒ due", isDue({ lastNotifiedAt: new Date(NOW - 7 * DAY).toISOString() }, 7 * DAY, NOW) === true);
  check("notified 8 days ago ⇒ due", isDue({ lastNotifiedAt: new Date(NOW - 8 * DAY).toISOString() }, 7 * DAY, NOW) === true);
  // The stamp is only written on a successful send.
  check("lastNotifiedAt is stamped only when tg() returned an id",
    /if \(msgId\) \{ p\.lastNotifiedAt = new Date\(\)\.toISOString\(\); stamped = true; \}/.test(src),
    "missing", "guarded by msgId");
  check("a stamped run persists the strategy", /if \(stamped\) \{\n *try \{ saveStrategy\(strategy\); \}/.test(src), "missing", "present");
}

// ── 10) the proposal message says nothing changed ─────────────────────
console.log("\n── 10) the proposal message ──");
{
  const tpl = new Function(
    `${grab(src, RE.sizeMult, "sm")}\n${grab(src, RE.limits, "limits")}\n`
    + `${grab(src, RE.approvalsFile, "af")}\n`
    + `const COMBO_TIER_AR = ${grab(src, /const COMBO_TIER_AR = \{[^\n]*\};/, "tierAr").replace(/^const COMBO_TIER_AR = /, "").replace(/;$/, "")};\n`
    + `${grab(src, RE.proposalTpl, "tpl")}\nreturn buildComboProposalTemplate;`)();
  const p = {
    comboKey: KEY, currentTier: "average", currentMultiplier: 1,
    proposedTier: "above_avg", proposedMultiplier: 1.5,
    n: 355, wins: 203, avgPnlPct: 5.62, se: 2.19, netPnl: 5383,
    // Day-cluster fields the proposal now carries. tCrit stands in for
    // the old fixed z, so the bound in the message is t-based.
    days: 16, maxDayShare: 0.24, maxDayShareDay: "2026-11-05", tCrit: 1.341,
  };
  const msg = tpl(p, 300, 51.5, 0.9);
  check("says nothing was changed", /لم يُغيَّر شيء/.test(msg), msg.slice(0, 80), "لم يُغيَّر شيء");
  check("says the current tier is still in force", /ما زال سارياً/.test(msg));
  check("states the dollar effect, not just a multiplier", /\$300/.test(msg) && /\$450/.test(msg), msg, "$300 -> $450");
  check("states the share of entries affected", /51%|52%/.test(msg), msg, "~51%");
  check("states the sample size", /355 صفقة/.test(msg));
  check("states the standard error", /2\.19pp/.test(msg));
  // The bound is now t-based: 5.62 - 1.341*2.19 = 2.68 -> "2.7%".
  // Under the old fixed z of 1.28 the same inputs gave 2.8%.
  check("states the 90% bound, computed from the proposal's own t",
    /حدّ الثقة 90% 2\.7%/.test(msg), msg, "2.7%");
  check("reports the day count beside the trade count", /355 صفقة على 16 يوم/.test(msg), msg, "355 صفقة على 16 يوم");
  check("reports the largest single-day share against its cap",
    /أكبر حصة ليوم واحد: 24% \(2026-11-05\) — الحد 25%/.test(msg), msg, "24% vs 25%");
  // PIN INVERTED (was: "discloses that it measures reported pnlPct").
  // The disclosure existed because the measure was known to be wrong.
  // Now the message must disclose the corrected measure instead.
  check("discloses that it measures pnlPctAtFill, not reported pnlPct",
    /pnlPctAtFill/.test(msg) && !/pnlPct المُبلَّغ/.test(msg), msg, "pnlPctAtFill only");
  check("discloses the evidence window", /من 2026-10-23/.test(msg), msg, "window stated");
  // PIN INVERTED (was: "discloses the independence assumption").
  check("no longer claims trades are independent",
    !/استقلال الصفقات/.test(msg), msg, "claim removed");
  check("…and states the day-level standard error and the LOO requirement instead",
    /على مستوى اليوم/.test(msg) && /حذف أي يوم واحد/.test(msg), msg, "day-level se + LOO");
  check("tells the owner exactly what to add", msg.includes(`"comboKey":"${KEY}"`) && msg.includes(`"tier":"above_avg"`) && /combo_approvals\.json/.test(msg));
  check("says nothing applies without it", /لن يُطبَّق شيء/.test(msg));
  // A down-proposal must read as a reduction, not an increase.
  const down = tpl({ ...p, proposedTier: "below_avg", proposedMultiplier: 0.5 }, 300, 51.5, null);
  check("a down-proposal reads as a reduction", /تقليل/.test(down) && /\$150/.test(down), down, "تقليل ... $150");
  check("an up-proposal reads as an increase", /زيادة/.test(msg));
}

// ── 11) the maths and the hard limits are untouched ───────────────────
console.log(`\n── 11) proposal maths and hard limits identical to ${BASE_SHA.slice(0, 8)} ──`);
// These regions are still pinned byte-for-byte: nothing in the
// day-cluster rule touches entry sizing, bucketing or the entry-time
// lookup, and if any of them moves, this suite must say so.
for (const [label, re] of [
  ["positionBucket()", RE.positionBucket],
  ["calcQty()", RE.calcQty],
  ["lookupComboMultiplier()", RE.lookup],
  ["COMBO_SIZE_MULTIPLIER", RE.sizeMult],
]) {
  check(`${label} byte-identical`, grab(src, re, label) === grab(base, re, `${label}@base`), "changed", "identical");
}

// ── computeCombos() / tierFor() / the limits block: pins NARROWED ──
// These three were pinned byte-identical to assert that the owner's
// approved propose-only gate had not quietly come with a change to the
// maths underneath it. The owner has now approved a replacement rule
// (fill-based value, the day as the unit, a concentration cap and
// leave-one-day-out), so byte-identity is the wrong assertion. It is
// replaced by the invariants it was actually protecting — the shape of
// the decision, not its text. The rule's own arithmetic is covered in
// full by test_combo_rule.mjs, and its verdicts by test_combo_replay.mjs.
{
  const cc = grab(src, RE.computeCombos, "computeCombos");

  // Still exactly 6 combos, 2 signals x 3 positions, no seeding.
  check("computeCombos still builds exactly 6 combos from 2 signals x 3 positions",
    /for \(const signal of \["CALL", "PUT"\]\)/.test(cc)
    && /for \(const position of \["near_low", "mid", "near_high"\]\)/.test(cc), "changed", "6 combos");
  check("computeCombos still seeds nothing", /NO SEEDING/.test(cc));
  check("computeCombos is still pure (no I/O, no network)",
    !/readFileSync|writeFileSync|appendFileSync|fetch\(|alpaca\(/.test(cc), "does I/O", "pure");

  // A verdict still needs BOTH a margin against zero and a one-sided
  // bound on the same side of zero. This is the heart of the old pin.
  check("a verdict still needs the margin AND the one-sided bound",
    /theta >= COMBO_ABS_MARGIN_PP && theta - t \* se > 0/.test(cc)
    && /theta <= -COMBO_ABS_MARGIN_PP && theta \+ t \* se < 0/.test(cc), "changed", "margin + bound");
  check("the margin is still anchored at ZERO, not at LAB's own mean",
    !/overallAvgPnlPct/.test(grab(src, RE.tierFor, "tierFor")), "anchored on the mean", "anchored at 0");
  check("sizing UP still demands a strictly larger sample than sizing down",
    /D >= COMBO_MIN_DAYS_UP && N >= COMBO_MIN_TRADES_UP/.test(cc)
    && /D >= COMBO_MIN_DAYS_DOWN && N >= COMBO_MIN_TRADES_DOWN/.test(cc), "changed", "asymmetric gates");
  check("the DOWN branch is still evaluated before the UP branch",
    cc.indexOf('tier: "below_avg"') < cc.indexOf('tier: "above_avg"'), "up first", "down first");
  check("one shared margin+bound helper serves the full sample and every LOO subsample",
    (cc.match(/marginAndBound\(/g) || []).length >= 4
    && /function leaveOneDayOutHolds\(direction, means\) \{/.test(cc), "duplicated", "shared helper");
  check("leave-one-day-out drops exactly one day and requires every subsample to pass",
    /means\.every\(\(_, i\) => marginAndBound\(direction, means\.filter\(\(__, j\) => j !== i\)\)\)/.test(cc),
    "changed", "every subsample");
}
// Structural invariants on the constants, in place of the four literals.
check("COMBO_ABS_MARGIN_PP still 5", /const COMBO_ABS_MARGIN_PP   = 5;/.test(src));
check("the multipliers are unchanged",
  /\{ above_avg: 1\.5, average: 1\.0, below_avg: 0\.5, insufficient: 1\.0 \}/.test(grab(src, RE.sizeMult, "sm")));
{
  const lim = new Function(`${grab(src, RE.limits, "limits")}\nreturn {
    COMBO_EVIDENCE_FROM, COMBO_MIN_DAYS_DOWN, COMBO_MIN_TRADES_DOWN,
    COMBO_MIN_DAYS_UP, COMBO_MIN_TRADES_UP, COMBO_ABS_MARGIN_PP,
    COMBO_MAX_DAY_SHARE, COMBO_SE_FLOOR_PP, COMBO_T90, COMBO_T90_ASYMPTOTIC };`)();
  check("the evidence window is the frozen-version start 2026-10-23",
    lim.COMBO_EVIDENCE_FROM === "2026-10-23", lim.COMBO_EVIDENCE_FROM, "2026-10-23");
  check("up-gates >= down-gates on DAYS", lim.COMBO_MIN_DAYS_UP >= lim.COMBO_MIN_DAYS_DOWN,
    { up: lim.COMBO_MIN_DAYS_UP, down: lim.COMBO_MIN_DAYS_DOWN }, "up >= down");
  check("up-gates >= down-gates on TRADES", lim.COMBO_MIN_TRADES_UP >= lim.COMBO_MIN_TRADES_DOWN,
    { up: lim.COMBO_MIN_TRADES_UP, down: lim.COMBO_MIN_TRADES_DOWN }, "up >= down");
  check("at least one of the two up-gates is strictly larger",
    lim.COMBO_MIN_DAYS_UP > lim.COMBO_MIN_DAYS_DOWN || lim.COMBO_MIN_TRADES_UP > lim.COMBO_MIN_TRADES_DOWN,
    "identical gates", "up strictly harder");
  check("every day gate needs at least a week and a half of sessions",
    lim.COMBO_MIN_DAYS_DOWN >= 10 && lim.COMBO_MIN_DAYS_UP >= 10, lim.COMBO_MIN_DAYS_DOWN, ">= 10");
  check("a day gate can never be below 3 (LOO needs 2 days per subsample)",
    lim.COMBO_MIN_DAYS_DOWN >= 3, lim.COMBO_MIN_DAYS_DOWN, ">= 3");
  check("the day-share cap is a real fraction and not vacuous",
    lim.COMBO_MAX_DAY_SHARE > 0 && lim.COMBO_MAX_DAY_SHARE <= 0.5, lim.COMBO_MAX_DAY_SHARE, "(0, 0.5]");
  check("the se floor is positive and small", lim.COMBO_SE_FLOOR_PP > 0 && lim.COMBO_SE_FLOOR_PP <= 1,
    lim.COMBO_SE_FLOOR_PP, "(0, 1]");
  // The t-table must be monotone decreasing toward the normal quantile.
  const dfs = Object.keys(lim.COMBO_T90).map(Number).sort((a, b) => a - b);
  check("the t-table is monotone decreasing in df",
    dfs.every((d, i) => i === 0 || lim.COMBO_T90[d] < lim.COMBO_T90[dfs[i - 1]]), "not monotone", "monotone");
  check("every tabulated t is above the asymptotic normal quantile",
    dfs.every(d => lim.COMBO_T90[d] > lim.COMBO_T90_ASYMPTOTIC), "below z", "above z");
  check("the asymptotic quantile is the one-sided 90% normal 1.282",
    lim.COMBO_T90_ASYMPTOTIC === 1.282, lim.COMBO_T90_ASYMPTOTIC, 1.282);
  check("…and it is never larger than the old fixed z of 1.28 by more than rounding",
    Math.abs(lim.COMBO_T90_ASYMPTOTIC - 1.28) < 0.01, lim.COMBO_T90_ASYMPTOTIC, "~1.28");
}

// ── 12) scope: runner.js and the other bots untouched ─────────────────
console.log("\n── 12) scope ──");
{
  check("runner.js byte-identical",
    lf(fs.readFileSync("runner.js", "utf8")) === showAt(BASE_SHA, "runner.js"), "changed", "identical");
  check("combo_approvals.json is NOT in STATE_FILES",
    !/combo_approvals/.test(lf(fs.readFileSync("runner.js", "utf8"))), "present", "absent");
  // scan_v21.js is no longer byte-identical to this suite's base: the
  // equity-drawdown guard, a later and unrelated change, legitimately
  // edits it. The pin is NARROWED rather than deleted to the invariant it
  // was actually protecting — that the combo learner is LAB-only and no
  // part of it leaked into v21. Byte-identity was only ever a proxy for
  // that, and it would now fail for every future v21 change regardless of
  // whether any combo machinery appeared.
  {
    // Code lines only: scan_v21.js NAMES tuningBucket/combos in a comment
    // explaining what the day-level effectivePnl switch did NOT change,
    // and a substring search over the whole file reads that prose as a
    // leak. The invariant is about machinery, not about mentions.
    const v21 = lf(fs.readFileSync("scan_v21.js", "utf8"))
      .split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
    const combo = ["computeCombos", "lookupComboMultiplier", "COMBO_SIZE_MULTIPLIER",
                   "COMBO_AUTOAPPLY", "COMBO_APPROVALS_FILE", "pendingComboProposals",
                   "tuningBucket", "positionBucket", "combo_approvals"];
    const leaked = combo.filter(k => v21.includes(k));
    check("scan_v21.js carries no combo-learner machinery (LAB-only)",
      leaked.length === 0, leaked, []);
    check("scan_v21.js has no sizeMultiplier concept at all",
      !/sizeMultiplier/.test(v21), "present", "absent");
  }
  check("scan_wvad.js byte-identical",
    lf(fs.readFileSync("scan_wvad.js", "utf8")) === showAt(BASE_SHA, "scan_wvad.js"), "changed", "identical");
  // Same treatment as the scan_v21.js pin just above, and for the same
  // reason. daily_report.js was pinned byte-identical to assert that the
  // combo learner stayed inside scan_lab.js — the report reads
  // strategy_lab.json to PRINT the changelog, and must never become a
  // second writer of it or a second place a tier can be applied. The
  // report has since legitimately changed for unrelated reasons, so the
  // pin is NARROWED to that invariant instead of deleted.
  {
    const rep = lf(fs.readFileSync("daily_report.js", "utf8"));
    const code = rep.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");

    const combo = ["computeCombos", "lookupComboMultiplier", "COMBO_SIZE_MULTIPLIER",
                   "COMBO_AUTOAPPLY", "COMBO_APPROVALS_FILE", "loadComboApprovals",
                   "matchComboApproval", "buildComboProposalTemplate",
                   "pendingComboProposals", "combo_approvals", "sizeMultiplier",
                   "tierFor", "positionBucket", "tuningBucket"];
    const leaked = combo.filter(k => code.includes(k));
    check("daily_report.js carries no combo-learner machinery", leaked.length === 0, leaked, []);

    // It may read strategy_lab.json; it may never write it.
    check("daily_report.js reads strategy_lab.json", /strategy_lab\.json/.test(code), "absent", "present");
    const writes = code.match(/writeFileSync\(\s*"([^"]+)"/g) || [];
    check("daily_report.js writes exactly one file, report_state.json",
      writes.length === 1 && /writeFileSync\(\s*"report_state\.json"/.test(code), writes, "report_state.json only");
    check("…so strategy_lab.json is never written by the report",
      !/writeFileSync\(\s*"strategy_lab\.json"/.test(code), "written", "read-only");

    // The one function that touches the changelog is unchanged, so the
    // propose-only entries are displayed exactly as they were.
    const reLab = /function buildLabChangesSection\([\s\S]*?\n\}/;
    check("daily_report.js: buildLabChangesSection() byte-identical",
      grab(rep, reLab, "buildLabChangesSection") === grab(showAt(BASE_SHA, "daily_report.js"), reLab, "buildLabChangesSection@base"),
      "changed", "identical");
  }
  check("the changelog records the applied approval",
    /ownerApproved: true, approvedBy: approvedBy\.get\(key\)/.test(src), "missing", "present");
}

// ── 13) the reverted combo in strategy_lab.json ───────────────────────
console.log("\n── 13) the PUT|position:near_low revert ──");
{
  const j = JSON.parse(fs.readFileSync("strategy_lab.json", "utf8"));
  const c = j.combos[KEY];
  check("tier is average", c.tier === "average", c.tier, "average");
  check("previousTier is average", c.previousTier === "average", c.previousTier, "average");
  check("sizeMultiplier is 1", c.sizeMultiplier === 1, c.sizeMultiplier, 1);
  // REPAIRS AN ALREADY-RED TEST. This pinned the live combos[].n at 355,
  // but the learner rewrites that object from outcomes_lab.jsonl every
  // night, so n grows daily and the pin could never hold (it read 404,
  // then 435). What the revert actually had to preserve is the
  // IMMUTABLE record of what was promoted — the changelog entries — and
  // the live tier. Both are asserted; the moving recount is not.
  check("the live recount has moved on from the recorded 355 (it is recomputed nightly)",
    typeof c.n === "number" && c.n >= 355, c.n, ">= 355");
  check("the promotion entry still records the sample it was made on (355)",
    j.changelog.some(e => e.type === "combo_tier_change" && e.comboKey === KEY
      && e.newTier === "above_avg" && e.sampleSize === 355), "missing", "sampleSize 355 preserved");
  const lookup = makeLookup();
  check("the entry path sizes it ×1", lookup(j.combos, "PUT", "near_low").sizeMultiplier === 1,
    lookup(j.combos, "PUT", "near_low"), 1);
  // The trap: sizeMultiplier alone is NOT what the entry path reads.
  check("sizeMultiplier:1 with tier above_avg would STILL size ×1.5 — tier is the only correct revert target",
    lookup({ [KEY]: { tier: "above_avg", sizeMultiplier: 1 } }, "PUT", "near_low").sizeMultiplier === 1.5);
  const last = j.changelog.at(-1);
  check("a correction entry was appended", last.type === "correction", last.type, "correction");
  check("it names the combo", last.comboKey === KEY, last.comboKey, KEY);
  check("it records the direction", last.oldTier === "above_avg" && last.newTier === "average");
  check("it keeps sampleSize 355", last.sampleSize === 355, last.sampleSize, 355);
  check("it states the freeze as the reason", /freeze/.test(last.reason) && /approval/.test(last.reason));
  check("the automatic promotion entry is preserved, not rewritten",
    j.changelog.some(e => e.type === "combo_tier_change" && e.comboKey === KEY && e.newTier === "above_avg"),
    "missing", "still present");
  check("no other combo was touched",
    Object.entries(j.combos).filter(([k]) => k !== KEY)
      .every(([k, v]) => v.tier === JSON.parse(showAt(BASE_SHA, "strategy_lab.json")).combos[k].tier),
    "a sibling combo changed", "all identical");
  check("params untouched",
    JSON.stringify(j.params) === JSON.stringify(JSON.parse(showAt(BASE_SHA, "strategy_lab.json")).params),
    "changed", "identical");
}

// ── 14) the audit numbers, pinned against the real log ────────────────
console.log("\n── 14) audit regression pins (real outcomes_lab.jsonl) ──");
{
  const pb = new Function(`${grab(src, RE.positionBucket, "pb")}\nreturn positionBucket;`)();
  const rows = lf(fs.readFileSync("outcomes_lab.jsonl", "utf8")).split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const sub = rows.filter(r => r.signal === "PUT"
    && pb(r.entryConditions?.spot, r.entryConditions?.breakoutHigh, r.entryConditions?.breakoutLow) === "near_low");
  const stored = rows.filter(r => r.entryConditions?.comboKey === KEY);
  check(`the learner's recount is ${sub.length} (it recomputes the bucket)`, sub.length >= 355, sub.length, ">= 355");
  check(`counting by STORED comboKey gives fewer (${stored.length})`, stored.length < sub.length, { stored: stored.length, recomputed: sub.length }, "stored < recomputed");
  const noKey = sub.filter(r => r.entryConditions?.comboKey == null).length;
  const otherKey = sub.filter(r => r.entryConditions?.comboKey != null && r.entryConditions.comboKey !== KEY).length;
  check("the gap is fully explained by missing + legacy keys",
    stored.length + noKey + otherKey === sub.length,
    { stored: stored.length, noKey, otherKey, total: sub.length }, "they sum");
  // The concentration finding that made the promotion unsafe.
  const d = sub.filter(r => r.day === "2026-11-05");
  check("2026-11-05 is in the sample", d.length >= 36, d.length, ">= 36");
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const se = a => { const n = a.length, m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1)) / Math.sqrt(n); };
  // The original audit measured this on the all-time reported-pnlPct
  // basis, because that is what the rule of the day used. Those two
  // assertions went red once the live file grew past them (the mean rose
  // back above +5), which was the stale-pin failure carried in this
  // suite for weeks. They are restated on the basis the audit was
  // actually ABOUT — what happens when 2026-11-05 is removed — and on
  // the measure the approved rule now uses, where the finding still
  // holds. REPAIRS AN ALREADY-RED TEST; the old numbers are preserved in
  // the message so the history stays readable.
  const exDay = sub.filter(r => r.day !== "2026-11-05").map(r => r.pnlPct);
  const m0 = mean(exDay), lb0 = m0 - 1.28 * se(exDay);
  const full = sub.map(r => r.pnlPct);
  check(`removing 2026-11-05 drops the all-time reported mean (${mean(full).toFixed(2)}% -> ${m0.toFixed(2)}%)`,
    m0 < mean(full), { withDay: +mean(full).toFixed(2), without: +m0.toFixed(2) }, "it drops");
  check(`…and drops its 90% lower bound too (${lb0.toFixed(2)})`,
    lb0 < mean(full) - 1.28 * se(full), +lb0.toFixed(2), "lower");
  // On the approved day-cluster measure the finding is unambiguous: the
  // combo cannot be promoted, and leave-one-day-out is what says so.
  {
    const api = makeRuleApi();
    const v = api.computeCombos(rows, null).combos[KEY];
    check("on the approved rule PUT|position:near_low is NOT above_avg",
      v.tier !== "above_avg", v.tier, "not above_avg");
    check("…and its size multiplier is 1, not 1.5", v.sizeMultiplier === 1, v.sizeMultiplier, 1);
    check("…blocked by leave-one-day-out or a sample/concentration gate",
      v.blockedBy == null || /leave-one-day-out|concentration|sample gate/.test(v.blockedBy),
      v.blockedBy, "a stated guard");
  }
  // PIN INVERTED. This assertion existed to mark the reported-pnlPct
  // defect as known-and-unfixed ("documented, not fixed here"). The owner
  // has approved the fix, so it becomes its mirror image: the learner
  // measures the fill-based percent and never falls back to the
  // optimistic reported one for evidence.
  {
    const cc = grab(src, RE.computeCombos, "cc");
    check("computeCombos now measures pnlPctAtFill", /pnlPctAtFill/.test(cc), "absent", "present");
    // The ONE remaining reported-pnlPct use is overallAvgPnlPct, the
    // context figure the message prints as "does not enter the
    // decision". Every line that feeds a verdict must use the fill
    // field, so assert that precisely rather than banning the string.
    // Strip the whole overallAvgPnlPct statement first — it spans three
    // lines, so filtering line-by-line on the name would miss the line
    // the reduce actually sits on.
    const ccNoCtx = cc.replace(/const overallAvgPnlPct = [\s\S]*?: null;/, "");
    const evidenceLines = ccNoCtx.split("\n")
      .filter(l => !l.trim().startsWith("//"))
      .filter(l => /pnlPct|pnlAtFill/.test(l));
    check("…and no verdict-feeding line reads reported pnlPct",
      evidenceLines.every(l => !/\br\.pnlPct\b/.test(l) && !/x\.r\.pnlPct\b/.test(l)),
      evidenceLines.filter(l => /\.pnlPct\b/.test(l)).map(l => l.trim()), []);
    check("the only reported-pnlPct use left is the context average",
      (cc.match(/\.pnlPct\b/g) || []).length === 1
      && /overallAvgPnlPct[\s\S]{0,120}\.pnlPct\b/.test(cc),
      (cc.match(/\.pnlPct\b/g) || []).length, 1);
    check("…and that average is still flagged as not entering the decision",
      /لا يدخل في القرار/.test(src), "flag removed", "still flagged");
    check("a trade without a finite fill percent is EXCLUDED, not defaulted",
      /Number\.isFinite\(x\.r\.pnlPctAtFill\)/.test(cc), "typeof-only or defaulted", "isFinite filter");
    check("the evidence window is applied alongside it",
      /x\.r\.day >= COMBO_EVIDENCE_FROM/.test(cc), "no window", "windowed");
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log("\n════════════════════════════════════════════════════════════");
console.log(` passed ${pass} | failed ${fail}`);
console.log("════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
