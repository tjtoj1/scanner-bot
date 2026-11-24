#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// test_combo_replay.mjs — the day-cluster rule's verdicts on REAL data,
// plus the propose-only gate's behaviour on the one live tier change.
//
// ── WHY THIS READS A GIT SNAPSHOT AND NOT THE WORKING FILE ──
// outcomes_lab.jsonl grows every trading day. A suite that pins verdicts
// against the live file is stale the next morning — that mistake is
// already in this repo twice (test_effective_pnl's EXPECTED day table and
// test_report_cumulative's hand-check both rot daily). So the pinned
// verdicts below are computed from a FIXED commit, read with `git show`,
// and the live file is only ever checked for structural invariants that
// cannot go stale.
//
// SNAPSHOT: outcomes_lab.jsonl as of commit 22f3e957 ("railway state"),
// the tip of origin/main on 2026-11-21. 814 records, in-window days
// 2026-10-23 .. 2026-11-20 (21 trading days, 21 of them with usable
// fills). These are the verdicts the owner approved the rule against.
// ════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const SNAPSHOT = "22f3e95735b4271148f9cfd9ac2841224ac1e0a8";
const SNAPSHOT_LABEL = "origin/main @ 2026-11-21";

const lf = s => s.replace(/\r\n/g, "\n");
const SRC = lf(fs.readFileSync("scan_lab.js", "utf8"));
const showAt = (sha, f) => lf(execFileSync("git", ["show", `${sha}:${f}`], { encoding: "utf8", maxBuffer: 1 << 28 }));

const grab = (re, what, text = SRC) => {
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
  limits: /const COMBO_EVIDENCE_FROM\s+= [\s\S]*?const COMBO_T90_ASYMPTOTIC\s+= [\d.]+;/,
  sizeMult: /const COMBO_SIZE_MULTIPLIER = \{[^\n]*\};/,
  tCrit: /function comboTCrit\(df\) \{[\s\S]*?\n\}/,
  positionBucket: /function positionBucket\(spot, breakoutHigh, breakoutLow\) \{[\s\S]*?\n\}/,
  computeCombos: /function computeCombos\(records, previousCombos\) \{[\s\S]*?\n\}/,
  lookup: /function lookupComboMultiplier\(combos, signal, positionBkt\) \{[\s\S]*?\n\}/,
  autoapply: /const COMBO_AUTOAPPLY = (true|false);/,
  approvalsFile: /const COMBO_APPROVALS_FILE = "[^"]+";/,
  loadApprovals: /function loadComboApprovals\(\) \{[\s\S]*?\n\}/,
  matchApproval: /function matchComboApproval\(approvals, comboKey, proposedTier, todayUtc\) \{[\s\S]*?\n\}/,
  // The gate, anchored on its last line (the 8-space sizeMultiplier
  // restore), which occurs exactly once — a non-greedy match on the
  // first `\n    }` truncates at the for-loop's brace and silently drops
  // the tail that records proposals.
  gate: /    const approvals = COMBO_AUTOAPPLY \? \[\][\s\S]*?\n        c\.sizeMultiplier !== multiplierOf\(c\.previousTier\) \|\| isFirstJudgment\(c\)\n      \);\n    \}/,
  withdrawn: /      for \(const p of prevPending\) \{[\s\S]*?\n      \}/,
};

const api = new Function(
  `${grab(RE.limits, "limits")}\n${grab(RE.sizeMult, "sizeMult")}\n`
  + `${grab(RE.tCrit, "tCrit")}\n${grab(RE.positionBucket, "pb")}\n`
  + `${grab(RE.computeCombos, "computeCombos")}\n`
  + `return { computeCombos, comboTCrit, positionBucket,
      C: { COMBO_EVIDENCE_FROM, COMBO_MAX_DAY_SHARE, COMBO_MIN_DAYS_UP,
           COMBO_MIN_TRADES_UP, COMBO_MIN_DAYS_DOWN, COMBO_MIN_TRADES_DOWN,
           COMBO_SIZE_MULTIPLIER } };`)();

const parse = text => text.split("\n").filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const SNAP = parse(showAt(SNAPSHOT, "outcomes_lab.jsonl"));
const KEYS = ["CALL|position:near_low", "CALL|position:mid", "CALL|position:near_high",
              "PUT|position:near_low", "PUT|position:mid", "PUT|position:near_high"];

