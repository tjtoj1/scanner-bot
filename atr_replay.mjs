#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// atr_replay.mjs — READ-ONLY replay study: would a premium-ATR initial
// stop have beaten the current fixed-% stop, for v21 and LAB?
//
// Run it from the directory that holds outcomes_v21.jsonl and
// outcomes_lab.jsonl (on Railway: /app).
//
// WHAT IT TOUCHES
//   * Network: GET only, only data.alpaca.markets (plus one optional GET
//     /v2/account for --whoami). It never places, cancels or amends an
//     order and never calls any trading endpoint.
//   * Credentials: process.env only, ABDULLAH_TJ_KEY / ABDULLAH_TJ_SECRET
//     by default (market data is account-agnostic, so one pair serves both
//     bots); override with --key-env= / --secret-env=. Never printed,
//     never logged, never written.
//   * Disk: writes ONLY --out (.json), its .csv sibling and its
//     .ckpt.json checkpoint. It never writes into the repo's tracked
//     files, never commits, never pushes.
//
// SAFETY
//   --dry-run        zero network calls; prints the request plan
//   --max-requests=N hard global cap; aborts rather than exceed it
//   429/5xx          exponential backoff, honours Retry-After, 5 tries
//   --timeout-ms=N   per-request AbortController timeout
//   checkpoint       rerun the same command to resume
//
// EVIDENCE DISCIPLINE — all of this is fixed in source BEFORE any data
// was looked at, and the script prints it back so the reader can check:
//   * ATR window: ONE choice, ATR(14) on 1-minute option bars.
//   * k grid: THREE values, {1.5, 2.5, 4.0}.
//   * The baseline reproduction gate runs first and HALTS the study on
//     failure — sections c..f are not printed at all. Each bot halts
//     independently.
//   * k for the out-of-sample section is chosen on the training part
//     only, never on the test part, and the split falls on a DAY
//     boundary so no day straddles train and test.
//   * Every interval is a DAY-CLUSTER bootstrap: trades on one day are
//     not independent draws, so whole trading days are resampled.
//   * The noise baseline is a PERMUTATION of each k's own per-trade
//     distances, and each k is judged against its own p95.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const VERSION = "1.0.0";

// ─── PRE-DECLARED STUDY PARAMETERS ────────────────────────────────────

// ONE ATR window. ATR(14) on 1-minute bars of the option contract itself,
// computed from bars strictly BEFORE the entry timestamp.
//
// Why 1-minute and not 5: the median hold is 9.6 min (v21) and 8.7 min
// (LAB), so the stop has to be calibrated to minute-scale movement. An
// ATR(14) on 5-min bars needs 75 minutes of pre-entry history, which a
// 0-DTE contract bought shortly after the open simply does not have.
export const ATR_LEN = 14;
export const ATR_TIMEFRAME = "1Min";
export const MIN_PRE_BARS = ATR_LEN + 1;      // 15 bars to form ATR(14)
export const PRE_WINDOW_MIN = 120;            // how far back to look for them

// THREE values of k. Chosen on a priori grounds, not from this data:
// conventional ATR-stop practice sits in roughly 1.5-4 ATR, so the grid
// spans that range at its ends and middle. It is entirely possible that
// all three land tighter (or all three wider) than the current fixed
// stop. If so the study REPORTS that; it does not re-pick k.
export const K_GRID = [1.5, 2.5, 4.0];

// Random-stop noise baseline: the stop distance is drawn uniformly from
// the range each bot's tuner is allowed to use (LAB's PARAM_BOUNDS
// .stopLossPct is [-40,-15]; v21's stop is not learnable, so a comparable
// band around its -35 is used).
export const NOISE_RANGE = { v21: [-45, -20], lab: [-40, -15] };
export const NOISE_DRAWS = 200;

export const BOOTSTRAP_N = 10000;
export const TRAIN_FRACTION = 0.70;           // chronological split
export const POLL_SECONDS = 60;               // runner.js CYCLE_INTERVAL_MS
export const MAX_HOLD_MIN = 400;              // excludes multi-day holds

// Baseline reproduction gate. Both must hold or the study halts.
export const GATE = {
  // Median |replayed baseline exit - recorded exit| / entry premium.
  maxMedianExitError: 0.10,
  // Share of recorded alpaca_stop trades where a 1-min bar low really did
  // cross the live stop at or before the recorded fill timestamp.
  minStopCrossingConfirmed: 0.80,
};

// Hypotheses: 3 values of k x 2 bots = 6 tests in this study. LAB's log
// has also carried 78 earlier hypotheses, so the LAB arms are reported
// against that stricter cumulative count as well.
export const HYPOTHESES_THIS_STUDY = K_GRID.length * 2;
export const HYPOTHESES_LAB_CUMULATIVE = 78 + K_GRID.length;
export const ALPHA_FAMILY = 0.05;

// Live exit parameters, transcribed from the bots. v21: scan_v21.js:90-95.
// LAB: strategy_lab.json params (unchanged over the whole log; its
// changelog records no exit-parameter edit).
// Credentials: market data is account-agnostic, so ONE key pair serves
// both bots. Defaults are ABDULLAH_TJ_KEY / ABDULLAH_TJ_SECRET; override
// with --key-env= / --secret-env=.
export const DEFAULT_KEY_ENV = "ABDULLAH_TJ_KEY";
export const DEFAULT_SECRET_ENV = "ABDULLAH_TJ_SECRET";

export const BOTS = {
  v21: {
    file: "outcomes_v21.jsonl",
    hardStopPct: -35, l1: 10, l1Lock: 5, l2: 20, l2Lock: 10, trail: 10,
  },
  lab: {
    file: "outcomes_lab.jsonl",
    hardStopPct: -30, l1: 15, l1Lock: 5, l2: 25, l2Lock: 12, trail: 8,
  },
};

const DATA_BASE = "https://data.alpaca.markets";
const TRADING_BASE = "https://paper-api.alpaca.markets";
const ALLOWED_HOSTS = new Set(["data.alpaca.markets", "paper-api.alpaca.markets"]);

