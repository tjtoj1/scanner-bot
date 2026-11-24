#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// test_combo_rule.mjs — the day-cluster combo rule's arithmetic.
//
// Covers the estimator itself with HAND-COMPUTED fixtures: day grouping,
// the t-table, the se floor, the concentration cap, leave-one-day-out,
// the evidence window, the fill-only value, and every edge case the
// design named. Nothing here reads the live outcomes file — the verdicts
// on real data are pinned separately in test_combo_replay.mjs.
//
// The functions are lifted out of scan_lab.js BY TEXT and executed with
// stubs, because scan_lab.js is a top-level script that trades on import.
// grab() throws when a regex stops matching, so a drifting source fails
// loudly instead of passing vacuously.
// ════════════════════════════════════════════════════════════════════════

import fs from "node:fs";

const lf = s => s.replace(/\r\n/g, "\n");
const SRC = lf(fs.readFileSync("scan_lab.js", "utf8"));

const grab = (re, what) => {
  const m = SRC.match(re);
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
const close = (a, b, eps = 0.005) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;

const RE = {
  limits: /const COMBO_EVIDENCE_FROM\s+= [\s\S]*?const COMBO_T90_ASYMPTOTIC\s+= [\d.]+;/,
  sizeMult: /const COMBO_SIZE_MULTIPLIER = \{[^\n]*\};/,
  tCrit: /function comboTCrit\(df\) \{[\s\S]*?\n\}/,
  positionBucket: /function positionBucket\(spot, breakoutHigh, breakoutLow\) \{[\s\S]*?\n\}/,
  computeCombos: /function computeCombos\(records, previousCombos\) \{[\s\S]*?\n\}/,
};

const api = new Function(
  `${grab(RE.limits, "limits")}\n${grab(RE.sizeMult, "sizeMult")}\n`
  + `${grab(RE.tCrit, "tCrit")}\n${grab(RE.positionBucket, "pb")}\n`
  + `${grab(RE.computeCombos, "computeCombos")}\n`
  + `return { computeCombos, comboTCrit, positionBucket,
      C: { COMBO_EVIDENCE_FROM, COMBO_MIN_DAYS_DOWN, COMBO_MIN_TRADES_DOWN,
           COMBO_MIN_DAYS_UP, COMBO_MIN_TRADES_UP, COMBO_ABS_MARGIN_PP,
           COMBO_MAX_DAY_SHARE, COMBO_SE_FLOOR_PP, COMBO_T90, COMBO_T90_ASYMPTOTIC,
           COMBO_SIZE_MULTIPLIER } };`)();
const C = api.C;

// ── fixture builder ───────────────────────────────────────────────────
// A trade that lands in the given bucket. positionBucket() is the real
// one, so the spot/high/low here must genuinely produce the bucket asked
// for: low=0, high=100, spot 10 -> 0.10 -> near_low; 50 -> mid;
// 90 -> near_high.
const SPOT = { near_low: 10, mid: 50, near_high: 90 };
let tid = 0;
const trade = (day, pctAtFill, { signal = "PUT", position = "near_low", pnlAtFill = null, pnlPct = null } = {}) => ({
  day, signal, tradeId: `t${++tid}`,
  pnlPct: pnlPct == null ? (pctAtFill == null ? 0 : pctAtFill + 3) : pnlPct, // reported is deliberately DIFFERENT
  pnlPctAtFill: pctAtFill,
  pnl: 999,                       // reported net, deliberately absurd
  pnlAtFill: pnlAtFill == null ? (pctAtFill == null ? null : Math.round(pctAtFill * 10)) : pnlAtFill,
  win: true,                      // reported win flag, deliberately always true
  entryConditions: { spot: SPOT[position], breakoutHigh: 100, breakoutLow: 0 },
});
const run = rows => api.computeCombos(rows, null).combos["PUT|position:near_low"];

console.log("════════════════════════════════════════════════════════════");
console.log(" test_combo_rule — the day-cluster combo rule's arithmetic");
console.log("════════════════════════════════════════════════════════════");

// ── 1) the constants are what the owner approved ──────────────────────
console.log("\n── 1) approved constants ──");
check("COMBO_EVIDENCE_FROM = 2026-10-23", C.COMBO_EVIDENCE_FROM === "2026-10-23", C.COMBO_EVIDENCE_FROM, "2026-10-23");
check("down gates = 10 days / 20 trades",
  C.COMBO_MIN_DAYS_DOWN === 10 && C.COMBO_MIN_TRADES_DOWN === 20,
  { d: C.COMBO_MIN_DAYS_DOWN, t: C.COMBO_MIN_TRADES_DOWN }, { d: 10, t: 20 });
check("up gates = 15 days / 30 trades",
  C.COMBO_MIN_DAYS_UP === 15 && C.COMBO_MIN_TRADES_UP === 30,
  { d: C.COMBO_MIN_DAYS_UP, t: C.COMBO_MIN_TRADES_UP }, { d: 15, t: 30 });
check("COMBO_ABS_MARGIN_PP stays 5", C.COMBO_ABS_MARGIN_PP === 5, C.COMBO_ABS_MARGIN_PP, 5);
check("max day share = 0.25", C.COMBO_MAX_DAY_SHARE === 0.25, C.COMBO_MAX_DAY_SHARE, 0.25);
check("se floor = 0.1pp", C.COMBO_SE_FLOOR_PP === 0.1, C.COMBO_SE_FLOOR_PP, 0.1);
check("multipliers unchanged",
  JSON.stringify(C.COMBO_SIZE_MULTIPLIER) === JSON.stringify({ above_avg: 1.5, average: 1.0, below_avg: 0.5, insufficient: 1.0 }),
  C.COMBO_SIZE_MULTIPLIER, "1.5 / 1.0 / 0.5 / 1.0");

// ── 2) the t-table ────────────────────────────────────────────────────
console.log("\n── 2) the one-sided 90% t-table ──");
// Standard one-sided 90% (upper-tail 0.10) Student-t critical values.
for (const [df, want] of [[1, 3.078], [2, 1.886], [5, 1.476], [10, 1.372],
                          [13, 1.350], [15, 1.341], [20, 1.325], [30, 1.310], [40, 1.303]]) {
  check(`t(0.90, df=${df}) = ${want}`, api.comboTCrit(df) === want, api.comboTCrit(df), want);
}
check("df > 40 falls back to the normal 1.282", api.comboTCrit(41) === 1.282, api.comboTCrit(41), 1.282);
check("df = 1000 is still 1.282", api.comboTCrit(1000) === 1.282, api.comboTCrit(1000), 1.282);
// Untabulated df inside the table's range must take the next LOWER df,
// which is the LARGER critical value — erring toward more evidence.
check("df=33 (untabulated) takes the conservative t(30)=1.310",
  api.comboTCrit(33) === 1.310, api.comboTCrit(33), 1.310);
check("df=37 (untabulated) takes the conservative t(35)=1.306",
  api.comboTCrit(37) === 1.306, api.comboTCrit(37), 1.306);
check("df=0 is null (one day: no variance)", api.comboTCrit(0) === null, api.comboTCrit(0), null);
check("df=-1 is null", api.comboTCrit(-1) === null, api.comboTCrit(-1), null);
check("df=NaN is null", api.comboTCrit(NaN) === null, api.comboTCrit(NaN), null);
check("every t exceeds the asymptotic z", Object.values(C.COMBO_T90).every(v => v > 1.282));
check("the table is monotone decreasing", (() => {
  const d = Object.keys(C.COMBO_T90).map(Number).sort((a, b) => a - b);
  return d.every((x, i) => i === 0 || C.COMBO_T90[x] < C.COMBO_T90[d[i - 1]]);
})());

// ── 3) day grouping, by hand ──────────────────────────────────────────
console.log("\n── 3) day grouping and the mean of daily means ──");
{
  // Three days, deliberately unequal sizes. The point of the estimator is
  // that the 4-trade day does NOT dominate.
  //   2026-10-23: +10            -> dayMean +10
  //   2026-10-26: +20, +40       -> dayMean +30
  //   2026-10-27: 0, 0, 0, +80   -> dayMean +20
  // mean of daily means = (10 + 30 + 20)/3 = +20.00
  // trade-weighted mean  = (10+20+40+0+0+0+80)/7 = +21.43  <- NOT used
  const rows = [
    trade("2026-10-23", 10),
    trade("2026-10-26", 20), trade("2026-10-26", 40),
    trade("2026-10-27", 0), trade("2026-10-27", 0), trade("2026-10-27", 0), trade("2026-10-27", 80),
  ];
  const c = run(rows);
  check("days = 3", c.days === 3, c.days, 3);
  check("n = 7 usable trades", c.n === 7, c.n, 7);
  check("avgPnlPct is the MEAN OF DAILY MEANS = +20.00", c.avgPnlPct === 20, c.avgPnlPct, 20);
  check("…and NOT the trade-weighted +21.43", c.avgPnlPct !== 21.43, c.avgPnlPct, "not 21.43");
  // sd of {10,30,20} = 10 exactly; se = 10/sqrt(3) = 5.7735 -> 5.77
  check("se is the day-level se = 10/sqrt(3) = 5.77", c.se === 5.77, c.se, 5.77);
  check("maxDayShare = 4/7 = 0.571", c.maxDayShare === 0.571, c.maxDayShare, 0.571);
  check("maxDayShareDay names the 4-trade day", c.maxDayShareDay === "2026-10-27", c.maxDayShareDay, "2026-10-27");
  check("tCrit is t(df=2) = 1.886", c.tCrit === 1.886, c.tCrit, 1.886);
}
{
  // One busy day cannot move the estimate more than 1/D. Same 3 days,
  // but the big day now has 40 trades instead of 4, all at the same mean.
  const base = [trade("2026-10-23", 10), trade("2026-10-26", 20), trade("2026-10-26", 40)];
  const small = run([...base, trade("2026-10-27", 20)]);
  const huge = run([...base, ...Array.from({ length: 40 }, () => trade("2026-10-27", 20))]);
  check("a 40-trade day and a 1-trade day with the same mean give the SAME estimate",
    small.avgPnlPct === huge.avgPnlPct, { small: small.avgPnlPct, huge: huge.avgPnlPct }, "equal");
  check("…and the same day-level se", small.se === huge.se, { small: small.se, huge: huge.se }, "equal");
  check("…while the trade count and the share differ",
    huge.n === 43 && small.n === 4 && huge.maxDayShare > small.maxDayShare, { huge: huge.n, small: small.n });
}

// ── 4) the fill-only value, with no fallback ──────────────────────────
console.log("\n── 4) value: pnlPctAtFill only, exclusion not fallback ──");
{
  // Every reported field in the fixture is deliberately wrong-by-+3 or
  // absurd, so any fallback shows up immediately.
  const rows = [
    trade("2026-10-23", 10), trade("2026-10-26", 20), trade("2026-10-27", 30),
  ];
  const c = run(rows);
  check("the estimate uses the fill percent (20), not reported (23)", c.avgPnlPct === 20, c.avgPnlPct, 20);
  check("the net uses pnlAtFill (100+200+300), not the absurd reported 999 each",
    c.pnl === 600, c.pnl, 600);
  check("the win count uses pnlAtFill > 0, not the always-true reported win flag",
    c.wins === 3, c.wins, 3);
}
{
  // A trade with no fill percent is EXCLUDED, not defaulted to reported.
  const rows = [
    trade("2026-10-23", 10), trade("2026-10-26", 20),
    trade("2026-10-27", null, { pnlPct: 500 }),   // reported +500, no fill -> must vanish
  ];
  const c = run(rows);
  check("a trade with pnlPctAtFill null is excluded entirely", c.n === 2, c.n, 2);
  check("…its day does not count either", c.days === 2, c.days, 2);
  check("…and the absurd reported +500 never reaches the estimate", c.avgPnlPct === 15, c.avgPnlPct, 15);
}
for (const [label, bad] of [["undefined", undefined], ["null", null], ["a string", "12"],
                            ["Infinity", Infinity], ["-Infinity", -Infinity], ["NaN", NaN]]) {
  const c = run([trade("2026-10-23", 10), trade("2026-10-26", 20), trade("2026-10-27", bad)]);
  check(`pnlPctAtFill = ${label} is excluded`, c.n === 2 && c.avgPnlPct === 15, { n: c.n, avg: c.avgPnlPct }, { n: 2, avg: 15 });
}
{
  // Zero is a REAL outcome and must be kept.
  const c = run([trade("2026-10-23", 0), trade("2026-10-26", 30)]);
  check("pnlPctAtFill = 0 is kept, not treated as missing", c.n === 2, c.n, 2);
  // The flat trade is neither a win nor a loss: of these two only the
  // +30 counts as a win, so wins is 1 and not 2.
  check("a flat trade is not a win (wins = 1 of 2)", c.wins === 1, c.wins, 1);
  check("…but it still enters the estimate, pulling the mean to +15",
    c.avgPnlPct === 15, c.avgPnlPct, 15);
  const flatOnly = run([trade("2026-10-23", 0), trade("2026-10-26", 0)]);
  check("…and an all-flat combo has zero wins", flatOnly.wins === 0, flatOnly.wins, 0);
}

// ── 5) the evidence window ────────────────────────────────────────────
console.log("\n── 5) evidence window ──");
{
  const rows = [
    trade("2026-10-22", 900),   // one day BEFORE the window
    trade("2026-10-23", 10),    // the boundary day itself: INCLUDED
    trade("2026-10-26", 20),
  ];
  const c = run(rows);
  check("a pre-window trade is excluded", c.n === 2, c.n, 2);
  check("the boundary day 2026-10-23 is INCLUDED (>=, not >)", c.days === 2 && c.avgPnlPct === 15,
    { days: c.days, avg: c.avgPnlPct }, { days: 2, avg: 15 });
  check("the pre-window +900 never reaches the estimate", c.avgPnlPct === 15, c.avgPnlPct, 15);
}

// ── 6) the se floor ───────────────────────────────────────────────────
console.log("\n── 6) the se floor ──");
{
  // All day means identical -> sample sd 0 -> se would be 0, and the
  // bound test would then pass on no evidence of stability at all.
  const rows = Array.from({ length: 12 }, (_, i) =>
    trade(`2026-11-${String(i + 1).padStart(2, "0")}`, 20));
  const c = run(rows);
  check("identical day means give the FLOORED se, not 0", c.se === 0.1, c.se, 0.1);
  check("…so the bound is finite and the verdict is still reachable", c.days === 12, c.days, 12);
  // 12 days / 12 trades: days gate met (>=10) but trades gate is not
  // (needs 20), so this must be insufficient, not a verdict.
  check("…but the trade gate still applies (12 trades < 20)", c.tier === "insufficient", c.tier, "insufficient");
  check("…and the block reason names the sample gate", /sample gate/.test(c.blockedBy), c.blockedBy, "sample gate");
}

// ── 7) D < 2 ──────────────────────────────────────────────────────────
console.log("\n── 7) too few days for a variance ──");
{
  const c = run([trade("2026-10-23", 10)]);
  check("one day: tier insufficient", c.tier === "insufficient", c.tier, "insufficient");
  check("one day: se is null", c.se === null, c.se, null);
  check("one day: theta is still reported (+10)", c.avgPnlPct === 10, c.avgPnlPct, 10);
  check("one day: blockedBy says there is no variance", /no variance/.test(c.blockedBy), c.blockedBy, "no variance (D<2)");
  check("one day: tCrit is null", c.tCrit === null, c.tCrit, null);
}
{
  const c = run([]);
  check("no trades at all: insufficient", c.tier === "insufficient", c.tier, "insufficient");
  check("no trades: n = 0, days = 0", c.n === 0 && c.days === 0, { n: c.n, d: c.days });
  check("no trades: theta null, se null", c.avgPnlPct === null && c.se === null);
  check("no trades: maxDayShare 0, not NaN", c.maxDayShare === 0, c.maxDayShare, 0);
  check("no trades: multiplier is 1.0", c.sizeMultiplier === 1.0, c.sizeMultiplier, 1.0);
}

// ── 8) the DOWN verdict, computed by hand ─────────────────────────────
console.log("\n── 8) the DOWN verdict ──");
{
  // 10 days x 2 trades, every day mean exactly -20.
  //   D = 10, N = 20 -> both down gates exactly met
  //   theta = -20 <= -5                       margin: clears
  //   sd = 0 -> se floored at 0.1; t(df=9) = 1.383
  //   upper = -20 + 1.383*0.1 = -19.86 < 0    bound: clears
  //   maxDayShare = 2/20 = 0.10 <= 0.25       cap: clears
  //   every LOO subsample is identical        LOO: clears
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -20), trade(d, -20));
  }
  const c = run(rows);
  check("D=10, N=20 exactly meets the down gates", c.days === 10 && c.n === 20, { d: c.days, n: c.n });
  check("tier = below_avg", c.tier === "below_avg", c.tier, "below_avg");
  check("multiplier = 0.5", c.sizeMultiplier === 0.5, c.sizeMultiplier, 0.5);
  check("blockedBy is null on a clean verdict", c.blockedBy === null, c.blockedBy, null);
  check("maxDayShare = 0.1", c.maxDayShare === 0.1, c.maxDayShare, 0.1);
}
{
  // One day short of the gate: 9 days, 18 trades.
  const rows = [];
  for (let i = 1; i <= 9; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -20), trade(d, -20));
  }
  const c = run(rows);
  check("9 days (one short) is insufficient, not below_avg", c.tier === "insufficient", c.tier, "insufficient");
  check("…and says so", /sample gate \(D=9, N=18\)/.test(c.blockedBy), c.blockedBy, "sample gate (D=9, N=18)");
}
{
  // Days gate met, trades gate missed: 10 days x 1 trade = 10 trades.
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(trade(`2026-11-${String(i).padStart(2, "0")}`, -20));
  const c = run(rows);
  check("10 days but only 10 trades: BOTH gates must pass", c.tier === "insufficient", c.tier, "insufficient");
  check("…and the reason names D and N", /D=10, N=10/.test(c.blockedBy), c.blockedBy, "D=10, N=10");
}
{
  // Margin not cleared: theta = -4 is inside the +-5 band.
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -4), trade(d, -4));
  }
  const c = run(rows);
  check("theta = -4 does not clear the -5 margin -> average", c.tier === "average", c.tier, "average");
  check("…and it is judged, not insufficient (gates were met)", c.blockedBy === null, c.blockedBy, null);
  check("…multiplier stays 1.0", c.sizeMultiplier === 1.0, c.sizeMultiplier, 1.0);
}
{
  // Margin cleared but the bound is not: theta = -6 with a wide spread.
  //   day means alternate -46 / +34 -> theta = -6
  //   sd = 40*... large; upper bound crosses 0, so no verdict.
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    const v = i % 2 ? -46 : 34;
    rows.push(trade(d, v), trade(d, v));
  }
  const c = run(rows);
  check("theta = -6 clears the margin", c.avgPnlPct === -6, c.avgPnlPct, -6);
  check("…but a wide spread leaves the upper bound above 0 -> average",
    c.tier === "average", c.tier, "average");
  check("…the upper bound really is positive",
    c.avgPnlPct + c.tCrit * c.se > 0, c.avgPnlPct + c.tCrit * c.se, "> 0");
}