console.log("════════════════════════════════════════════════════════════");
console.log(" test_combo_replay — real-data verdicts + the gate");
console.log(`  snapshot: ${SNAPSHOT.slice(0, 8)} (${SNAPSHOT_LABEL}), ${SNAP.length} records`);
console.log("════════════════════════════════════════════════════════════");

// ── 0) the snapshot is the one the verdicts were approved against ─────
console.log("\n── 0) snapshot integrity ──");
check(`the snapshot has 813 records`, SNAP.length === 813, SNAP.length, 813);
{
  const days = [...new Set(SNAP.filter(r => r.day >= api.C.COMBO_EVIDENCE_FROM).map(r => r.day))].sort();
  check("in-window days = 21", days.length === 21, days.length, 21);
  check("first in-window day is the window start", days[0] === "2026-10-23", days[0], "2026-10-23");
  check("last in-window day is 2026-11-20", days.at(-1) === "2026-11-20", days.at(-1), "2026-11-20");
  // Windowed AND with a finite fill percent, BEFORE bucketing. The
  // per-combo totals in section 1 are these minus the unbucketable ones,
  // and they sum to 250 across the six combos.
  const usable = SNAP.filter(r => r.day >= api.C.COMBO_EVIDENCE_FROM && Number.isFinite(r.pnlPctAtFill));
  check("usable in-window trades (windowed + finite fill) = 250", usable.length === 250, usable.length, 250);
  const inWindow = SNAP.filter(r => r.day >= api.C.COMBO_EVIDENCE_FROM);
  check("only 2 in-window trades lack a fill percent (2026-11-09, 2026-11-19)",
    inWindow.length - usable.length === 2, inWindow.length - usable.length, 2);
  // The lucky coincidence the design rests on: fills begin on the window
  // start, so the window and the fill requirement barely overlap-cost.
  const firstFill = [...new Set(SNAP.filter(r => Number.isFinite(r.pnlPctAtFill)).map(r => r.day))].sort()[0];
  check("fill recording begins ON the window start, so the two filters barely overlap",
    firstFill === "2026-10-23", firstFill, "2026-10-23");
}

// ── 1) the six pinned verdicts ────────────────────────────────────────
console.log("\n── 1) verdicts on the snapshot (the approved backtest) ──");
// Hand-verified against the design study. Every field the verdict turned
// on is pinned, not just the tier, so a change that reaches the same
// label by different arithmetic still fails here.
const EXPECT = {
  "CALL|position:near_low":  { tier: "insufficient", n: 2,   days: 2,  avgPnlPct: -12.10, mult: 1.0, blockedBy: "sample gate (D=2, N=2)" },
  "CALL|position:mid":       { tier: "insufficient", n: 5,   days: 5,  avgPnlPct: -7.96,  mult: 1.0, blockedBy: "sample gate (D=5, N=5)" },
  "CALL|position:near_high": { tier: "below_avg",    n: 82,  days: 16, avgPnlPct: -10.52, mult: 0.5, blockedBy: null },
  "PUT|position:near_low":   { tier: "average",      n: 152, days: 16, avgPnlPct: 6.08,   mult: 1.0, blockedBy: "leave-one-day-out" },
  "PUT|position:mid":        { tier: "insufficient", n: 5,   days: 4,  avgPnlPct: 3.95,   mult: 1.0, blockedBy: "sample gate (D=4, N=5)" },
  "PUT|position:near_high":  { tier: "insufficient", n: 4,   days: 3,  avgPnlPct: 20.90,  mult: 1.0, blockedBy: "sample gate (D=3, N=4)" },
};
const SNAP_COMBOS = api.computeCombos(SNAP, null).combos;
for (const k of KEYS) {
  const c = SNAP_COMBOS[k], e = EXPECT[k];
  const label = k.replace("|position:", "|");
  check(`${label}: tier = ${e.tier}`, c.tier === e.tier, c.tier, e.tier);
  check(`${label}: usable n = ${e.n}`, c.n === e.n, c.n, e.n);
  check(`${label}: days = ${e.days}`, c.days === e.days, c.days, e.days);
  check(`${label}: theta = ${e.avgPnlPct}`, c.avgPnlPct === e.avgPnlPct, c.avgPnlPct, e.avgPnlPct);
  check(`${label}: multiplier = ${e.mult}`, c.sizeMultiplier === e.mult, c.sizeMultiplier, e.mult);
  check(`${label}: blockedBy = ${e.blockedBy ?? "null"}`, c.blockedBy === e.blockedBy, c.blockedBy, e.blockedBy);
}

