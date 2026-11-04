#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// atr_replay_selftest.mjs — offline checks for atr_replay.mjs.
//
// Makes NO network calls: every HTTP check injects a stub fetch and a
// stub sleep. Writes nothing. Run it anywhere:
//
//     node atr_replay_selftest.mjs
//
// Deliberately named *_selftest.mjs rather than test_*.mjs so it stays
// out of the bots' own test suites.
// ═══════════════════════════════════════════════════════════════════════

import * as S from "./atr_replay.mjs";

let pass = 0, fail = 0;
const out = [];
const ok = (name, cond, got) => {
  cond ? pass++ : fail++;
  out.push(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : `   got ${JSON.stringify(got)}`}`);
};
const near = (name, a, b, tol = 1e-9) => ok(name, Math.abs(a - b) <= tol, a);

const M = 60000;
const bar = (min, o, h, l, c) => ({ ms: Date.UTC(2026, 9, 20, 15, min), o, h, l, c, v: 10 });
const LAB = S.BOTS.lab, V21 = S.BOTS.v21;
const T = Date.UTC(2026, 9, 20, 16, 0);

// ─── 1. ATR ────────────────────────────────────────────────────────────
{
  const flat = []; for (let i = 0; i < 16; i++) flat.push(bar(i, 10, 10.5, 9.5, 10));
  near("ATR of constant TR=1 is 1", S.atr(flat, 14), 1);
  ok("ATR null under len+1 bars", S.atr(flat.slice(0, 14), 14) === null);
  ok("ATR null on empty", S.atr([], 14) === null);
  ok("ATR null on a non-array", S.atr(null, 14) === null);
  // Wilder step: 15 bars of TR=1 then one of TR=15 → (1*13 + 15)/14 = 2
  const b2 = []; for (let i = 0; i < 15; i++) b2.push(bar(i, 10, 10.5, 9.5, 10));
  b2.push(bar(15, 10, 25, 10, 20));
  near("Wilder smoothing step", S.atr(b2, 14), 2.0);
  // true range must use the previous close, not just the bar's own range
  const gap = [bar(0, 10, 10, 10, 10), ...Array.from({ length: 15 }, (_, i) => bar(i + 1, 20, 20, 20, 20))];
  ok("ATR sees a gap through the previous close", S.atr(gap, 14) > 0, S.atr(gap, 14));
}

// ─── 2. the replay engine ──────────────────────────────────────────────
{
  let r = S.replay({ bars: [bar(0, 1, 1.02, .98, 1), bar(1, 1, 1.01, .60, .99)], entry: 1, stop: 0.70, terminalMs: T, realExit: 0.99, cfg: LAB });
  ok("stop triggers on the bar low, not the close", r.reason === "atr_stop", r);
  ok("fill is at the stop price", r.exit === 0.70, r.exit);

  r = S.replay({ bars: [bar(0, 1, 1.02, .99, 1), bar(1, .50, .55, .45, .50)], entry: 1, stop: 0.70, terminalMs: T, realExit: 0.5, cfg: LAB });
  ok("a gap-through fills at the open", r.exit === 0.50, r.exit);
  ok("the gap is flagged", r.gapped === true, r);

  // the stated intrabar rule
  r = S.replay({ bars: [bar(0, 1, 1, 1, 1), bar(1, 1, 1.40, .60, 1.35)], entry: 1, stop: 0.70, terminalMs: T, realExit: 1.35, cfg: LAB });
  ok("stop beats a favourable move inside the same bar", r.reason === "atr_stop" && r.exit === 0.70, r);

  r = S.replay({ bars: [bar(0, 1, 1.01, .99, 1), bar(1, 1.02, 1.03, 1, 1.02)], entry: 1, stop: 0.50, terminalMs: T, realExit: 1.07, cfg: LAB });
  ok("an untouched stop yields the REAL exit", r.reason === "real_exit" && r.exit === 1.07, r);

  r = S.replay({ bars: [], entry: 1, stop: 0.7, terminalMs: T, realExit: 1, cfg: LAB });
  ok("no bars is reported, not silently a win", r.reason === "no_bars" && r.exit === null, r);

  // ladders, per bot
  r = S.replay({ bars: [bar(0, 1, 1, 1, 1), bar(1, 1.16, 1.18, 1.15, 1.16), bar(2, 1.08, 1.09, 1.00, 1.02)], entry: 1, stop: 0.70, terminalMs: T, realExit: 1.02, cfg: LAB });
  ok("LAB ladder1 fires at +15% and locks +5%", r.ladder1 === true && r.exit === 1.05, r);
  r = S.replay({ bars: [bar(0, 1, 1, 1, 1), bar(1, 1.11, 1.12, 1.10, 1.11), bar(2, 1.08, 1.09, 1.00, 1.02)], entry: 1, stop: 0.65, terminalMs: T, realExit: 1.02, cfg: V21 });
  ok("v21 ladder1 fires at +10% and locks +5%", r.ladder1 === true && r.exit === 1.05, r);
  r = S.replay({ bars: [bar(0, 1, 1, 1, 1), bar(1, 1.31, 1.33, 1.30, 1.31), bar(2, 1.42, 1.43, 1.40, 1.42), bar(3, 1.30, 1.31, 1.20, 1.22)], entry: 1, stop: 0.70, terminalMs: T, realExit: 1.22, cfg: LAB });
  ok("LAB ladder2 arms the trailing stop", r.ladder2 === true && r.peakPct >= 41, r);

  // wide vs tight
  const bs = [bar(0, 1, 1, 1, 1), bar(1, .80, .82, .68, .80), bar(2, .95, .96, .90, .95)];
  const tight = S.replay({ bars: bs, entry: 1, stop: 0.70, terminalMs: T, realExit: 0.95, cfg: LAB });
  const wide = S.replay({ bars: bs, entry: 1, stop: 0.60, terminalMs: T, realExit: 0.95, cfg: LAB });
  ok("a tight stop is hit", tight.reason === "atr_stop", tight);
  ok("a wider stop survives to the real exit", wide.reason === "real_exit" && wide.exit === 0.95, wide);
  ok("and the wider stop ends better here", wide.exit > tight.exit);

  // the terminal bound is respected
  r = S.replay({ bars: [bar(0, 1, 1, 1, 1), bar(1, 1, 1, .10, .10)], entry: 1, stop: 0.70, terminalMs: Date.UTC(2026, 9, 20, 15, 0), realExit: 1.0, cfg: LAB });
  ok("bars past the terminal are not consulted", r.reason === "real_exit", r);
}

// ─── 3. DAY-CLUSTER bootstrap ──────────────────────────────────────────
{
  const mk = (day, ds) => ds.map(d => ({ day, d }));
  const pairs = [...mk("D1", [1, 2, 3]), ...mk("D2", [4, 5]), ...mk("D3", [-1, 0]), ...mk("D4", [2, 2, 2])];

  const a = S.bootstrapByDay(pairs), b = S.bootstrapByDay(pairs);
  ok("day-cluster bootstrap is reproducible", a.lo === b.lo && a.hi === b.hi, { a, b });
  ok("it reports the cluster count, not the trade count", a.clusters === 4 && a.trades === 10, a);
  near("its point estimate is the plain trade mean", a.mean, pairs.reduce((s, p) => s + p.d, 0) / pairs.length);
  ok("the CI brackets the point estimate", a.lo <= a.mean && a.mean <= a.hi, a);

  ok("null below two pairs", S.bootstrapByDay([{ day: "D1", d: 1 }]) === null);
  ok("null when every trade is the same day (nothing to resample)",
    S.bootstrapByDay(mk("D1", [1, 2, 3, 4])) === null);

  // A constant positive effect must be detected.
  const allPos = ["A", "B", "C", "D", "E", "F"].flatMap(d => mk(d, [5, 5]));
  const cp = S.bootstrapByDay(allPos);
  ok("a constant +5 gives p=0 and a CI above zero", cp.p === 0 && cp.lo > 0, cp);

  // The clustering must MATTER: a signal carried entirely by whole days
  // gets a wider interval from the day-cluster bootstrap than from a
  // naive per-trade one, because the day is the real unit of information.
  const naive = (ds, seed = 20261103) => {               // per-trade, for contrast only
    const rnd = S.mulberry32(seed), ms = [];
    for (let i = 0; i < 2000; i++) {
      let s = 0; for (let j = 0; j < ds.length; j++) s += ds[(rnd() * ds.length) | 0];
      ms.push(s / ds.length);
    }
    ms.sort((x, y) => x - y);
    return { lo: ms[Math.floor(0.025 * 1999)], hi: ms[Math.floor(0.975 * 1999)] };
  };
  // six days, each internally identical, half up half down: all the
  // variance lives between days.
  const clustered = [["A", 10], ["B", 10], ["C", 10], ["D", -10], ["E", -10], ["F", -10]]
    .flatMap(([day, v]) => mk(day, [v, v, v, v, v, v]));
  const cl = S.bootstrapByDay(clustered, { n: 2000 });
  const nv = naive(clustered.map(p => p.d));
  ok("day clustering widens the interval when variance is between days",
    (cl.hi - cl.lo) > (nv.hi - nv.lo) * 1.5, { cluster: cl.hi - cl.lo, naive: nv.hi - nv.lo });

  // Seeds are honoured. Checked on a sample with many days and
  // continuous values: with only four days and small integers the 2.5%
  // and 97.5% quantiles are coarse enough that two seeds legitimately
  // land on the same pair, so a four-day fixture cannot test this.
  {
    const rich = [];
    for (let d = 0; d < 40; d++) {
      const day = `2026-09-${String((d % 28) + 1).padStart(2, "0")}-${d}`;
      for (let t = 0; t < 4; t++) rich.push({ day, d: Math.sin(d * 7 + t) * 13 + 0.5 });
    }
    const s1 = S.bootstrapByDay(rich, { seed: 1 }), s2 = S.bootstrapByDay(rich, { seed: 2 });
    ok("a different seed gives a different draw", s1.lo !== s2.lo || s1.hi !== s2.hi, { s1, s2 });
    ok("but the point estimate is seed-independent", s1.mean === s2.mean, { a: s1.mean, b: s2.mean });
    ok("and the same seed is exactly reproducible on the rich sample",
      JSON.stringify(S.bootstrapByDay(rich, { seed: 1 })) === JSON.stringify(s1));
  }
}

// ─── 4. shuffled() ─────────────────────────────────────────────────────
{
  const src = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const rnd = S.mulberry32(5);
  const a = S.shuffled(src, rnd);
  ok("shuffled does not mutate its input", JSON.stringify(src) === "[1,2,3,4,5,6,7,8,9,10]", src);
  ok("shuffled is a permutation (same multiset)",
    JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify(src), a);
  ok("shuffled actually reorders", JSON.stringify(a) !== JSON.stringify(src), a);
  ok("shuffled is reproducible for a given seed",
    JSON.stringify(S.shuffled(src, S.mulberry32(7))) === JSON.stringify(S.shuffled(src, S.mulberry32(7))));
  // every element must land somewhere across enough draws
  const r2 = S.mulberry32(11), seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(S.shuffled(src, r2)[0]);
  ok("every value can reach position 0", seen.size === 10, seen.size);
}

// ─── 5. the permutation noise baseline ─────────────────────────────────
{
  // Build a common sample by hand: the shape noisePermuted needs.
  const mkRow = (day, entry, atrPre, bars, realExit, baselinePnl) => ({
    day, entry, atrPre, realExit, terminalMs: T, _post: bars,
    arms: { baseline: { pnlPerCt: baselinePnl } },
  });
  // Bars must be SCALED TO EACH ROW'S ENTRY, or a $1-priced path under a
  // $3 entry is a 67% instant loss and no stop is ever the binding
  // constraint. (My first fixture got this wrong and the engine correctly
  // reported enormous losses.)
  const flatBars = (n, px) => Array.from({ length: n }, (_, i) => bar(i, px, px * 1.01, px * 0.99, px));
  const common = [
    mkRow("D1", 1.00, 0.05, flatBars(10, 1.00), 1.00, 0),
    mkRow("D1", 2.00, 0.20, flatBars(10, 2.00), 2.00, 0),
    mkRow("D2", 1.50, 0.10, flatBars(10, 1.50), 1.50, 0),
    mkRow("D2", 3.00, 0.30, flatBars(10, 3.00), 3.00, 0),
  ];
  const nz = S.noisePermuted(common, LAB);
  ok("one entry per k in the grid",
    JSON.stringify(Object.keys(nz)) === JSON.stringify(S.K_GRID.map(k => `k${k}`)), Object.keys(nz));
  for (const k of S.K_GRID) {
    const e = nz[`k${k}`];
    ok(`k${k}: p5 <= p50 <= p95`, e.p5 <= e.p50 && e.p50 <= e.p95, e);
    ok(`k${k}: reports the draw count and sample size`, e.draws === S.NOISE_DRAWS && e.n === 4, e);
    ok(`k${k}: reports its median distance as a percentage`, e.medianPctDistance > 0, e);
  }
  // The permuted distance distribution must be the REAL one, so a bigger k
  // has to produce a bigger median distance.
  ok("a larger k permutes larger distances",
    nz[`k${S.K_GRID[0]}`].medianPctDistance < nz[`k${S.K_GRID[S.K_GRID.length - 1]}`].medianPctDistance,
    { small: nz[`k${S.K_GRID[0]}`].medianPctDistance, large: nz[`k${S.K_GRID[S.K_GRID.length - 1]}`].medianPctDistance });
  // Flat bars at the entry price: no stop is reachable, so every permuted
  // replay must land on the real exit and the deltas must all be zero.
  ok("on a flat path the permuted deltas are all zero",
    S.K_GRID.every(k => nz[`k${k}`].p5 === 0 && nz[`k${k}`].p95 === 0), nz);
  ok("noisePermuted is reproducible", JSON.stringify(S.noisePermuted(common, LAB)) === JSON.stringify(nz));
  ok("noisePermuted on an empty sample is null", S.noisePermuted([], LAB) === null);

  // Permuting only bites when the PATHS differ too. If every trade has the
  // same path, moving a distance from one trade to another changes nothing
  // and the null distribution is a single point — which is the correct
  // null behaviour, not a bug, and is asserted here as such.
  const samePath = [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 0.80, 0.85), bar(2, 0.9, 0.95, 0.88, 0.95)];
  const identical = [
    mkRow("D1", 1.00, 0.02, samePath, 0.95, -5),
    mkRow("D1", 1.00, 0.30, samePath, 0.95, -5),
    mkRow("D2", 1.00, 0.02, samePath, 0.95, -5),
    mkRow("D2", 1.00, 0.30, samePath, 0.95, -5),
  ];
  const nzSame = S.noisePermuted(identical, LAB);
  ok("identical paths give a degenerate null (permuting cannot matter)",
    S.K_GRID.every(k => nzSame[`k${k}`].p5 === nzSame[`k${k}`].p95), nzSame);

  // Give the trades DIFFERENT depths of dip and the pairing starts to
  // matter, so the permuted null acquires a real spread.
  const dipTo = px => [bar(0, 1, 1, 1, 1), bar(1, 1, 1, px, px + 0.02), bar(2, 0.98, 1.0, 0.96, 0.99)];
  const varied = [
    mkRow("D1", 1.00, 0.03, dipTo(0.95), 0.99, -1),   // shallow dip, tight ATR
    mkRow("D1", 1.00, 0.25, dipTo(0.60), 0.99, -1),   // deep dip, loose ATR
    mkRow("D2", 1.00, 0.05, dipTo(0.90), 0.99, -1),
    mkRow("D2", 1.00, 0.20, dipTo(0.70), 0.99, -1),
    mkRow("D3", 1.00, 0.02, dipTo(0.97), 0.99, -1),
    mkRow("D3", 1.00, 0.30, dipTo(0.55), 0.99, -1),
  ];
  const nz2 = S.noisePermuted(varied, LAB);
  ok("differing paths give the permuted null a real spread",
    S.K_GRID.some(k => nz2[`k${k}`].p95 !== nz2[`k${k}`].p5), nz2);
  ok("and that spread is ordered", S.K_GRID.every(k => nz2[`k${k}`].p5 <= nz2[`k${k}`].p50 && nz2[`k${k}`].p50 <= nz2[`k${k}`].p95), nz2);

  // The secondary uniform band still works and is clearly separate.
  const nu = S.noiseUniform(common, LAB, "lab");
  ok("the secondary uniform band reports its range", JSON.stringify(nu.rangePct) === JSON.stringify(S.NOISE_RANGE.lab), nu);
  ok("the secondary band keeps p5 <= p50 <= p95", nu.p5 <= nu.p50 && nu.p50 <= nu.p95, nu);
}

// ─── 6. out-of-sample splits on day boundaries ─────────────────────────
{
  const armIds = ["baseline", ...S.K_GRID.map(k => `k${k}`)];
  const row = (day, perArm) => ({ day, arms: Object.fromEntries(Object.entries(perArm).map(([k, v]) => [k, { pnlPerCt: v }])) });
  // 10 days; the first k is best early, the last k best late, so the
  // choice really does depend on the training part alone.
  const common = [];
  for (let d = 1; d <= 10; d++) {
    const day = `2026-10-${String(d).padStart(2, "0")}`;
    const early = d <= 7;
    for (let t = 0; t < 3; t++) {
      common.push(row(day, {
        baseline: 0,
        [`k${S.K_GRID[0]}`]: early ? 10 : -10,
        [`k${S.K_GRID[1]}`]: 1,
        [`k${S.K_GRID[2]}`]: early ? -10 : 10,
      }));
    }
  }
  const o = S.outOfSample(common, armIds);
  ok("the split lands on a day boundary", !common.some(r => r.day === o.splitAtDay && r.day < o.splitAtDay), o.splitAtDay);
  ok("train and test days partition the sample", o.trainDays + o.testDays === 10, o);
  ok("train and test trades partition the sample", o.trainN + o.testN === 30, o);
  ok("no day appears in both halves",
    new Set(common.filter(r => r.day < o.splitAtDay).map(r => r.day)).size === o.trainDays
    && !common.filter(r => r.day < o.splitAtDay).some(r => r.day >= o.splitAtDay), o);
  ok("k is chosen on the training part", o.chosenOnTrain === `k${S.K_GRID[0]}`, o);
  ok("the chosen k then FAILS out of sample, and that is reported",
    o.testMeanDiff < 0 && o.heldOutOfSample === false, o);
  ok("the test interval is a day-cluster one", o.testClusters === o.testDays, o);
  ok("too few days is refused rather than guessed",
    typeof S.outOfSample([row("D1", { baseline: 0 }), row("D2", { baseline: 0 })], armIds).error === "string");
  ok("an empty sample is refused", typeof S.outOfSample([], armIds).error === "string");
}

// ─── 7. verdict wiring: each k against ITS OWN p95 ─────────────────────
{
  const res = {
    correction: { alphaPerTest: 0.01 },
    arms: { arms: {
      baseline: { meanPerCt: 0 },
      "k1.5": { meanDiff: 5, p: 0.001, ciExcludesZero: true },    // beats its own 4
      "k2.5": { meanDiff: 5, p: 0.001, ciExcludesZero: true },    // loses to its own 9
      "k4": { meanDiff: 20, p: 0.5, ciExcludesZero: false },      // beats noise, not significant
    } },
    noise: { "k1.5": { p95: 4 }, "k2.5": { p95: 9 }, "k4": { p95: 1 } },
    outOfSample: { chosenOnTrain: "k1.5", heldOutOfSample: true },
  };
  const v = S.verdict(res);
  const by = Object.fromEntries(v.arms.map(a => [a.arm, a]));
  ok("the baseline is not judged", !by.baseline);
  ok("an arm beating its own p95 is credited", by["k1.5"].beatsOwnNoiseP95 === true, by["k1.5"]);
  ok("the SAME delta against a higher own-p95 is rejected", by["k2.5"].beatsOwnNoiseP95 === false, by["k2.5"]);
  ok("so the comparison really is per-k, not a shared p95",
    by["k1.5"].meanDiff === by["k2.5"].meanDiff && by["k1.5"].beatsOwnNoiseP95 !== by["k2.5"].beatsOwnNoiseP95);
  ok("each arm reports the p95 it was judged against", by["k2.5"].ownNoiseP95 === 9, by["k2.5"]);
  ok("all three conditions are required", by["k1.5"].worthConsidering === true, by["k1.5"]);
  ok("failing significance alone sinks an arm", by["k4"].worthConsidering === false, by["k4"]);
  ok("an arm not chosen on train cannot hold out of sample", by["k2.5"].heldOutOfSample === false, by["k2.5"]);
  ok("the summary flag follows the arms", v.anyWorthConsidering === true);
  // A missing noise entry must fail closed, not pass by default.
  const res2 = { ...res, noise: {} };
  ok("a missing own-p95 fails closed", S.verdict(res2).arms.every(a => a.beatsOwnNoiseP95 === false));
}

// ─── 8. gate, coverage, trade selection ────────────────────────────────
{
  const mk = (over, extra = {}) => ({
    day: "2026-10-20", entry: 1, realPnlPerCt: -30, hasPnlAtFill: true,
    arms: { baseline: { pnlPerCt: -30 + over * 100 } }, preBars: 30, postBars: 10,
    crossing: true, ...extra,
  });
  const good = S.gate([mk(0), mk(0.01), mk(-0.01)]);
  ok("a faithful replay passes the gate", good.pass === true, good);
  const bad = S.gate([mk(0.5), mk(0.5), mk(0.5)]);
  ok("a 50%-off replay fails the gate", bad.pass === false, bad);
  const noCross = S.gate([mk(0, { crossing: false }), mk(0, { crossing: false }), mk(0, { crossing: false })]);
  ok("unconfirmed stop crossings fail the gate", noCross.pass === false, noCross);
  ok("the gate reports both measures and both thresholds",
    good.exitError.tolerance === S.GATE.maxMedianExitError
    && good.stopCrossing.threshold === S.GATE.minStopCrossingConfirmed, good);
  const noneEligible = S.gate([mk(0, { hasPnlAtFill: false, crossing: null })]);
  ok("no eligible trades fails closed rather than passing vacuously", noneEligible.pass === false, noneEligible);

  const cov = S.coverage(
    [mk(0), mk(0, { preBars: 3 }), mk(0, { postBars: 0 }), { fetchError: "http 403", preBars: 0, postBars: 0, arms: {} }],
    4, { long_hold: 1 });
  ok("coverage counts the fetch error", cov.missing.fetch_error === 1, cov.missing);
  ok("coverage counts the thin pre-entry window", cov.missing[`fewer_than_${S.MIN_PRE_BARS}_pre_entry_bars`] === 1, cov.missing);
  ok("coverage counts the empty trade window", cov.missing.no_bars_in_trade_window === 1, cov.missing);
  ok("coverage carries the log-level exclusions through", cov.excludedFromLog.long_hold === 1, cov);
}

// ─── 9. time helpers match the bots' own convention ────────────────────
{
  const cdt = Date.UTC(2026, 9, 20, 15, 0), cst = Date.UTC(2026, 11, 10, 15, 0);
  ok("Chicago offset is +300 in October (CDT)", S.chicagoOffsetMin(new Date(cdt)) === 300, S.chicagoOffsetMin(new Date(cdt)));
  ok("Chicago offset is +360 in December (CST)", S.chicagoOffsetMin(new Date(cst)) === 360, S.chicagoOffsetMin(new Date(cst)));
  ok("force exit is 19:55 UTC under CDT", new Date(S.forceExitMs(cdt)).toISOString().slice(11, 16) === "19:55");
  ok("force exit is 20:55 UTC under CST", new Date(S.forceExitMs(cst)).toISOString().slice(11, 16) === "20:55");
  // the bots' own helper, transcribed from scan_lab.js:101-111
  const CHI = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const botOffset = d => {
    const p = CHI.formatToParts(d);
    let o = (d.getUTCHours() * 60 + d.getUTCMinutes()) - (+p.find(x => x.type === "hour").value * 60 + +p.find(x => x.type === "minute").value);
    return o < 0 ? o + 1440 : o;
  };
  let disagree = 0, seen = new Set();
  for (let d = 0; d < 400; d++) for (const h of [0, 13, 15, 19, 23]) {
    const dt = new Date(Date.UTC(2026, 0, 1 + d, h, 30));
    if (S.chicagoOffsetMin(dt) !== botOffset(dt)) disagree++;
    seen.add(S.chicagoOffsetMin(dt));
  }
  ok("offset agrees with the bots' helper on 2000 instants", disagree === 0, disagree);
  ok("the sweep covered both CST and CDT", [...seen].sort().join() === "300,360", [...seen]);
}

// ─── 10. trade selection ───────────────────────────────────────────────
{
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atrself-"));
  const f = path.join(dir, "o.jsonl");
  const rec = (o = {}) => JSON.stringify({
    day: "2026-10-20", symbol: "NVDA", optionSymbol: "NVDA261020C00100000", signal: "CALL",
    tradeId: `t${Math.random()}`, entryPremium: 1, qty: 1, reason: "alpaca_stop",
    entryTime: "2026-10-20T14:00:00Z", exitTime: "2026-10-20T14:30:00Z", exitPremium: 0.7, ...o });
  fs.writeFileSync(f, [
    rec({ tradeId: "keep2", entryTime: "2026-10-20T15:00:00Z", exitTime: "2026-10-20T15:20:00Z" }),
    rec({ tradeId: "keep1" }),
    rec({ tradeId: "est", reason: "alpaca_stop_est" }),
    rec({ tradeId: "long", exitTime: "2026-10-22T14:00:00Z" }),
    rec({ tradeId: "nosym", optionSymbol: undefined }),
    rec({ tradeId: "noqty", qty: 0 }),
    "{ not json",
  ].join("\n") + "\n");
  const { trades, excluded, total } = S.loadTrades(f);
  ok("keeps only the clean trades", trades.length === 2, trades.map(t => t.tradeId));
  ok("sorted by entry time", trades[0].tradeId === "keep1" && trades[1].tradeId === "keep2", trades.map(t => t.tradeId));
  ok("excludes an estimated exit", excluded.estimated_exit === 1, excluded);
  ok("excludes a multi-day hold", excluded.long_hold === 1, excluded);
  ok("excludes missing fields", excluded.missing_fields === 2, excluded);
  ok("counts the unparsed line", excluded.unparsed === 1, excluded);
  ok("the total counts every non-blank line", total === 7, total);
  fs.rmSync(dir, { recursive: true, force: true });

  ok("entry prefers a confirmed fill", S.entryOf({ entryPremium: 1, entryFillPrice: 1.07, entryFillConfirmed: true }) === 1.07);
  ok("entry falls back without confirmation", S.entryOf({ entryPremium: 1, entryFillPrice: 1.07 }) === 1);
  ok("exit prefers a confirmed fill", S.exitOf({ exitPremium: 2, exitFillPrice: 1.8, exitPriceConfirmed: true }) === 1.8);
  ok("exit falls back without confirmation", S.exitOf({ exitPremium: 2, exitFillPrice: 1.8 }) === 2);
}

// ─── 11. per-trade stop levels ─────────────────────────────────────────
{
  const bars = [
    ...Array.from({ length: 20 }, (_, i) => ({ ms: Date.UTC(2026, 9, 20, 14, 30 + i), o: 1, h: 1.02, l: 0.98, c: 1, v: 5 })),
    ...Array.from({ length: 10 }, (_, i) => ({ ms: Date.UTC(2026, 9, 20, 15, i), o: 1, h: 1.01, l: 0.99, c: 1, v: 5 })),
  ];
  const r = {
    day: "2026-10-20", symbol: "NVDA", optionSymbol: "NVDA261020C00100000", signal: "CALL",
    tradeId: "x", qty: 1, entryPremium: 1, entryTime: "2026-10-20T15:00:00Z",
    exitTime: "2026-10-20T15:09:00Z", exitPremium: 1, reason: "alpaca_stop",
    hardStopPrice: 0.70, exitFilledAt: "2026-10-20T15:09:00Z",
  };
  const row = S.processTrade(r, bars, LAB);
  ok("ATR comes only from pre-entry bars", row.preBars === 20, row.preBars);
  ok("ATR is computed", row.atrPre != null, row.atrPre);
  ok("every arm is present", Object.keys(row.arms).length === 1 + S.K_GRID.length, Object.keys(row.arms));
  ok("the baseline stop is the bot's own percentage",
    Math.abs(row.arms.baseline.pnlPerCt) >= 0 && row.arms.baseline.reason === "real_exit", row.arms.baseline);
  ok("a larger k gives a lower stop",
    row.arms[`k${S.K_GRID[0]}`].stop > row.arms[`k${S.K_GRID[S.K_GRID.length - 1]}`].stop,
    [row.arms[`k${S.K_GRID[0]}`].stop, row.arms[`k${S.K_GRID[2]}`].stop]);
  ok("a stop is never below one cent", S.K_GRID.every(k => row.arms[`k${k}`].stop >= 0.01), row.arms);
  ok("no crossing of a 0.70 stop on this path is reported as false", row.crossing === false, row.crossing);
  // thin pre-entry window → no ATR, arms skipped rather than faked
  const thin = S.processTrade(r, bars.slice(18), LAB);
  ok("too few pre-entry bars yields no ATR", thin.atrPre === null, thin.atrPre);
  ok("and the k arms are skipped, not invented",
    S.K_GRID.every(k => thin.arms[`k${k}`].skipped === "no_atr"), thin.arms);
}

// ─── 12. HTTP layer ────────────────────────────────────────────────────
{
  S.__setSleep(async () => {});
  // cap
  let calls = 0;
  S.__setFetch(async () => { calls++; return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }; });
  const b = new S.Budget(3); let threw = null;
  try { for (let i = 0; i < 9; i++) await S.getJson("https://data.alpaca.markets/v2/x", { headers: {}, budget: b }); }
  catch (e) { threw = e; }
  ok("the cap throws", threw && threw.code === "BUDGET", threw && threw.code);
  ok("and makes exactly max calls", calls === 3, calls);

  // host allow-list
  calls = 0; let t2 = null;
  try { await S.getJson("https://example.com/x", { headers: {}, budget: new S.Budget(5) }); } catch (e) { t2 = e; }
  ok("a foreign host is refused", t2 && /not Alpaca/.test(t2.message), t2 && t2.message);
  ok("with zero calls made", calls === 0, calls);

  // 429 -> 500 -> 200 with Retry-After
  const codes = [429, 500, 200]; let i = 0; const slept = [];
  S.__setFetch(async () => {
    const s = codes[i++];
    return { ok: s === 200, status: s, headers: { get: k => (s === 429 && k === "retry-after" ? "2" : null) }, text: async () => "{}" };
  });
  S.__setSleep(async ms => slept.push(ms));
  const bg = new S.Budget(10);
  const r3 = await S.getJson("https://data.alpaca.markets/v2/x", { headers: {}, budget: bg });
  ok("it retries and succeeds", r3.data !== undefined, r3);
  ok("three attempts were spent", bg.used === 3, bg.used);
  ok("Retry-After was honoured", slept[0] === 2000, slept);
  ok("backoff grew after the 500", slept[1] >= 2000, slept);

  // bounded retries
  let n4 = 0;
  S.__setFetch(async () => { n4++; return { ok: false, status: 429, headers: { get: () => null }, text: async () => "" }; });
  S.__setSleep(async () => {});
  const r4 = await S.getJson("https://data.alpaca.markets/v2/x", { headers: {}, budget: new S.Budget(99), tries: 4 });
  ok("retries are bounded by `tries`", n4 === 4, n4);
  ok("and a persistent 429 returns an error, not a throw", /429/.test(r4.error || ""), r4);

  // timeout
  S.__setFetch(async () => { const e = new Error("x"); e.name = "AbortError"; throw e; });
  const r5 = await S.getJson("https://data.alpaca.markets/v2/x", { headers: {}, budget: new S.Budget(9), tries: 2, timeoutMs: 5 });
  ok("a timeout becomes an error string", /timeout/.test(r5.error || ""), r5);

  // 4xx body truncated
  S.__setFetch(async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => "x".repeat(5000) }));
  const r6 = await S.getJson("https://data.alpaca.markets/v2/x", { headers: {}, budget: new S.Budget(9) });
  ok("a 403 body is truncated, never thrown", /403/.test(r6.error || "") && r6.error.length < 400, r6.error.length);

  // pagination
  const urls = [];
  S.__setFetch(async url => {
    urls.push(url);
    const first = !/page_token/.test(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
      bars: { OPT1: [{ t: "2026-10-20T15:00:00Z", o: 1, h: 1, l: 1, c: 1, v: 1 }] },
      next_page_token: first ? "tok" : null }) };
  });
  const pr = await S.fetchOptionBars("OPT1", "a", "b", { headers: {}, budget: new S.Budget(10) });
  ok("pagination follows the token once", urls.length === 2 && /page_token=tok/.test(urls[1]), urls);
  ok("bars from both pages are kept", pr.bars.length === 2, pr.bars.length);
  ok("bars are normalised to ms", typeof pr.bars[0].ms === "number");
  ok("the request asks for the declared timeframe", urls[0].includes(`timeframe=${S.ATR_TIMEFRAME}`), urls[0]);
}

// ─── 13. secrets and pre-declared constants ────────────────────────────
{
  S.registerSecrets("PKSUPERSECRET123", "sk_abcdefghijklmnop");
  const s = S.redact("hdr PKSUPERSECRET123 and sk_abcdefghijklmnop");
  ok("the key is redacted", !s.includes("PKSUPERSECRET123"), s);
  ok("the secret is redacted", !s.includes("sk_abcdefghijklmnop"), s);
  S.registerSecrets();
  ok("short values are not treated as secrets", S.redact("abc") === "abc");

  ok("the k grid has exactly three values", S.K_GRID.length === 3, S.K_GRID);
  ok("the k grid is the declared one", JSON.stringify(S.K_GRID) === JSON.stringify([1.5, 2.5, 4.0]), S.K_GRID);
  ok("one ATR window only", S.ATR_LEN === 14 && S.ATR_TIMEFRAME === "1Min", [S.ATR_LEN, S.ATR_TIMEFRAME]);
  ok("hypothesis count is 3 x 2 bots", S.HYPOTHESES_THIS_STUDY === 6, S.HYPOTHESES_THIS_STUDY);
  ok("LAB carries its cumulative count", S.HYPOTHESES_LAB_CUMULATIVE === 81, S.HYPOTHESES_LAB_CUMULATIVE);
  ok("v21 exit params match scan_v21.js:90-95",
    S.BOTS.v21.hardStopPct === -35 && S.BOTS.v21.l1 === 10 && S.BOTS.v21.l1Lock === 5
    && S.BOTS.v21.l2 === 20 && S.BOTS.v21.l2Lock === 10 && S.BOTS.v21.trail === 10, S.BOTS.v21);
  ok("LAB exit params match strategy_lab.json",
    S.BOTS.lab.hardStopPct === -30 && S.BOTS.lab.l1 === 15 && S.BOTS.lab.l1Lock === 5
    && S.BOTS.lab.l2 === 25 && S.BOTS.lab.l2Lock === 12 && S.BOTS.lab.trail === 8, S.BOTS.lab);
  ok("the poll interval matches runner.js CYCLE_INTERVAL_MS", S.POLL_SECONDS === 60);
  ok("credential defaults are the account-agnostic data key",
    S.DEFAULT_KEY_ENV === "ABDULLAH_TJ_KEY" && S.DEFAULT_SECRET_ENV === "ABDULLAH_TJ_SECRET",
    [S.DEFAULT_KEY_ENV, S.DEFAULT_SECRET_ENV]);
  ok("neither bot pins its own key env var any more",
    !("keyEnv" in S.BOTS.v21) && !("keyEnv" in S.BOTS.lab), [S.BOTS.v21, S.BOTS.lab]);
  ok("correction applies the cumulative count to LAB and the study count to v21",
    S.correction("lab").appliedCount === 81 && S.correction("v21").appliedCount === 6,
    [S.correction("lab").appliedCount, S.correction("v21").appliedCount]);
}

// ─── report ────────────────────────────────────────────────────────────
console.log(out.join("\n"));
console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