// ─── secrets: env only, never printed ─────────────────────────────────

let SECRETS = [];
export function registerSecrets(...v) { SECRETS = v.filter(x => typeof x === "string" && x.length >= 8); }
export function redact(s) { let o = String(s); for (const v of SECRETS) o = o.split(v).join("[REDACTED]"); return o; }
export const log = (...a) => console.log(a.map(redact).join(" "));

// ─── time: America/Chicago, same convention as the bots ───────────────

const CHI = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function chicagoOffsetMin(d) {
  const p = CHI.formatToParts(d);
  const h = +p.find(x => x.type === "hour").value, m = +p.find(x => x.type === "minute").value;
  let off = (d.getUTCHours() * 60 + d.getUTCMinutes()) - (h * 60 + m);
  if (off < 0) off += 1440;
  return off;                                  // 300 = CDT, 360 = CST
}
// Force exit = 14:55 America/Chicago in both bots (scan_v21.js:157,
// scan_lab.js:136), as an absolute ms timestamp on that instant's day.
export function forceExitMs(atMs) {
  const d = new Date(atMs), off = chicagoOffsetMin(d);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
       + ((14 * 60 + 55 + off) % 1440) * 60000;
}

// ─── maths ────────────────────────────────────────────────────────────

export function atr(bars, len = ATR_LEN) {
  if (!Array.isArray(bars) || bars.length < len + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
  }
  if (tr.length < len) return null;
  let a = tr.slice(0, len).reduce((s, x) => s + x, 0) / len;
  for (let i = len; i < tr.length; i++) a = (a * (len - 1) + tr[i]) / len;
  return a;
}
export const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}
export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
// Fisher-Yates on a copy, driven by a seeded PRNG so a run is reproducible.
export function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// DAY-CLUSTER bootstrap on paired per-trade differences, with a two-sided
// p-value for H0: mean difference = 0.
//
// Trades are NOT independent: several are opened on the same day, in the
// same regime, often in the same name, and a day-wide move hits all of
// them together. Resampling single trades would treat those as
// independent draws and make every interval too narrow. So the resampling
// unit is the TRADING DAY: the same number of days is drawn with
// replacement, each bringing ALL of its trades, and the mean is taken
// over the pooled observations.
//
// `pairs` is [{ day, d }] — one entry per trade, d = arm minus baseline.
export function bootstrapByDay(pairs, { n = BOOTSTRAP_N, seed = 20261103 } = {}) {
  if (pairs.length < 2) return null;
  const byDay = new Map();
  for (const p of pairs) {
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day).push(p.d);
  }
  const days = [...byDay.keys()];
  if (days.length < 2) return null;              // one day cannot be resampled
  const rnd = mulberry32(seed), ms = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = 0; j < days.length; j++) {
      for (const v of byDay.get(days[(rnd() * days.length) | 0])) { sum += v; cnt++; }
    }
    ms[i] = cnt ? sum / cnt : 0;
  }
  ms.sort((a, b) => a - b);
  const at = q => ms[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  // Proportion of resamples on the far side of zero, doubled (two-sided).
  const below = ms.filter(x => x <= 0).length;
  return {
    mean: mean(pairs.map(p => p.d)),
    lo: at(0.025), hi: at(0.975),
    p: Math.min(1, 2 * Math.min(below, n - below) / n),
    clusters: days.length, trades: pairs.length,
  };
}

// ─── the replay engine ────────────────────────────────────────────────
// One function for every arm, so no arm gets a different ladder. Only the
// INITIAL stop level differs between arms.
//
// INTRABAR RULE (stated, not inferred): within a single bar the stop is
// assumed to be hit BEFORE any favourable move. So each bar is tested
// against the stop (bar low) first, and only if the stop was not touched
// does the ladder get to see that bar at all. This is the pessimistic
// ordering and it is applied identically to the baseline arm, so the
// comparison is not tilted by it.
//
// FILL RULE: at the stop price. Justified by the logs rather than assumed
// -- recorded alpaca_stop fills land at the live stop with a median
// difference of $0.00 (v21 n=38: min -0.12, p90 +0.01, max +0.01;
// LAB n=53: min -0.07, p90 +0.01, max +0.28).
//
// TERMINAL RULE: if the stop is never touched inside the window, the
// trade's REAL recorded exit is used unchanged.
export function replay({ bars, entry, stop, terminalMs, realExit, cfg, pollSeconds = POLL_SECONDS }) {
  if (!bars.length) return { exit: null, reason: "no_bars", ms: null };
  let ladder1 = false, ladder2 = false, lockPct, trailPct, peakPct = 0;
  let cur = stop, nextPoll = bars[0].ms;

  for (const b of bars) {
    if (b.ms > terminalMs) break;

    // 1. the stop, on the bar's low, before anything else in this bar
    if (cur !== null && b.l <= cur) {
      return {
        exit: Math.min(cur, b.o),                     // a gap-through fills at the open
        reason: (ladder1 || ladder2) ? "ladder_stop" : "atr_stop",
        ms: b.ms, ladder1, ladder2, peakPct, gapped: b.o < cur,
      };
    }

    // 2. the bot's own poll grid: the ladder and the trailing floor
    if (b.ms >= nextPoll) {
      nextPoll = b.ms + pollSeconds * 1000;
      const pct = (b.c - entry) / entry * 100;
      if (pct >= cfg.l2 && !ladder2) {
        ladder2 = true; ladder1 = true;
        lockPct = cfg.l2Lock; trailPct = cfg.trail;
        peakPct = Math.max(peakPct, pct);
        cur = +(entry * (1 + cfg.l2Lock / 100)).toFixed(2);
      }
      if (pct >= cfg.l1 && !ladder1) {
        ladder1 = true; lockPct = cfg.l1Lock;
        peakPct = Math.max(peakPct, pct);
        cur = +(entry * (1 + cfg.l1Lock / 100)).toFixed(2);
      }
      if (trailPct !== undefined) peakPct = Math.max(peakPct, pct);
      if (lockPct !== undefined) {
        const floorPct = trailPct !== undefined ? peakPct - trailPct : lockPct;
        if (pct <= floorPct) return { exit: b.c, reason: "ladder_stop", ms: b.ms, ladder1, ladder2, peakPct };
        if (trailPct !== undefined) {                 // keep the resting stop in step
          const t = +(entry * (1 + (peakPct - trailPct) / 100)).toFixed(2);
          if (cur === null || t > cur) cur = t;
        }
      }
    }
  }
  // 3. never touched -> the real exit stands
  return { exit: realExit, reason: "real_exit", ms: terminalMs, ladder1, ladder2, peakPct };
}