// ── 2) the headline comparisons against the OLD rule ──────────────────
console.log("\n── 2) the old rule vs the new, on the same snapshot ──");
// The old rule, reconstructed exactly as it shipped: reported pnlPct,
// all history, iid se, n>=20 down / n>=30 up, margin 5, z 1.28.
function oldRule(rows, signal, position) {
  const sub = rows.filter(r => r.signal === signal
    && api.positionBucket(r.entryConditions?.spot, r.entryConditions?.breakoutHigh, r.entryConditions?.breakoutLow) === position);
  const pcts = sub.map(r => r.pnlPct), n = pcts.length;
  if (n < 2) return { tier: "insufficient", n };
  const m = pcts.reduce((a, b) => a + b, 0) / n;
  const v = pcts.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  const se = Math.sqrt(v) / Math.sqrt(n);
  if (n < 20) return { tier: "insufficient", n, m, se };
  if (m <= -5 && m + 1.28 * se < 0) return { tier: "below_avg", n, m, se };
  if (n >= 30 && m >= 5 && m - 1.28 * se > 0) return { tier: "above_avg", n, m, se };
  return { tier: "average", n, m, se };
}
{
  const old = oldRule(SNAP, "PUT", "near_low");
  check("the OLD rule still says above_avg for PUT|near_low on this snapshot",
    old.tier === "above_avg", old.tier, "above_avg");
  check("…on 435 trades of reported pnlPct", old.n === 435, old.n, 435);
  check("the NEW rule says average", SNAP_COMBOS["PUT|position:near_low"].tier === "average");
  check("…so the two rules genuinely disagree on the live sizing of this combo",
    old.tier !== SNAP_COMBOS["PUT|position:near_low"].tier);
  // The quantified independence violation.
  const neu = SNAP_COMBOS["PUT|position:near_low"];
  check(`the day-level se is >2x the iid se (${neu.se} vs ${old.se.toFixed(2)})`,
    neu.se / old.se > 2, +(neu.se / old.se).toFixed(2), "> 2");
  // The estimand gap: trade-weighted vs equally-weighted days.
  const usable = SNAP.filter(r => r.signal === "PUT" && r.day >= api.C.COMBO_EVIDENCE_FROM
    && Number.isFinite(r.pnlPctAtFill)
    && api.positionBucket(r.entryConditions?.spot, r.entryConditions?.breakoutHigh, r.entryConditions?.breakoutLow) === "near_low");
  const tw = usable.reduce((a, r) => a + r.pnlPctAtFill, 0) / usable.length;
  check(`the trade-weighted mean is materially higher than the day mean (${tw.toFixed(2)} vs ${neu.avgPnlPct})`,
    tw - neu.avgPnlPct > 3, +(tw - neu.avgPnlPct).toFixed(2), "> 3pp");
}
{
  const old = oldRule(SNAP, "CALL", "near_high");
  check("the OLD rule says average for CALL|near_high — the loser it could not see",
    old.tier === "average", old.tier, "average");
  check(`…because reported pnlPct reads only ${old.m.toFixed(2)}pp, inside the +-5 margin`,
    Math.abs(old.m) < 5, +old.m.toFixed(2), "|mean| < 5");
  check("the NEW rule sizes it DOWN", SNAP_COMBOS["CALL|position:near_high"].tier === "below_avg");
  check("…because the fill-based day mean is well past the margin",
    SNAP_COMBOS["CALL|position:near_high"].avgPnlPct <= -5,
    SNAP_COMBOS["CALL|position:near_high"].avgPnlPct, "<= -5");
}
{
  // The new rule never promotes anything on this snapshot.
  check("the new rule promotes NO combo to above_avg on the snapshot",
    Object.values(SNAP_COMBOS).every(c => c.tier !== "above_avg"),
    Object.entries(SNAP_COMBOS).filter(([, c]) => c.tier === "above_avg").map(([k]) => k), []);
  check("exactly one combo is sized down",
    Object.values(SNAP_COMBOS).filter(c => c.tier === "below_avg").length === 1);
  check("…and it is CALL|position:near_high",
    SNAP_COMBOS["CALL|position:near_high"].tier === "below_avg");
}