// ── 9) the UP verdict and its harder gates ────────────────────────────
console.log("\n── 9) the UP verdict ──");
{
  // 15 days x 2 trades at +20 -> D=15, N=30: exactly the up gates.
  const rows = [];
  for (let i = 1; i <= 15; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, 20), trade(d, 20));
  }
  const c = run(rows);
  check("D=15, N=30 exactly meets the up gates", c.days === 15 && c.n === 30, { d: c.days, n: c.n });
  check("tier = above_avg", c.tier === "above_avg", c.tier, "above_avg");
  check("multiplier = 1.5", c.sizeMultiplier === 1.5, c.sizeMultiplier, 1.5);
  check("tCrit = t(df=14) = 1.345", c.tCrit === 1.345, c.tCrit, 1.345);
}
{
  // The same positive evidence at the DOWN gates only (14 days, 28
  // trades) must NOT size up — this is the asymmetry.
  const rows = [];
  for (let i = 1; i <= 14; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, 20), trade(d, 20));
  }
  const c = run(rows);
  check("14 days of the SAME positive evidence is only `average`", c.tier === "average", c.tier, "average");
  check("…so sizing up is strictly harder than sizing down", c.sizeMultiplier === 1.0, c.sizeMultiplier, 1.0);
}
{
  // Mirror of the down case: a symmetric positive theta must behave the
  // same way the negative one does, at its own gates.
  const mk = (n, v) => {
    const rows = [];
    for (let i = 1; i <= n; i++) {
      const d = `2026-11-${String(i).padStart(2, "0")}`;
      rows.push(trade(d, v), trade(d, v));
    }
    return run(rows);
  };
  check("symmetry: -20 at 10 days is below_avg, +20 at 15 days is above_avg",
    mk(10, -20).tier === "below_avg" && mk(15, 20).tier === "above_avg");
  check("symmetry: +4 fails the margin just as -4 does", mk(15, 4).tier === "average", mk(15, 4).tier, "average");
}