// ─── HTTP: GET only, capped, backed off, timed out ────────────────────

let _fetch = globalThis.fetch, _sleep = ms => new Promise(r => setTimeout(r, ms));
export function __setFetch(f) { _fetch = f; }
export function __setSleep(f) { _sleep = f; }

export class Budget {
  constructor(max) { this.max = max; this.used = 0; }
  take() {
    if (this.used >= this.max) { const e = new Error(`request cap reached (${this.max})`); e.code = "BUDGET"; throw e; }
    this.used++;
  }
}

export async function getJson(url, { headers, budget, timeoutMs = 10000, tries = 5 }) {
  const host = new URL(url).host;
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`refusing a host that is not Alpaca: ${host}`);
  let delay = 1000;
  for (let attempt = 1; attempt <= tries; attempt++) {
    budget.take();
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try { res = await _fetch(url, { method: "GET", headers, signal: ac.signal }); }
    catch (e) {
      clearTimeout(t);
      if (attempt === tries) return { error: `network: ${e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e.message}` };
      await _sleep(delay); delay *= 2; continue;
    }
    clearTimeout(t);
    if (res.status === 429 || res.status >= 500) {
      if (attempt === tries) return { error: `http ${res.status} after ${tries} tries` };
      const ra = Number(res.headers?.get?.("retry-after"));
      await _sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay);
      delay *= 2; continue;
    }
    const text = await res.text();
    if (!res.ok) return { error: `http ${res.status}: ${text.slice(0, 300)}` };
    try { return { data: JSON.parse(text) }; } catch { return { error: `unparseable: ${text.slice(0, 200)}` }; }
  }
  return { error: "exhausted retries" };
}

const norm = b => ({ ms: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, n: b.n || 0 });

export async function fetchOptionBars(sym, startIso, endIso, ctx) {
  const out = []; let token = null;
  do {
    const u = new URL(`${DATA_BASE}/v1beta1/options/bars`);
    u.searchParams.set("symbols", sym);
    u.searchParams.set("timeframe", ATR_TIMEFRAME);
    u.searchParams.set("start", startIso);
    u.searchParams.set("end", endIso);
    u.searchParams.set("limit", "10000");
    if (token) u.searchParams.set("page_token", token);
    const r = await getJson(u.toString(), ctx);
    if (r.error) return { error: r.error, bars: out };
    for (const b of (r.data.bars?.[sym] || [])) out.push(norm(b));
    token = r.data.next_page_token || null;
  } while (token);
  out.sort((a, b) => a.ms - b.ms);
  return { bars: out };
}

// ─── trade selection ──────────────────────────────────────────────────

export const entryOf = r => (r.entryFillConfirmed === true && typeof r.entryFillPrice === "number") ? r.entryFillPrice : r.entryPremium;
export const exitOf  = r => (r.exitPriceConfirmed === true && typeof r.exitFillPrice === "number") ? r.exitFillPrice : r.exitPremium;
// Per-contract dollars actually realised, fill-accurate when known.
export const realPnlPerCt = r => (exitOf(r) - entryOf(r)) * 100;

export function loadTrades(file) {
  const excluded = { unparsed: 0, missing_fields: 0, long_hold: 0, estimated_exit: 0 };
  const keep = [];
  let total = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    total++;
    let r; try { r = JSON.parse(line); } catch { excluded.unparsed++; continue; }
    if (!r.optionSymbol || !r.entryTime || !r.exitTime || !r.qty || !(r.entryPremium > 0)) { excluded.missing_fields++; continue; }
    const hold = (Date.parse(r.exitTime) - Date.parse(r.entryTime)) / 60000;
    if (!(hold >= 0) || hold > MAX_HOLD_MIN) { excluded.long_hold++; continue; }
    if (r.reason === "alpaca_stop_est") { excluded.estimated_exit++; continue; }
    keep.push(r);
  }
  keep.sort((a, b) => Date.parse(a.entryTime) - Date.parse(b.entryTime));
  return { trades: keep, excluded, total };
}

// ─── per-trade processing ─────────────────────────────────────────────