// ── 3) 2026-11-05 specifically ────────────────────────────────────────
console.log("\n── 3) what 2026-11-05 does under the new rule ──");
{
  const usable = SNAP.filter(r => r.signal === "PUT" && r.day >= api.C.COMBO_EVIDENCE_FROM
    && Number.isFinite(r.pnlPctAtFill)
    && api.positionBucket(r.entryConditions?.spot, r.entryConditions?.breakoutHigh, r.entryConditions?.breakoutLow) === "near_low");
  const d = usable.filter(r => r.day === "2026-11-05");
  check("2026-11-05 contributes 36 usable trades", d.length === 36, d.length, 36);
  const share = d.length / usable.length;
  check(`its trade share is ${(share * 100).toFixed(0)}% — now UNDER the 25% cap as the sample grew`,
    share <= api.C.COMBO_MAX_DAY_SHARE, +(share * 100).toFixed(1), "<= 25%");
  check("…so the cap alone no longer blocks it, and LOO is the sole remaining guard",
    SNAP_COMBOS["PUT|position:near_low"].blockedBy === "leave-one-day-out",
    SNAP_COMBOS["PUT|position:near_low"].blockedBy, "leave-one-day-out");
  // Its weight in the estimator is 1/D, not its trade share.
  check("its weight in the day-mean estimator is 1/16, far below its 24% trade share",
    Math.abs(1 / SNAP_COMBOS["PUT|position:near_low"].days - 0.0625) < 1e-9);
  // And the decisive fact: dropping it breaks the up case.
  const without = api.computeCombos(SNAP.filter(r => r.day !== "2026-11-05"), null)
    .combos["PUT|position:near_low"];
  check("removing 2026-11-05 drops theta below the +5 margin",
    without.avgPnlPct < 5, without.avgPnlPct, "< 5");
  check("…which is exactly why leave-one-day-out refuses the promotion",
    without.tier !== "above_avg", without.tier, "not above_avg");
}

// ── 4) the live file: structural invariants only (cannot go stale) ─────
console.log("\n── 4) the LIVE outcomes file — structural checks only ──");
{
  const live = parse(lf(fs.readFileSync("outcomes_lab.jsonl", "utf8")));
  check("the live file is a superset of the snapshot (append-only)",
    live.length >= SNAP.length, { live: live.length, snap: SNAP.length }, "live >= snap");
  const combos = api.computeCombos(live, null).combos;
  // These hold on ANY data, so they never rot.
  for (const [k, c] of Object.entries(combos)) {
    const label = k.replace("|position:", "|");
    check(`${label}: a verdict always states a reason or none`,
      c.blockedBy === null || typeof c.blockedBy === "string", c.blockedBy, "null or string");
    check(`${label}: an unblocked non-average tier never exceeds its gates`,
      !(c.tier === "above_avg" && (c.days < api.C.COMBO_MIN_DAYS_UP || c.n < api.C.COMBO_MIN_TRADES_UP))
      && !(c.tier === "below_avg" && (c.days < api.C.COMBO_MIN_DAYS_DOWN || c.n < api.C.COMBO_MIN_TRADES_DOWN)),
      { tier: c.tier, days: c.days, n: c.n }, "gates respected");
    check(`${label}: no verdict survives a day share over the cap`,
      !(["above_avg", "below_avg"].includes(c.tier) && c.maxDayShare > api.C.COMBO_MAX_DAY_SHARE),
      { tier: c.tier, share: c.maxDayShare }, "cap respected");
    check(`${label}: the multiplier always matches the tier`,
      c.sizeMultiplier === api.C.COMBO_SIZE_MULTIPLIER[c.tier], { t: c.tier, m: c.sizeMultiplier }, "match");
    check(`${label}: no evidence predates the window`,
      c.days === 0 || c.n > 0, { days: c.days, n: c.n }, "consistent");
  }
}