// ── 10) the concentration cap ─────────────────────────────────────────
console.log("\n── 10) the concentration cap ──");
{
  // 15 days, 14 of them 1 trade and one day 20 trades, every mean -20.
  // N = 34, maxShare = 20/34 = 0.588 > 0.25 -> blocked.
  const rows = [];
  for (let i = 1; i <= 14; i++) rows.push(trade(`2026-11-${String(i).padStart(2, "0")}`, -20));
  for (let k = 0; k < 20; k++) rows.push(trade("2026-11-15", -20));
  const c = run(rows);
  check("a 59%-of-trades day blocks the verdict", c.tier === "average", c.tier, "average");
  check("…and blockedBy names the concentration and the day",
    /^concentration 59% on 2026-11-15$/.test(c.blockedBy), c.blockedBy, "concentration 59% on 2026-11-15");
  check("…the multiplier stays 1.0", c.sizeMultiplier === 1.0, c.sizeMultiplier, 1.0);
}
{
  // Exactly AT the cap must PASS (the rule says "more than", not "at least").
  // 10 days: 9 days x 3 trades = 27, one day x 9 -> N = 36, 9/36 = 0.25.
  const rows = [];
  for (let i = 1; i <= 9; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -20), trade(d, -20), trade(d, -20));
  }
  for (let k = 0; k < 9; k++) rows.push(trade("2026-11-10", -20));
  const c = run(rows);
  check("maxDayShare exactly 0.25 is allowed", c.maxDayShare === 0.25 && c.tier === "below_avg",
    { share: c.maxDayShare, tier: c.tier }, { share: 0.25, tier: "below_avg" });
}
{
  // Just over the cap must fail: 10 trades on one day out of 36 = 0.278.
  const rows = [];
  for (let i = 1; i <= 9; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -20), trade(d, -20), trade(d, -20));
  }
  for (let k = 0; k < 10; k++) rows.push(trade("2026-11-10", -20));
  const c = run(rows);
  check("maxDayShare 0.270 (just over) is blocked", c.tier === "average", c.tier, "average");
  check("…and reports 27%", /concentration 27%/.test(c.blockedBy), c.blockedBy, "concentration 27%");
}