export function processTrade(r, bars, cfg, { toSessionClose = false } = {}) {
  const entryMs = Date.parse(r.entryTime);
  const exitMs = Date.parse(r.exitTime);
  const entry = entryOf(r);
  const realExit = exitOf(r);
  // As specified: the window runs entry -> ACTUAL exit. --to-session-close
  // extends it to the force-exit time for a secondary, labelled run.
  const terminalMs = toSessionClose ? Math.max(exitMs, forceExitMs(entryMs)) : exitMs;

  const pre = bars.filter(b => b.ms < entryMs && b.ms >= entryMs - PRE_WINDOW_MIN * 60000);
  const post = bars.filter(b => b.ms >= entryMs && b.ms <= terminalMs);
  const atrPre = atr(pre, ATR_LEN);

  // The stop that was really live at the moment of exit: the ladder-
  // tightened one when a ladder had fired, else the recorded hard stop,
  // else the bot's fixed percentage.
  const liveStop = (r.stopPct != null)
    ? +(r.entryPremium * (1 + r.stopPct / 100)).toFixed(2)
    : (r.hardStopPrice != null ? r.hardStopPrice : +(r.entryPremium * (1 + cfg.hardStopPct / 100)).toFixed(2));

  const arms = {};
  // baseline = today's rule, same engine
  const baseStop = +(entry * (1 + cfg.hardStopPct / 100)).toFixed(2);
  arms.baseline = replay({ bars: post, entry, stop: Math.max(0.01, baseStop), terminalMs, realExit, cfg });
  for (const k of K_GRID) {
    if (atrPre == null) { arms[`k${k}`] = { skipped: "no_atr" }; continue; }
    const s = +(entry - k * atrPre).toFixed(2);
    arms[`k${k}`] = { ...replay({ bars: post, entry, stop: Math.max(0.01, s), terminalMs, realExit, cfg }), stop: Math.max(0.01, s), clamped: s < 0.01 };
  }
  for (const [id, a] of Object.entries(arms)) {
    a.pnlPerCt = (a.exit == null) ? null : +((a.exit - entry) * 100).toFixed(2);
  }

  // Gate input: did a bar low really cross the live stop by the recorded
  // fill time? Only answerable for alpaca_stop trades that have one.
  let crossing = null;
  if (r.reason === "alpaca_stop" && r.exitFilledAt) {
    const until = Date.parse(r.exitFilledAt);
    crossing = bars.some(b => b.ms >= entryMs && b.ms <= until && b.l <= liveStop);
  }

  return {
    tradeId: r.tradeId, day: r.day, symbol: r.symbol, optionSymbol: r.optionSymbol,
    signal: r.signal, qty: r.qty, entryTime: r.entryTime, exitTime: r.exitTime,
    entry, realExit, realReason: r.reason,
    realPnlPerCt: +realPnlPerCt(r).toFixed(2),
    hasPnlAtFill: typeof r.pnlAtFill === "number",
    entryFillConfirmed: r.entryFillConfirmed === true,
    exitFillConfirmed: r.exitPriceConfirmed === true,
    liveStop, atrPre, atrOverEntry: atrPre == null ? null : +(atrPre / entry).toFixed(4),
    preBars: pre.length, postBars: post.length,
    crossing, arms, terminalMs,
  };
}

// ─── report sections ──────────────────────────────────────────────────

// (a) coverage
export function coverage(rows, selected, excluded) {
  const miss = {};
  const bump = k => miss[k] = (miss[k] || 0) + 1;
  for (const r of rows) {
    if (r.fetchError) bump("fetch_error");
    else if (!r.postBars) bump("no_bars_in_trade_window");
    else if (r.preBars < MIN_PRE_BARS) bump(`fewer_than_${MIN_PRE_BARS}_pre_entry_bars`);
    else if (r.atrPre == null) bump("atr_not_computable");
  }
  const usable = rows.filter(r => !r.fetchError && r.postBars > 0 && r.atrPre != null);
  return {
    selected, excludedFromLog: excluded,
    fetched: rows.length, usable: usable.length,
    missing: miss,
    medianPreBars: median(rows.map(r => r.preBars)),
    medianPostBars: median(rows.map(r => r.postBars)),
    withPnlAtFill: usable.filter(r => r.hasPnlAtFill).length,
    medianAtrOverEntry: median(usable.map(r => r.atrOverEntry).filter(x => x != null)),
  };
}

// (b) baseline reproduction gate
export function gate(rows) {
  const eligible = rows.filter(r => !r.fetchError && r.postBars > 0 && r.hasPnlAtFill);
  const errs = eligible.map(r => Math.abs(r.arms.baseline.pnlPerCt - r.realPnlPerCt) / (r.entry * 100))
                       .filter(Number.isFinite);
  const medErr = median(errs);
  const checked = rows.filter(r => r.crossing !== null);
  const conf = checked.filter(r => r.crossing === true).length;
  const rate = checked.length ? conf / checked.length : null;
  const pass = medErr != null && medErr <= GATE.maxMedianExitError
            && rate != null && rate >= GATE.minStopCrossingConfirmed;
  return {
    exitError: { n: errs.length, median: medErr == null ? null : +medErr.toFixed(4), tolerance: GATE.maxMedianExitError },
    stopCrossing: { checked: checked.length, confirmed: conf, rate: rate == null ? null : +rate.toFixed(3), threshold: GATE.minStopCrossingConfirmed },
    pass,
  };
}

// (c) ATR results per k, with bootstrap CI
export function armStats(rows, armIds) {
  const common = rows.filter(r => !r.fetchError && armIds.every(id => r.arms[id] && r.arms[id].pnlPerCt != null));
  const base = common.map(r => r.arms.baseline.pnlPerCt);
  const out = { n: common.length, arms: {} };
  for (const id of armIds) {
    const p = common.map(r => r.arms[id].pnlPerCt);
    const s = {
      n: p.length, winRate: p.length ? +(p.filter(x => x > 0).length / p.length * 100).toFixed(1) : null,
      meanPerCt: p.length ? +mean(p).toFixed(2) : null,
      medianPerCt: p.length ? +median(p).toFixed(2) : null,
      netPerCt: +p.reduce((a, b) => a + b, 0).toFixed(2),
      stoppedEarly: common.filter(r => r.arms[id].reason === "atr_stop").length,
    };
    if (id !== "baseline") {
      const pairs = common.map((r, i) => ({ day: r.day, d: p[i] - base[i] }));
      const b = bootstrapByDay(pairs);
      s.meanDiff = +mean(pairs.map(x => x.d)).toFixed(2);
      s.ci95 = b ? { lo: +b.lo.toFixed(2), hi: +b.hi.toFixed(2) } : null;
      s.p = b ? +b.p.toFixed(5) : null;
      s.ciExcludesZero = b ? (b.lo > 0 || b.hi < 0) : null;
      s.clusters = b ? b.clusters : null;
    }
    out.arms[id] = s;
  }
  return { ...out, common };
}

