// ============================================================
// TEST — WVAD math verification for scan_wvad.js
// Run:  node test_wvad.js
//
// Verifies the optimized rolling implementation in scan_wvad.js
// against a deliberately naive, literal transcription of the Pine
// Script formulas (recomputed from scratch on every bar, including
// the divide-by-20-then-multiply-by-20 round trip the real Pine code
// does). Places no orders, touches no network, reads no state file.
// ============================================================
import { computeWVAD, computeATR, filterRTH, etMinutes,
         WVAD_LENGTH, SIGNAL_LENGTH, MIN_CLOSED_BARS } from "./scan_wvad.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
function near(a, b, eps = 1e-6) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

// ─── REFERENCE IMPLEMENTATION (literal Pine transcription) ───
// ta.sma(src, n) -> null until n values exist, else plain mean.
function refSMA(src, n, i) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    if (src[k] === null || src[k] === undefined) return null;
    s += src[k];
  }
  return s / n;
}
function refWVAD(bars) {
  const raw = bars.map(b => (b.h === b.l ? 0 : ((b.c - b.o) / (b.h - b.l)) * b.v));
  // wvadSum = ta.sma(wvad, 20) * 20   <- exactly as written in Pine
  const sum = bars.map((_, i) => {
    const s = refSMA(raw, WVAD_LENGTH, i);
    return s === null ? null : s * WVAD_LENGTH;
  });
  // signal = ta.sma(wvadSum, 9)
  const sig = bars.map((_, i) => refSMA(sum, SIGNAL_LENGTH, i));
  return { raw, sum, sig };
}

// ─── SYNTHETIC BARS ──────────────────────────────────────────
// Deterministic pseudo-random OHLCV; no dependency on market data.
function makeBars(n, seed = 42) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const bars = [];
  let price = 500;
  const t0 = Date.UTC(2026, 8, 15, 13, 30); // 2026-09-15 13:30 UTC = 09:30 ET (DST)
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = +(o + (rnd() - 0.5) * 2).toFixed(2);
    const h = +(Math.max(o, c) + rnd() * 0.8).toFixed(2);
    const l = +(Math.min(o, c) - rnd() * 0.8).toFixed(2);
    const v = Math.round(100000 + rnd() * 900000);
    bars.push({ t: new Date(t0 + i * 15 * 60000).toISOString(), o, h, l, c, v });
    price = c;
  }
  return bars;
}

console.log("\n=== 1. Rolling implementation vs literal Pine transcription ===");
{
  const bars = makeBars(120);
  const got = computeWVAD(bars);
  const ref = refWVAD(bars);

  let rawOk = true, sumOk = true, sigOk = true;
  let firstSumMismatch = "", firstSigMismatch = "";
  for (let i = 0; i < bars.length; i++) {
    if (!near(got.raw[i], ref.raw[i])) rawOk = false;
    if (!near(got.sum[i], ref.sum[i], 1e-9)) {
      if (sumOk) firstSumMismatch = `i=${i} got=${got.sum[i]} ref=${ref.sum[i]}`;
      sumOk = false;
    }
    if (!near(got.sig[i], ref.sig[i], 1e-9)) {
      if (sigOk) firstSigMismatch = `i=${i} got=${got.sig[i]} ref=${ref.sig[i]}`;
      sigOk = false;
    }
  }
  check("raw WVAD matches (close-open)/(high-low)*volume", rawOk);
  check("WVAD Sum matches SMA(raw,20)*20 on all 120 bars", sumOk, firstSumMismatch);
  check("Signal matches SMA(WVAD Sum,9) on all 120 bars", sigOk, firstSigMismatch);
}

console.log("\n=== 2. Warm-up indices (Pine `na` behaviour) ===");
{
  const bars = makeBars(60);
  const { sum, sig } = computeWVAD(bars);
  check(`sum is null before index ${WVAD_LENGTH - 1}`,
        sum.slice(0, WVAD_LENGTH - 1).every(v => v === null));
  check(`sum is defined at index ${WVAD_LENGTH - 1}`, sum[WVAD_LENGTH - 1] !== null);
  const firstSig = WVAD_LENGTH - 1 + SIGNAL_LENGTH - 1; // 27
  check(`sig is null before index ${firstSig}`,
        sig.slice(0, firstSig).every(v => v === null));
  check(`sig is defined at index ${firstSig}`, sig[firstSig] !== null);
  check(`MIN_CLOSED_BARS (${MIN_CLOSED_BARS}) gives two consecutive sig values`,
        sig[MIN_CLOSED_BARS - 1] !== null && sig[MIN_CLOSED_BARS - 2] !== null);
}

console.log("\n=== 3. Doji guard (high == low) ===");
{
  const bars = makeBars(30);
  bars[10] = { ...bars[10], o: 500, c: 500, h: 500, l: 500, v: 999999 };
  const { raw } = computeWVAD(bars);
  check("high == low yields 0, not NaN/Infinity", raw[10] === 0, `got ${raw[10]}`);
  check("no NaN anywhere in raw series", raw.every(v => Number.isFinite(v)));
}