// ── 11) leave-one-day-out ─────────────────────────────────────────────
console.log("\n── 11) leave-one-day-out ──");
{
  // The 11-05 shape, in miniature: 15 days, 14 of them mildly negative
  // and one hugely positive, engineered so the FULL sample clears the up
  // test but removing the one big day does not.
  //   14 days at +1, one day at +100
  //   theta = (14*1 + 100)/15 = +7.6  -> clears +5
  //   sd of {1 x14, 100} = 25.57; se = 6.60; t(14) = 1.345
  //   lower = 7.6 - 8.88 = -1.28 ... that FAILS the bound, so this
  //   fixture has to be tuned to clear the bound while failing LOO.
  // Use instead: 14 days at +6, one day at +40.
  //   theta = (14*6 + 40)/15 = +8.27 -> clears
  //   sd = 8.78; se = 2.27; lower = 8.27 - 3.05 = +5.22 > 0 -> clears
  //   drop the +40 day: theta = +6.00, sd = 0 -> se floored 0.1,
  //     t(13) = 1.350, lower = 6 - 0.135 = +5.87 > 0 -> still PASSES.
  //   So an all-equal remainder cannot fail LOO. Make the remainder
  //   straddle the margin instead: 7 days at +2, 7 days at +9, one +40.
  //   theta = (14 + 63 + 40)/15 = +7.80 -> clears +5
  //   drop the +40: theta = (14+63)/14 = +5.50, sd = 3.65, se = 0.975,
  //     t(13) = 1.350, lower = 5.50 - 1.32 = +4.18 > 0 and theta >= 5
  //     -> still passes. Tighten: 7 at +1, 7 at +9, one +40.
  //   theta = (7 + 63 + 40)/15 = +7.33 -> clears
  //   drop the +40: theta = (7+63)/14 = +5.00 -> exactly at the margin,
  //     sd = 4.16, se = 1.11, lower = 5.00 - 1.50 = +3.50 > 0 -> passes.
  //   The decisive version: make the remainder's MEAN fall below 5.
  //   7 days at 0, 7 days at +9, one day at +40:
  //     theta = (0 + 63 + 40)/15 = +6.87 -> clears +5
  //     sd = 10.6, se = 2.74, lower = 6.87 - 3.68 = +3.19 > 0 -> clears
  //     drop the +40 day: theta = 63/14 = +4.50 < 5 -> FAILS the margin
  //     -> LOO must block the whole verdict.
  const rows = [];
  for (let i = 1; i <= 7; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, 0), trade(d, 0));
  }
  for (let i = 8; i <= 14; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, 9), trade(d, 9));
  }
  rows.push(trade("2026-11-15", 40), trade("2026-11-15", 40));
  const c = run(rows);
  check("D=15, N=30: the up gates are met", c.days === 15 && c.n === 30, { d: c.days, n: c.n });
  check("the full sample clears the margin (+6.87)", close(c.avgPnlPct, 6.87, 0.02), c.avgPnlPct, 6.87);
  check("the full sample clears the bound", c.avgPnlPct - c.tCrit * c.se > 0,
    +(c.avgPnlPct - c.tCrit * c.se).toFixed(2), "> 0");
  check("maxDayShare 2/30 = 0.067 passes the cap", c.maxDayShare === 0.067, c.maxDayShare, 0.067);
  check("…yet the verdict is blocked, because one day carries it", c.tier === "average", c.tier, "average");
  check("…and blockedBy names leave-one-day-out",
    c.blockedBy === "leave-one-day-out", c.blockedBy, "leave-one-day-out");
  check("…multiplier stays 1.0", c.sizeMultiplier === 1.0, c.sizeMultiplier, 1.0);
}
{
  // LOO is not merely restrictive: robust evidence passes it. 15 days,
  // all at +20 with mild jitter, no single day decisive.
  const rows = [];
  for (let i = 1; i <= 15; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    const v = 20 + (i % 3 - 1); // 19, 20, 21
    rows.push(trade(d, v), trade(d, v));
  }
  const c = run(rows);
  check("robust positive evidence passes LOO", c.tier === "above_avg", c.tier, "above_avg");
  check("…and reports no blocker", c.blockedBy === null, c.blockedBy, null);
}
{
  // LOO applies to the DOWN direction too, symmetrically.
  //   7 days at 0, 7 days at -9, one day at -40 -> theta = -6.87
  //   drop the -40 day: theta = -4.50, inside the margin -> blocked.
  const rows = [];
  for (let i = 1; i <= 7; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, 0), trade(d, 0));
  }
  for (let i = 8; i <= 14; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -9), trade(d, -9));
  }
  rows.push(trade("2026-11-15", -40), trade("2026-11-15", -40));
  const c = run(rows);
  check("LOO blocks a one-day DOWN verdict too", c.tier === "average", c.tier, "average");
  check("…with the same reason", c.blockedBy === "leave-one-day-out", c.blockedBy, "leave-one-day-out");
}
{
  // LOO needs 3 days: with exactly 2 days each subsample has 1 day and
  // no variance, so no verdict is reachable regardless of the numbers.
  const c = run([trade("2026-10-23", -50), trade("2026-10-26", -50)]);
  check("2 days cannot produce a verdict (LOO needs 3)", c.tier === "insufficient", c.tier, "insufficient");
}