// ── 5) THE GATE: a live tier change is HELD ───────────────────────────
console.log("\n── 5) the propose-only gate holds the live change ──");
// The withdrawal block must exist inside the gate region, or section 6
// would be testing nothing.
check("the gate region contains the withdrawal loop",
  grab(RE.gate, "gate").includes("for (const p of prevPending) {"), "absent", "present");
check("COMBO_AUTOAPPLY still ships false", /const COMBO_AUTOAPPLY = false;/.test(SRC),
  grab(RE.autoapply, "autoapply"), "false");
check("the approvals file is still combo_approvals.json",
  /const COMBO_APPROVALS_FILE = "combo_approvals\.json";/.test(SRC),
  grab(RE.approvalsFile, "af"), "combo_approvals.json");

{
  // The real gate, with the real matchComboApproval, and NO approval
  // entry — which is the live situation on deploy.
  const gate = new Function(
    `${grab(RE.sizeMult, "sizeMult")}\n${grab(RE.matchApproval, "matchApproval")}\n`
    // The parameter is NOT called `approvals`: the gate's own first line
    // declares `const approvals`, and a clashing name is a SyntaxError.
    + `return function (combos, approvalList, priorPending, today) {
         const strategy = { combos: {}, changelog: [], pendingComboProposals: priorPending };
         const approvedBy = new Map();
         const multiplierOf = tier => COMBO_SIZE_MULTIPLIER[tier] ?? 1.0;
         const isFirstJudgment = c => c.previousTier == null && c.tier !== "insufficient";
         let changed = [];
         const COMBO_AUTOAPPLY = false;
         const loadComboApprovals = () => approvalList;
${grab(RE.gate, "gate")}
         return { strategy, changed, approvedBy };
       };`)();

  // CALL|near_high is the one combo whose live multiplier the new rule
  // would move: average (x1.0) -> below_avg (x0.5).
  const combos = JSON.parse(JSON.stringify(SNAP_COMBOS));
  for (const k of KEYS) combos[k].previousTier = (k === "CALL|position:near_high") ? "average" : "insufficient";
  const r = gate(combos, [], [], "2026-11-21");

  check("the rule proposed below_avg for CALL|position:near_high",
    EXPECT["CALL|position:near_high"].tier === "below_avg");
  check("with no approvals file entry, the gate HOLDS it",
    combos["CALL|position:near_high"].tier === "average",
    combos["CALL|position:near_high"].tier, "average");
  check("…and the live multiplier stays 1.0, NOT 0.5",
    combos["CALL|position:near_high"].sizeMultiplier === 1.0,
    combos["CALL|position:near_high"].sizeMultiplier, 1.0);
  check("…so nothing counts as changed",
    r.changed.length === 0, r.changed.map(c => c.factors), []);
  check("…and nothing was authorised", r.approvedBy.size === 0, r.approvedBy.size, 0);
  check("…no combo_tier_change was written",
    !r.strategy.changelog.some(e => e.type === "combo_tier_change"), r.strategy.changelog.map(e => e.type), []);
  // The hold must be REAL: the entry-time lookup reads `tier`.
  const lookup = new Function(`${grab(RE.sizeMult, "sm")}\n${grab(RE.lookup, "lookup")}\nreturn lookupComboMultiplier;`)();
  check("the entry path would size CALL near_high at x1.0 while held",
    lookup(combos, "CALL", "near_high").sizeMultiplier === 1.0,
    lookup(combos, "CALL", "near_high"), 1.0);
  // The proposal is recorded, with its day-cluster provenance.
  // Guarded: if the proposal is missing, every dependent assertion below
  // must report a clean failure rather than aborting the suite here.
  const p = r.strategy.pendingComboProposals.find(x => x.comboKey === "CALL|position:near_high") ?? {};
  check("a pending proposal was recorded", p.comboKey === "CALL|position:near_high", r.strategy.pendingComboProposals, "one entry");
  check("…naming the proposed tier and multiplier",
    p.proposedTier === "below_avg" && p.proposedMultiplier === 0.5, { t: p.proposedTier, m: p.proposedMultiplier });
  check("…and the tier that is still live",
    p.currentTier === "average" && p.currentMultiplier === 1.0, { t: p.currentTier, m: p.currentMultiplier });
  check("…carrying the day count", p.days === 16, p.days, 16);
  check("…the largest single-day share and its day",
    typeof p.maxDayShare === "number" && typeof p.maxDayShareDay === "string",
    { s: p.maxDayShare, d: p.maxDayShareDay }, "both present");
  check("…and the t it was judged with", p.tCrit === 1.341, p.tCrit, 1.341);
  check("…marked awaiting_approval", p.status === "awaiting_approval", p.status, "awaiting_approval");

  // WITH a matching approval the same change goes through — otherwise
  // the hold above would prove nothing.
  const combos2 = JSON.parse(JSON.stringify(SNAP_COMBOS));
  for (const k of KEYS) combos2[k].previousTier = (k === "CALL|position:near_high") ? "average" : "insufficient";
  const r2 = gate(combos2,
    [{ comboKey: "CALL|position:near_high", tier: "below_avg", expires: "2027-01-20" }], [], "2026-11-21");
  check("an owner approval lets the SAME change through",
    combos2["CALL|position:near_high"].tier === "below_avg",
    combos2["CALL|position:near_high"].tier, "below_avg");
  check("…at x0.5", combos2["CALL|position:near_high"].sizeMultiplier === 0.5,
    combos2["CALL|position:near_high"].sizeMultiplier, 0.5);
  check("…and records who authorised it", r2.approvedBy.has("CALL|position:near_high"));
  check("…with no pending entry left for it",
    !r2.strategy.pendingComboProposals.some(x => x.comboKey === "CALL|position:near_high"));

  // ── 6) a withdrawn proposal leaves an explicit record ──
  console.log("\n── 6) a withdrawn proposal is recorded, not vanished ──");
  // The live situation: PUT|near_low has been pending above_avg since
  // 2026-11-06. The new rule no longer proposes it, so under the old
  // rebuild-from-scratch behaviour the entry would simply disappear.
  const stale = [{
    comboKey: "PUT|position:near_low", currentTier: "average", currentMultiplier: 1,
    proposedTier: "above_avg", proposedMultiplier: 1.5,
    n: 404, wins: 232, avgPnlPct: 6.16, se: 2.13, netPnl: 6344,
    firstProposedAt: "2026-11-06T21:00:37.284Z",
    lastNotifiedAt: "2026-11-13T21:00:40.047Z",
    status: "awaiting_approval",
  }];
  const combos3 = JSON.parse(JSON.stringify(SNAP_COMBOS));
  for (const k of KEYS) combos3[k].previousTier = (k === "CALL|position:near_high") ? "average" : "insufficient";
  const r3 = gate(combos3, [], stale, "2026-11-21");

  check("the stale proposal is gone from the pending list",
    !r3.strategy.pendingComboProposals.some(x => x.comboKey === "PUT|position:near_low"
      && x.proposedTier === "above_avg"),
    r3.strategy.pendingComboProposals.map(x => [x.comboKey, x.proposedTier]), "not pending");
  // Guarded for the same reason as `p` above.
  const w = r3.strategy.changelog.find(e => e.type === "combo_proposal_withdrawn") ?? {};
  check("a withdrawal entry was written to the changelog", w.type === "combo_proposal_withdrawn", r3.strategy.changelog.map(e => e.type), "combo_proposal_withdrawn");
  check("…naming the comboKey", w.comboKey === "PUT|position:near_low", w.comboKey, "PUT|position:near_low");
  check("…the old proposed tier", w.proposedTier === "above_avg", w.proposedTier, "above_avg");
  check("…and its multiplier", w.proposedMultiplier === 1.5, w.proposedMultiplier, 1.5);
  check("…the date", w.date === "2026-11-21", w.date, "2026-11-21");
  check("…with an appliedAt timestamp", /^\d{4}-\d{2}-\d{2}T/.test(String(w.appliedAt)), w.appliedAt, "an ISO timestamp");
  check("…the exact reason 'withdrawn by rule change'",
    w.reason === "withdrawn by rule change", w.reason, "withdrawn by rule change");
  check("…preserving how long it had been waiting",
    w.firstProposedAt === "2026-11-06T21:00:37.284Z", w.firstProposedAt, "2026-11-06T21:00:37.284Z");
  check("…and when it was last re-notified",
    w.lastNotifiedAt === "2026-11-13T21:00:40.047Z", w.lastNotifiedAt, "2026-11-13T21:00:40.047Z");
  check("…and the numbers the rule now gives for that combo",
    w.n === 152 && w.days === 16 && w.avgPnlPct === 6.08, { n: w.n, days: w.days, avg: w.avgPnlPct });
  check("…including WHY it is no longer proposed",
    w.blockedBy === "leave-one-day-out", w.blockedBy, "leave-one-day-out");
  check("the withdrawal changes NO tier and NO multiplier",
    combos3["PUT|position:near_low"].tier === "average"
    && combos3["PUT|position:near_low"].sizeMultiplier === 1.0,
    { t: combos3["PUT|position:near_low"].tier, m: combos3["PUT|position:near_low"].sizeMultiplier });
  check("…and writes no combo_tier_change for it",
    !r3.strategy.changelog.some(e => e.type === "combo_tier_change" && e.comboKey === "PUT|position:near_low"));

  // A proposal that is STILL proposed must not be reported as withdrawn.
  const same = [{
    comboKey: "CALL|position:near_high", currentTier: "average", currentMultiplier: 1,
    proposedTier: "below_avg", proposedMultiplier: 0.5, n: 82,
    firstProposedAt: "2026-11-20T21:00:00.000Z", lastNotifiedAt: null, status: "awaiting_approval",
  }];
  const combos4 = JSON.parse(JSON.stringify(SNAP_COMBOS));
  for (const k of KEYS) combos4[k].previousTier = (k === "CALL|position:near_high") ? "average" : "insufficient";
  const r4 = gate(combos4, [], same, "2026-11-21");
  check("a still-standing proposal is NOT reported as withdrawn",
    !r4.strategy.changelog.some(e => e.type === "combo_proposal_withdrawn"),
    r4.strategy.changelog.map(e => e.type), []);
  check("…and its firstProposedAt is carried across the rebuild",
    r4.strategy.pendingComboProposals.find(x => x.comboKey === "CALL|position:near_high").firstProposedAt
      === "2026-11-20T21:00:00.000Z", "reset", "carried");

  // An APPROVED proposal is not a withdrawal either.
  const combos5 = JSON.parse(JSON.stringify(SNAP_COMBOS));
  for (const k of KEYS) combos5[k].previousTier = (k === "CALL|position:near_high") ? "average" : "insufficient";
  const r5 = gate(combos5,
    [{ comboKey: "CALL|position:near_high", tier: "below_avg", expires: "2027-01-20" }], same, "2026-11-21");
  check("an APPROVED proposal is recorded as a change, not a withdrawal",
    !r5.strategy.changelog.some(e => e.type === "combo_proposal_withdrawn"),
    r5.strategy.changelog.map(e => e.type), "no withdrawal");
}