// (d) chronological out-of-sample, k chosen on the training part only.
// The split is made on DAY boundaries, so no trading day straddles train
// and test — otherwise the day-cluster bootstrap on the test part would
// be drawing from days it had already partly seen.
export function outOfSample(common, armIds) {
  if (!common.length) return { error: "no common sample" };
  const days = [...new Set(common.map(r => r.day))].sort();
  if (days.length < 4) return { error: `only ${days.length} trading days — too few to split` };
  const cutIdx = Math.max(1, Math.min(days.length - 1, Math.floor(days.length * TRAIN_FRACTION)));
  const firstTestDay = days[cutIdx];
  const train = common.filter(r => r.day < firstTestDay);
  const test = common.filter(r => r.day >= firstTestDay);
  if (train.length < 2 || test.length < 2) return { error: "sample too small to split" };

  const pairsOn = (set, id) => set.map(r => ({ day: r.day, d: r.arms[id].pnlPerCt - r.arms.baseline.pnlPerCt }));
  const ks = armIds.filter(id => id !== "baseline");
  const trainMeans = {};
  for (const id of ks) trainMeans[id] = mean(pairsOn(train, id).map(x => x.d));
  const chosen = ks.reduce((a, b) => (trainMeans[b] > trainMeans[a] ? b : a), ks[0]);

  const tp = pairsOn(test, chosen), b = bootstrapByDay(tp, { seed: 777 });
  return {
    trainN: train.length, testN: test.length,
    trainDays: cutIdx, testDays: days.length - cutIdx,
    splitAtDay: firstTestDay,
    trainMeanDiffByK: Object.fromEntries(Object.entries(trainMeans).map(([k, v]) => [k, +v.toFixed(2)])),
    chosenOnTrain: chosen,
    testMeanDiff: +mean(tp.map(x => x.d)).toFixed(2),
    testCi95: b ? { lo: +b.lo.toFixed(2), hi: +b.hi.toFixed(2) } : null,
    testP: b ? +b.p.toFixed(5) : null,
    testClusters: b ? b.clusters : null,
    heldOutOfSample: b ? (b.lo > 0) : null,
  };
}

// (e) NOISE BASELINE — a permutation test, per k.
//
// The question a noise baseline has to answer is not "does any stop
// distance help?" but "does putting THIS trade's ATR on THIS trade help,
// or would the same spread of tightnesses help just as much scattered at
// random?". So for each k the per-trade relative stop distances
//
//     pct_i = k * ATR_i / entry_i
//
// are PERMUTED across trades. The distribution of tightness is preserved
// exactly — same values, same mean, same spread — and the only thing
// destroyed is the pairing between a trade and its own volatility. If an
// arm cannot beat its own permuted p95, then its ATR carries no
// trade-specific information and the arm is measuring the tightness level
// alone, which is a fixed-% stop by another name.
//
// Run on the SAME ATR-eligible common sample as section (c), so the
// comparison is paired trade for trade.
export function noisePermuted(common, cfg) {
  if (!common.length) return null;
  const out = {};
  for (const k of K_GRID) {
    const id = `k${k}`;
    const pct = common.map(r => k * r.atrPre / r.entry);   // positive fraction of entry
    const rnd = mulberry32(31337 + Math.round(k * 10));     // fixed, per k
    const means = [];
    for (let d = 0; d < NOISE_DRAWS; d++) {
      const perm = shuffled(pct, rnd);
      let sum = 0;
      for (let i = 0; i < common.length; i++) {
        const r = common[i];
        const s = Math.max(0.01, +(r.entry * (1 - perm[i])).toFixed(2));
        const sim = replay({ bars: r._post, entry: r.entry, stop: s, terminalMs: r.terminalMs, realExit: r.realExit, cfg });
        sum += (sim.exit == null ? 0 : (sim.exit - r.entry) * 100) - r.arms.baseline.pnlPerCt;
      }
      means.push(sum / common.length);
    }
    out[id] = {
      draws: NOISE_DRAWS, n: common.length,
      medianPctDistance: +(median(pct) * 100).toFixed(2),
      p5: +quantile(means, 0.05).toFixed(2),
      p50: +quantile(means, 0.50).toFixed(2),
      p95: +quantile(means, 0.95).toFixed(2),
    };
  }
  return out;
}

// SECONDARY, retained for reference only: the earlier uniform random band.
// It answers the weaker question ("does any stop distance in the allowed
// range help?") and is NOT used by the verdict.
export function noiseUniform(common, cfg, bot) {
  if (!common.length) return null;
  const [lo, hi] = NOISE_RANGE[bot];
  const rnd = mulberry32(31337), means = [];
  for (let d = 0; d < NOISE_DRAWS; d++) {
    let sum = 0;
    for (const r of common) {
      const p = lo + rnd() * (hi - lo);
      const s = Math.max(0.01, +(r.entry * (1 + p / 100)).toFixed(2));
      const sim = replay({ bars: r._post, entry: r.entry, stop: s, terminalMs: r.terminalMs, realExit: r.realExit, cfg });
      sum += (sim.exit == null ? 0 : (sim.exit - r.entry) * 100) - r.arms.baseline.pnlPerCt;
    }
    means.push(sum / common.length);
  }
  return {
    draws: NOISE_DRAWS, n: common.length, rangePct: [lo, hi],
    p5: +quantile(means, 0.05).toFixed(2), p50: +quantile(means, 0.50).toFixed(2), p95: +quantile(means, 0.95).toFixed(2),
  };
}