// ── 12) the other five combos are unaffected ──────────────────────────
console.log("\n── 12) bucketing and combo independence ──");
{
  const rows = [
    ...Array.from({ length: 2 }, () => trade("2026-10-23", -20, { position: "near_low" })),
    ...Array.from({ length: 2 }, () => trade("2026-10-23", +50, { position: "mid" })),
    ...Array.from({ length: 2 }, () => trade("2026-10-23", +50, { signal: "CALL", position: "near_high" })),
  ];
  const all = api.computeCombos(rows, null).combos;
  check("all six combos always exist", Object.keys(all).length === 6, Object.keys(all).length, 6);
  check("the six keys are signal|position:bucket", Object.keys(all).sort().join(",")
    === ["CALL|position:near_low", "CALL|position:mid", "CALL|position:near_high",
         "PUT|position:near_low", "PUT|position:mid", "PUT|position:near_high"].sort().join(","));
  check("a trade lands only in its own combo",
    all["PUT|position:near_low"].n === 2 && all["PUT|position:mid"].n === 2
    && all["CALL|position:near_high"].n === 2 && all["CALL|position:near_low"].n === 0,
    Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.n])));
  check("an empty combo is insufficient at 1.0x",
    all["CALL|position:mid"].tier === "insufficient" && all["CALL|position:mid"].sizeMultiplier === 1.0);
}
{
  // A trade whose bucket cannot be computed is dropped before anything
  // else — the rule never guesses a bucket.
  const rows = [
    trade("2026-10-23", 10), trade("2026-10-26", 20),
    { ...trade("2026-10-27", 30), entryConditions: { spot: 10, breakoutHigh: 50, breakoutLow: 50 } }, // zero range
    { ...trade("2026-10-28", 30), entryConditions: null },
    { ...trade("2026-10-29", 30), entryConditions: { spot: null, breakoutHigh: 100, breakoutLow: 0 } },
  ];
  const c = run(rows);
  check("unbucketable trades are dropped (zero range, null conditions, null spot)",
    c.n === 2 && c.days === 2, { n: c.n, days: c.days }, { n: 2, days: 2 });
}