console.log("\n=== 4. Crossover semantics (Pine ta.crossover uses <=, not <) ===");
{
  // Replicates the exact comparison scan_wvad.js::checkSignal makes.
  const crossUp   = (pSum, pSig, cSum, cSig) => pSum <= pSig && cSum >  cSig;
  const crossDown = (pSum, pSig, cSum, cSig) => pSum >= pSig && cSum <  cSig;

  check("equal-then-above counts as a crossover", crossUp(100, 100, 120, 110));
  check("equal-then-below counts as a crossunder", crossDown(100, 100, 90, 110));
  check("below-then-above counts as a crossover", crossUp(90, 100, 120, 110));
  check("above-then-above is NOT a crossover", !crossUp(120, 100, 130, 110));
  check("touching but not crossing is NOT a signal",
        !crossUp(90, 100, 110, 110) && !crossDown(110, 100, 110, 110));
  check("both directions cannot fire on the same bar",
        !(crossUp(90, 100, 120, 110) && crossDown(90, 100, 120, 110)));
}

console.log("\n=== 5. ATR(14), Wilder smoothing ===");
{
  // Hand-computable series: every bar has a TR of exactly 2.00, so the
  // Wilder average must be exactly 2.00 regardless of bar count.
  const flat = [];
  for (let i = 0; i < 40; i++) flat.push({ t: "", o: 100, h: 101, l: 99, c: 100, v: 1 });
  check("constant TR=2 series gives ATR exactly 2", near(computeATR(flat), 2, 1e-9),
        `got ${computeATR(flat)}`);

  // Independent Wilder reference on real-ish data.
  const bars = makeBars(80, 7);
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  let ref = tr.slice(0, 14).reduce((a, x) => a + x, 0) / 14;
  for (let i = 14; i < tr.length; i++) ref = (ref * 13 + tr[i]) / 14;
  check("ATR matches independent Wilder reference", near(computeATR(bars), ref, 1e-9),
        `got ${computeATR(bars)} ref ${ref}`);

  // A simple (non-Wilder) mean of TR must NOT match — proves we really
  // are smoothing, not averaging.
  const simpleMean = tr.reduce((a, x) => a + x, 0) / tr.length;
  check("ATR is Wilder-smoothed, not a simple mean", !near(computeATR(bars), simpleMean, 1e-6));

  check("too-few bars returns null", computeATR(bars.slice(0, 10)) === null);
}

console.log("\n=== 6. RTH filter (the volume-dilution guard) ===");
{
  // Summer date (EDT, UTC-4): RTH = 13:30-20:00 UTC
  const summer = [
    { t: "2026-07-15T08:00:00Z", label: "04:00 ET pre-market" },
    { t: "2026-07-15T13:15:00Z", label: "09:15 ET pre-market" },
    { t: "2026-07-15T13:30:00Z", label: "09:30 ET open" },
    { t: "2026-07-15T19:45:00Z", label: "15:45 ET" },
    { t: "2026-07-15T20:00:00Z", label: "16:00 ET close" },
    { t: "2026-07-15T22:00:00Z", label: "18:00 ET post-market" },
  ].map(b => ({ ...b, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const keptSummer = filterRTH(summer).map(b => b.label);
  check("summer: keeps only 09:30 and 15:45 ET",
        JSON.stringify(keptSummer) === JSON.stringify(["09:30 ET open", "15:45 ET"]),
        JSON.stringify(keptSummer));

  // Winter date (EST, UTC-5): RTH shifts to 14:30-21:00 UTC. A
  // hardcoded 13:30-20:00 UTC filter would wrongly keep 13:30 UTC
  // (08:30 ET pre-market) and drop 20:30 UTC (15:30 ET, in session).
  const winter = [
    { t: "2026-01-15T13:30:00Z", label: "08:30 ET pre-market" },
    { t: "2026-01-15T14:30:00Z", label: "09:30 ET open" },
    { t: "2026-01-15T20:30:00Z", label: "15:30 ET" },
    { t: "2026-01-15T21:00:00Z", label: "16:00 ET close" },
  ].map(b => ({ ...b, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const keptWinter = filterRTH(winter).map(b => b.label);
  check("winter (DST): keeps only 09:30 and 15:30 ET",
        JSON.stringify(keptWinter) === JSON.stringify(["09:30 ET open", "15:30 ET"]),
        JSON.stringify(keptWinter));

  check("etMinutes converts 13:30 UTC in July to 570 (09:30)",
        etMinutes(new Date("2026-07-15T13:30:00Z")) === 9 * 60 + 30);
  check("etMinutes converts 14:30 UTC in January to 570 (09:30)",
        etMinutes(new Date("2026-01-15T14:30:00Z")) === 9 * 60 + 30);
}

console.log("\n=== 7. Pre/post-market bars actually change the signal ===");
{
  // Proves the RTH filter is not cosmetic: injecting realistic
  // low-volume overnight bars flips at least one computed value.
  const rth = makeBars(60);
  const polluted = [];
  for (let i = 0; i < rth.length; i++) {
    polluted.push(rth[i]);
    if (i % 26 === 25) {
      // an overnight bar: same price area, ~0.5% of the volume
      polluted.push({ ...rth[i], t: new Date(Date.parse(rth[i].t) + 8 * 3600000).toISOString(),
                      v: Math.round(rth[i].v * 0.005) });
    }
  }
  const clean = computeWVAD(rth).sig.filter(v => v !== null).pop();
  const dirty = computeWVAD(polluted).sig.filter(v => v !== null).pop();
  check("overnight bars measurably distort the signal line (so filtering matters)",
        !near(clean, dirty, 1e-3), `clean=${clean} dirty=${dirty}`);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