// (f) multiple-hypothesis correction
export function correction(bot) {
  const n = bot === "lab" ? HYPOTHESES_LAB_CUMULATIVE : HYPOTHESES_THIS_STUDY;
  return {
    thisStudy: HYPOTHESES_THIS_STUDY,
    appliedCount: n,
    note: bot === "lab"
      ? `LAB's log has carried ${HYPOTHESES_LAB_CUMULATIVE - K_GRID.length} earlier hypotheses; the ${K_GRID.length} new ones are corrected against the cumulative total.`
      : `v21's log is fresh ground for this question; corrected against the ${HYPOTHESES_THIS_STUDY} tests in this study.`,
    alphaFamily: ALPHA_FAMILY,
    alphaPerTest: +(ALPHA_FAMILY / n).toExponential(3),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────

const HELP = `
atr_replay.mjs ${VERSION} — read-only premium-ATR stop replay (GET only, no orders)

  --bot=v21|lab|both   which bot (default both)
  --dry-run            ZERO network calls; print the request plan
  --max-requests=N     hard global cap (default 2000)
  --timeout-ms=N       per-request timeout (default 10000)
  --out=PATH           results .json (.csv and .ckpt.json sit beside it)
  --limit=N            first N trades per bot (smoke test)
  --fresh              ignore an existing checkpoint
  --to-session-close   SECONDARY run: extend each window past the real exit
                       to the 14:55 CT force exit. Off by default; see the
                       asymmetry note in the plan before reading it.
  --key-env=NAME       API-key env var name (default ${DEFAULT_KEY_ENV})
  --secret-env=NAME    API-secret env var name (default ${DEFAULT_SECRET_ENV})
  --whoami             GET /v2/account; prints ONLY the last 4 of the
                       account number, to confirm which account is in use
  -h, --help           this text

Credentials are read from the environment and never printed or written.
`;

function parseArgs(argv) {
  const a = { bot: "both", dryRun: false, maxRequests: 2000, timeoutMs: 10000,
              out: "atr_replay_results.json", limit: 0, fresh: false,
              toSessionClose: false, whoami: false, help: false, keyEnv: null, secretEnv: null };
  for (const x of argv) {
    if (x === "--dry-run") a.dryRun = true;
    else if (x === "--fresh") a.fresh = true;
    else if (x === "--to-session-close") a.toSessionClose = true;
    else if (x === "--whoami") a.whoami = true;
    else if (x === "--help" || x === "-h") a.help = true;
    else if (x.startsWith("--bot=")) a.bot = x.slice(6);
    else if (x.startsWith("--max-requests=")) a.maxRequests = +x.slice(15);
    else if (x.startsWith("--timeout-ms=")) a.timeoutMs = +x.slice(13);
    else if (x.startsWith("--out=")) a.out = x.slice(6);
    else if (x.startsWith("--limit=")) a.limit = +x.slice(8);
    else if (x.startsWith("--key-env=")) a.keyEnv = x.slice(10);
    else if (x.startsWith("--secret-env=")) a.secretEnv = x.slice(13);
    else throw new Error(`unknown argument: ${x}`);
  }
  if (!["v21", "lab", "both"].includes(a.bot)) throw new Error(`--bot must be v21, lab or both`);
  return a;
}

async function runBot(bot, args, budget) {
  const cfg = BOTS[bot];
  if (!fs.existsSync(cfg.file)) { log(`[${bot}] cannot read ${cfg.file} — run this from the directory that holds it`); return null; }
  const { trades: all, excluded, total } = loadTrades(cfg.file);
  const trades = args.limit > 0 ? all.slice(0, args.limit) : all;

  const ckpt = `${args.out.replace(/\.json$/, "")}.${bot}.ckpt.json`;
  let done = {};
  if (!args.fresh && fs.existsSync(ckpt)) { try { done = JSON.parse(fs.readFileSync(ckpt, "utf8")); } catch { done = {}; } }
  const todo = trades.filter(r => !done[r.tradeId]);

  log(`\n[${bot}] ${cfg.file}: ${total} lines → ${all.length} replayable (excluded ${JSON.stringify(excluded)})`);
  log(`[${bot}] selected ${trades.length}, checkpointed ${Object.keys(done).length}, to fetch ${todo.length}`);
  log(`[${bot}] planned requests ≈ ${todo.length} (1 per trade + pagination), cap ${budget.max}`);
  if (args.dryRun) return { bot, dryRun: true, planned: todo.length };

  const keyEnv = args.keyEnv || DEFAULT_KEY_ENV, secretEnv = args.secretEnv || DEFAULT_SECRET_ENV;
  const key = process.env[keyEnv], secret = process.env[secretEnv];
  if (!key || !secret) { log(`[${bot}] refusing to run: ${keyEnv} and/or ${secretEnv} are not set`); return null; }
  registerSecrets(key, secret);
  const ctx = { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, budget, timeoutMs: args.timeoutMs };

  if (args.whoami) {
    const r = await getJson(`${TRADING_BASE}/v2/account`, ctx);
    log(r.error ? `[${bot}] whoami failed: ${r.error}`
               : `[${bot}] account ****${String(r.data.account_number || "").slice(-4)} status=${r.data.status}`);
  }

  for (let i = 0; i < todo.length; i++) {
    const r = todo[i], entryMs = Date.parse(r.entryTime);
    const startIso = new Date(entryMs - PRE_WINDOW_MIN * 60000).toISOString();
    const endIso = new Date((args.toSessionClose ? Math.max(Date.parse(r.exitTime), forceExitMs(entryMs)) : Date.parse(r.exitTime)) + 120000).toISOString();
    const ob = await fetchOptionBars(r.optionSymbol, startIso, endIso, ctx);
    if (ob.error) done[r.tradeId] = { tradeId: r.tradeId, day: r.day, symbol: r.symbol, fetchError: ob.error, preBars: 0, postBars: 0, arms: {} };
    else {
      const row = processTrade(r, ob.bars, cfg, { toSessionClose: args.toSessionClose });
      row._post = ob.bars.filter(b => b.ms >= entryMs && b.ms <= row.terminalMs);
      done[r.tradeId] = row;
    }
    if ((i + 1) % 25 === 0 || i === todo.length - 1) {
      fs.writeFileSync(ckpt, JSON.stringify(done));
      log(`[${bot}]   ${i + 1}/${todo.length}, ${budget.used} requests`);
    }
  }
  fs.writeFileSync(ckpt, JSON.stringify(done));

  const rows = trades.map(r => done[r.tradeId]).filter(Boolean);
  for (const r of rows) if (!r._post) r._post = [];
  const armIds = ["baseline", ...K_GRID.map(k => `k${k}`)];

  const cov = coverage(rows, trades.length, excluded);
  const g = gate(rows);
  const result = { bot, coverage: cov, gate: g, halted: !g.pass };
  if (g.pass) {
    // ONE ATR-eligible sample, computed once and reused by (c), (d) and
    // (e) alike, so every section is paired trade for trade.
    const st = armStats(rows, armIds);
    const common = st.common;
    delete st.common;
    result.arms = st;
    result.outOfSample = outOfSample(common, armIds);
    result.noise = noisePermuted(common, cfg);
    result.noiseUniformSecondary = noiseUniform(common, cfg, bot);
    result.correction = correction(bot);
    result.verdict = verdict(result);
  }
  result.rows = rows.map(({ _post, ...k }) => k);
  return result;
}

export function verdict(res) {
  const alpha = res.correction.alphaPerTest;
  const out = [];
  for (const [id, s] of Object.entries(res.arms.arms)) {
    if (id === "baseline") continue;
    // Each k is compared against ITS OWN permuted p95, not a shared one:
    // a tighter k has a different null distribution from a wider one.
    const own = res.noise?.[id];
    const beatsNoise = own ? s.meanDiff > own.p95 : false;
    const sig = s.p != null && s.p < alpha && s.ciExcludesZero;
    const held = res.outOfSample.chosenOnTrain === id && res.outOfSample.heldOutOfSample === true;
    out.push({
      arm: id, meanDiff: s.meanDiff, ownNoiseP95: own ? own.p95 : null,
      significantAfterCorrection: !!sig, beatsOwnNoiseP95: beatsNoise, heldOutOfSample: held,
      worthConsidering: !!(sig && beatsNoise && held),
    });
  }
  return { arms: out, anyWorthConsidering: out.some(x => x.worthConsidering) };
}

function printBot(res) {
  const B = "─".repeat(68);
  log(`\n${B}\n ${res.bot.toUpperCase()}\n${B}`);

  log(`\n(a) COVERAGE`);
  const c = res.coverage;
  log(`    selected from log: ${c.selected}   excluded from log: ${JSON.stringify(c.excludedFromLog)}`);
  log(`    fetched: ${c.fetched}   usable (bars + ATR): ${c.usable}`);
  log(`    missing: ${Object.keys(c.missing).length ? JSON.stringify(c.missing) : "nothing"}`);
  log(`    median pre-entry bars ${c.medianPreBars}, median in-trade bars ${c.medianPostBars}`);
  log(`    usable trades carrying pnlAtFill: ${c.withPnlAtFill}`);
  log(`    median ATR(14,1m) / entry premium: ${c.medianAtrOverEntry ?? "n/a"}`);

  log(`\n(b) BASELINE REPRODUCTION`);
  const g = res.gate;
  log(`    median |replay − recorded| / entry: ${g.exitError.median ?? "n/a"}  (tolerance ≤ ${g.exitError.tolerance}, n=${g.exitError.n})`);
  log(`    recorded stops confirmed by a bar low: ${g.stopCrossing.confirmed}/${g.stopCrossing.checked} = ${g.stopCrossing.rate ?? "n/a"}  (need ≥ ${g.stopCrossing.threshold})`);
  if (!g.pass) {
    log(`    ✖ GATE FAIL — the replay does not reproduce the current rule on this bot.`);
    log(`      The study STOPS here for ${res.bot}. Sections (c)–(f) are not reported,`);
    log(`      because an ATR comparison built on a replay that cannot reproduce today`);
    log(`      would be measuring the replay's errors, not the stop rule.`);
    return;
  }
  log(`    ✔ GATE PASS`);

  log(`\n(c) ATR RESULTS PER k   (ATR(${ATR_LEN}) on ${ATR_TIMEFRAME} bars before entry)`);
  log(`    CI and p are a DAY-CLUSTER bootstrap: trading days resampled whole, ${BOOTSTRAP_N} draws.`);
  log(`    ${"arm".padEnd(10)}${"n".padStart(5)}${"days".padStart(6)}${"WR%".padStart(7)}${"mean$".padStart(9)}${"net$".padStart(10)}${"Δ base".padStart(9)}${"95% CI".padStart(18)}${"p".padStart(9)}${"stopped".padStart(9)}`);
  for (const [id, s] of Object.entries(res.arms.arms)) {
    const ci = s.ci95 ? `[${s.ci95.lo}, ${s.ci95.hi}]` : "";
    log(`    ${id.padEnd(10)}${String(s.n).padStart(5)}${String(s.clusters ?? "—").padStart(6)}${String(s.winRate ?? "").padStart(7)}${String(s.meanPerCt ?? "").padStart(9)}` +
        `${String(s.netPerCt ?? "").padStart(10)}${String(id === "baseline" ? "—" : s.meanDiff).padStart(9)}${ci.padStart(18)}` +
        `${String(id === "baseline" ? "—" : s.p).padStart(9)}${String(s.stoppedEarly).padStart(9)}`);
  }

  log(`\n(d) OUT-OF-SAMPLE   (chronological ${Math.round(TRAIN_FRACTION * 100)}/${100 - Math.round(TRAIN_FRACTION * 100)} on DAY boundaries, k picked on train only)`);
  const o = res.outOfSample;
  if (o.error) log(`    ${o.error}`);
  else {
    log(`    train ${o.trainN} trades over ${o.trainDays} days | test ${o.testN} trades over ${o.testDays} days, starting ${o.splitAtDay}`);
    log(`    train mean Δ by k: ${JSON.stringify(o.trainMeanDiffByK)}  → chose ${o.chosenOnTrain}`);
    log(`    test mean Δ ${o.testMeanDiff}  day-cluster CI ${o.testCi95 ? `[${o.testCi95.lo}, ${o.testCi95.hi}]` : "n/a"}  p ${o.testP}  (${o.testClusters} day clusters)`);
    log(`    held out of sample: ${o.heldOutOfSample ? "yes" : "no"}`);
  }

  log(`\n(e) NOISE BASELINE — PERMUTATION, PER k`);
  log(`    Each k's own per-trade distances k×ATR/entry are permuted across trades,`);
  log(`    ${NOISE_DRAWS} draws: same spread of tightness, trade-specific information destroyed.`);
  log(`    ${"arm".padEnd(10)}${"median dist%".padStart(14)}${"p5".padStart(9)}${"p50".padStart(9)}${"p95".padStart(9)}${"actual Δ".padStart(10)}${"beats p95".padStart(11)}`);
  for (const k of K_GRID) {
    const id = `k${k}`, nz = res.noise?.[id], s = res.arms.arms[id];
    if (!nz || !s) continue;
    log(`    ${id.padEnd(10)}${String(nz.medianPctDistance).padStart(14)}${String(nz.p5).padStart(9)}${String(nz.p50).padStart(9)}` +
        `${String(nz.p95).padStart(9)}${String(s.meanDiff).padStart(10)}${(s.meanDiff > nz.p95 ? "yes" : "no").padStart(11)}`);
  }
  log(`    An arm that cannot beat its OWN p95 is measuring the tightness level alone,`);
  log(`    which is a fixed-% stop by another name — the ATR adds nothing.`);
  const nu = res.noiseUniformSecondary;
  if (nu) log(`    [secondary, not used by the verdict] uniform band ${nu.rangePct[0]}%..${nu.rangePct[1]}%: p5 ${nu.p5}  p50 ${nu.p50}  p95 ${nu.p95}`);

  log(`\n(f) MULTIPLE-HYPOTHESIS CORRECTION`);
  const f = res.correction;
  log(`    tests in this study: ${f.thisStudy};  applied count for ${res.bot}: ${f.appliedCount}`);
  log(`    ${f.note}`);
  log(`    Bonferroni α = ${f.alphaFamily} / ${f.appliedCount} = ${f.alphaPerTest}`);

  log(`\n    VERDICT (CI excludes zero after correction AND beats its OWN permuted p95 AND holds out-of-sample)`);
  for (const v of res.verdict.arms) {
    log(`      ${v.arm.padEnd(8)} Δ ${String(v.meanDiff).padStart(8)} vs own p95 ${String(v.ownNoiseP95).padStart(8)}   ` +
        `corrected:${v.significantAfterCorrection ? "yes" : "no "}  ` +
        `beats-own-noise:${v.beatsOwnNoiseP95 ? "yes" : "no "}  out-of-sample:${v.heldOutOfSample ? "yes" : "no "}  ` +
        `⇒ ${v.worthConsidering ? "WORTH CONSIDERING" : "not supported"}`);
  }
  log(`    ${res.verdict.anyWorthConsidering ? "At least one arm clears every bar." : "No arm clears the evidence bar. No change is justified by this data."}`);
}

function writeCsv(path, results) {
  const armIds = ["baseline", ...K_GRID.map(k => `k${k}`)];
  const cols = ["bot", "day", "symbol", "optionSymbol", "signal", "entryTime", "exitTime", "entry", "realExit",
    "realReason", "realPnlPerCt", "hasPnlAtFill", "liveStop", "atrPre", "atrOverEntry", "preBars", "postBars", "crossing",
    ...armIds.flatMap(a => [`${a}_pnl`, `${a}_reason`])];
  const lines = [cols.join(",")];
  for (const res of results) {
    if (!res) continue;
    for (const r of res.rows) {
      const v = { bot: res.bot, ...r };
      for (const a of armIds) { v[`${a}_pnl`] = r.arms?.[a]?.pnlPerCt ?? ""; v[`${a}_reason`] = r.arms?.[a]?.reason ?? r.arms?.[a]?.skipped ?? ""; }
      lines.push(cols.map(c => {
        const x = v[c];
        if (x == null) return "";
        const s = typeof x === "number" ? (Number.isInteger(x) ? String(x) : x.toFixed(4)) : String(x);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","));
    }
  }
  fs.writeFileSync(path, lines.join("\n") + "\n");
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { log(e.message, HELP); process.exitCode = 2; return; }
  if (args.help) { log(HELP); return; }

  log(`atr_replay ${VERSION}`);
  log(`PRE-DECLARED: ATR(${ATR_LEN}) on ${ATR_TIMEFRAME} option bars before entry; k ∈ {${K_GRID.join(", ")}}`);
  log(`PRE-DECLARED: gate ≤ ${GATE.maxMedianExitError} median exit error AND ≥ ${GATE.minStopCrossingConfirmed} stop crossings confirmed`);
  log(`PRE-DECLARED: ${HYPOTHESES_THIS_STUDY} tests here; LAB corrected against ${HYPOTHESES_LAB_CUMULATIVE} cumulative`);
  log(`window: entry → ${args.toSessionClose ? "FORCE EXIT (secondary run)" : "actual recorded exit"}`);

  const budget = new Budget(args.maxRequests);
  const bots = args.bot === "both" ? ["v21", "lab"] : [args.bot];
  const results = [];
  try {
    for (const b of bots) results.push(await runBot(b, args, budget));
  } catch (e) {
    log(`\nstopped: ${e.message}`);
    log(`checkpoints are written — rerun the same command to resume`);
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const planned = results.filter(Boolean).reduce((a, r) => a + (r.planned || 0), 0);
    log(`\n--dry-run: no network calls were made, nothing was written. Total planned requests ≈ ${planned}, cap ${args.maxRequests}.`);
    if (planned > args.maxRequests) log(`WARNING: the plan exceeds the cap — raise --max-requests or use --limit`);
    return;
  }

  // If every bot was refused (missing credentials, missing outcomes file)
  // there is nothing to report, and writing an empty "results" file would
  // be worse than writing none — it looks like a completed study.
  if (!results.some(Boolean)) {
    log(`\nno bot produced a result — nothing was written. See the refusals above.`);
    process.exitCode = 2;
    return;
  }

  for (const r of results) if (r) printBot(r);

  const meta = { version: VERSION, generatedAt: new Date().toISOString(), argv: process.argv.slice(2),
                 atrLen: ATR_LEN, atrTimeframe: ATR_TIMEFRAME, kGrid: K_GRID, gate: GATE,
                 windowToSessionClose: args.toSessionClose, requestsUsed: budget.used, requestCap: args.maxRequests };
  fs.writeFileSync(args.out, JSON.stringify({ meta, results }, null, 2));
  const csv = `${args.out.replace(/\.json$/, "")}.csv`;
  writeCsv(csv, results.filter(Boolean));
  log(`\nwrote ${args.out} and ${csv}  (${budget.used} requests used)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch(e => { log("fatal:", e.message); process.exitCode = 1; });
}