// ── 13) previousTier passthrough is untouched ─────────────────────────
console.log("\n── 13) previousTier ──");
{
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -20), trade(d, -20));
  }
  const prev = { "PUT|position:near_low": { tier: "average" } };
  const c = api.computeCombos(rows, prev).combos["PUT|position:near_low"];
  check("previousTier is carried from the prior combos object", c.previousTier === "average", c.previousTier, "average");
  const c2 = api.computeCombos(rows, null).combos["PUT|position:near_low"];
  check("…and is null when there is no prior object", c2.previousTier === null, c2.previousTier, null);
  const c3 = api.computeCombos(rows, {}).combos["PUT|position:near_low"];
  check("…and null when the prior object lacks this key", c3.previousTier === null, c3.previousTier, null);
}

// ── 14) the entry never throws on hostile records ─────────────────────
console.log("\n── 14) hostile input ──");
{
  const nasty = [
    null, undefined, 7, "x", {},
    { day: "2026-10-23" },
    { day: "2026-10-23", pnlPctAtFill: 5 },                       // no entryConditions
    { day: null, pnlPctAtFill: 5, entryConditions: { spot: 10, breakoutHigh: 100, breakoutLow: 0 }, signal: "PUT" },
    { day: "2026-10-23", pnlPctAtFill: 5, entryConditions: { spot: 10, breakoutHigh: 100, breakoutLow: 0 } }, // no signal
  ];
  let threw = null, out = null;
  try { out = api.computeCombos(nasty.filter(Boolean), null); } catch (e) { threw = e; }
  check("hostile records do not throw", threw === null, threw && threw.message, "no throw");
  check("…and all six combos still come back", out && Object.keys(out.combos).length === 6);
  check("…with no verdict invented",
    out && Object.values(out.combos).every(c => c.tier === "insufficient"),
    out && Object.fromEntries(Object.entries(out.combos).map(([k, v]) => [k, v.tier])), "all insufficient");
}

// ── 15) the published entry shape ─────────────────────────────────────
console.log("\n── 15) the persisted entry carries its provenance ──");
{
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const d = `2026-11-${String(i).padStart(2, "0")}`;
    rows.push(trade(d, -20), trade(d, -20));
  }
  const c = run(rows);
  for (const k of ["factors", "depth", "parentKey", "n", "wins", "pnl", "avgPnlPct", "se",
                   "days", "maxDayShare", "maxDayShareDay", "tCrit", "blockedBy",
                   "tier", "previousTier", "sizeMultiplier", "lastUpdated"]) {
    check(`the entry carries ${k}`, k in c, Object.keys(c), k);
  }
  check("sizeMultiplier always agrees with the tier",
    c.sizeMultiplier === C.COMBO_SIZE_MULTIPLIER[c.tier], { t: c.tier, m: c.sizeMultiplier }, "agree");
  check("factors still name the signal and the position",
    c.factors.signal === "PUT" && c.factors.position === "near_low", c.factors);
  check("depth is still 1.5 (the simplified 6-combo scheme)", c.depth === 1.5, c.depth, 1.5);
}

console.log("\n════════════════════════════════════════════════════════════");
console.log(` passed ${pass} | failed ${fail}`);
console.log("════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