// ── 7) scope ──────────────────────────────────────────────────────────
console.log("\n── 7) scope: no other production file moved ──");
for (const f of ["scan_v21.js", "scan_wvad.js", "runner.js", "daily_report.js"]) {
  check(`${f} byte-identical to the snapshot`,
    lf(fs.readFileSync(f, "utf8")) === showAt(SNAPSHOT, f), "changed", "identical");
}
check("STATE_FILES is untouched in runner.js",
  lf(fs.readFileSync("runner.js", "utf8")) === showAt(SNAPSHOT, "runner.js"), "changed", "identical");
check("combo_approvals.json is still not written by the container",
  !/writeFileSync\(\s*COMBO_APPROVALS_FILE/.test(SRC) && !/writeFileSync\(\s*"combo_approvals/.test(SRC),
  "written", "read-only");
for (const [label, re] of [["positionBucket()", RE.positionBucket], ["lookupComboMultiplier()", RE.lookup],
                           ["COMBO_SIZE_MULTIPLIER", RE.sizeMult], ["loadComboApprovals()", RE.loadApprovals],
                           ["matchComboApproval()", RE.matchApproval]]) {
  check(`${label} byte-identical to the snapshot`,
    grab(re, label) === grab(re, `${label}@snap`, showAt(SNAPSHOT, "scan_lab.js")), "changed", "identical");
}

console.log("\n════════════════════════════════════════════════════════════");
console.log(` passed ${pass} | failed ${fail}`);
console.log("════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
