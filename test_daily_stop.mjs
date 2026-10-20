// ============================================================
// TIER-1 DAILY STOP + PROFIT FLOOR — TEST SUITE. No network, no keys.
//
// Every function and inline block under test is EXTRACTED BY TEXT from
// the real scan_v21.js / scan_lab.js and run against a stubbed fs,
// stubbed quote fetch and stubbed order POST. If a regex stops matching,
// the suite throws instead of silently testing nothing.
//
// Two deliberate choices about the baseline:
//   * BASE_SHA is PINNED. origin/main moves every few minutes (the
//     container commits state), so a moving baseline would make this
//     suite's regression checks non-reproducible.
//   * The previous getTodayRealizedPnl() is embedded below as a FROZEN
//     LITERAL rather than extracted from git, so the regression compares
//     against a fixed, reviewable definition that cannot drift.
//
// Run:  node test_daily_stop.mjs
// ============================================================
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const BASE_SHA = "042bd24a337a57339b687a603eca5cdfa5409337";
const FILES = { v21: "scan_v21.js", lab: "scan_lab.js" };
const OUTCOMES = { v21: "outcomes_v21.jsonl", lab: "outcomes_lab.jsonl" };
const lf = s => s.replace(/\r\n/g, "\n");

const src = {}, base = {};
for (const [bot, file] of Object.entries(FILES)) {
  src[bot]  = lf(fs.readFileSync(file, "utf8"));
  base[bot] = lf(execFileSync("git", ["show", `${BASE_SHA}:${file}`], { maxBuffer: 1 << 28 }).toString());
}

// ── the FROZEN previous implementation, verbatim from BASE_SHA ──
const FROZEN_OLD_PNL = bot => `
function getTodayRealizedPnl() {
  const today = getToday();
  let total = 0;
  try {
    const lines = fs.readFileSync("outcomes_${bot === "v21" ? "v21" : "lab"}.jsonl", "utf8").split("\\n").filter(Boolean);
    for (const line of lines) {
      try { const r = JSON.parse(line); if (r.day === today) total += r.pnl; } catch {}
    }
  } catch {}
  return total;
}`;

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function capture(fn) {
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: fn(), lines }; }
  finally { Object.assign(console, orig); }
}
async function captureAsync(fn) {
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: await fn(), lines }; }
  catch (e) { return { out: undefined, err: e, lines }; }
  finally { Object.assign(console, orig); }
}

// ════════════════════════════════════════════════════════════
// Extraction
// ════════════════════════════════════════════════════════════
const RE = {
  day:     /function getTodayRealizedDay\(\) \{[\s\S]*?\n\}/,
  wrap:    /function getTodayRealizedPnl\(\) \{ return getTodayRealizedDay\(\)\.net; \}/,
  readPk:  /function readDayPeak\(\) \{[\s\S]*?\n\}/,
  bumpPk:  /function bumpDayPeak\(candidate\) \{[\s\S]*?\n\}/,
  legs:    /async function getQuoteLegs\(optSym\) \{[\s\S]*?\n\}/,
  gate:    /if \(dayCtx\?\.armed\) \{[\s\S]*?\n    qty = sized;\n  \}/,
  logLine: /console\.log\(`\[(?:v21|LAB) day\][\s\S]*?loss_stopped=\$\{realizedDay\.stopped \? realizedDay\.reason : "no"\}`\);/,
  ctx:     /const realizedDay = getTodayRealizedDay\(\);\n  const dayTotal[\s\S]*?\n  \};/,
  loss:    /const STOP_DAY_LOSS\s*=\s*-?\d+;/,
  floor:   /const PROFIT_FLOOR\s*=\s*-?\d+;/,
  enabled: /const PROFIT_FLOOR_ENABLED = (true|false);/,
  pad:     /const STOP_SLIPPAGE_PAD\s*=\s*[\d.]+;/,
  pkFile:  /const DAYPEAK_FILE\s*=\s*"daypeak_(?:v21|lab)\.json";/,
  pfFn:    /function profitFloor\(_peakTotal\) \{ return PROFIT_FLOOR; \}/,
  expiry:  /function optionExpiryISO\(optSym\) \{[\s\S]*?\n\}/,
  f2:      /if \(PROFIT_FLOOR_ENABLED && dayCtx\?\.trusted === false\) \{[\s\S]*?\n  \}/,
  // Must reach through the else{} block: a non-greedy match stopping at the
  // first 10-space `}` truncates after the expired branch and would test
  // only half the logic (it did, until this was corrected).
  sumLoop: /\/\/ The ticker filter above says[\s\S]*?unrealIntraday \+= uplIntra;\n          \}/,
};

const CONSTS = bot => [
  grab(src[bot], RE.loss, `STOP_DAY_LOSS/${bot}`),
  grab(src[bot], RE.floor, `PROFIT_FLOOR/${bot}`),
  grab(src[bot], RE.enabled, `PROFIT_FLOOR_ENABLED/${bot}`),
  grab(src[bot], RE.pad, `STOP_SLIPPAGE_PAD/${bot}`),
  grab(src[bot], RE.pfFn, `profitFloor/${bot}`),
].join("\n");

function makeDay(bot, fileText, today = "2026-10-20") {
  const fsStub = { readFileSync: () => { if (fileText === null) throw new Error("ENOENT"); return fileText; } };
  return new Function("fs", "getToday",
    `${CONSTS(bot)}\n${grab(src[bot], RE.day, `day/${bot}`)}\n${grab(src[bot], RE.wrap, `wrap/${bot}`)}\n` +
    `return { getTodayRealizedDay, getTodayRealizedPnl };`)(fsStub, () => today);
}

// The frozen previous implementation, same fake fs.
function makeOld(bot, fileText, today = "2026-10-20") {
  const fsStub = { readFileSync: () => { if (fileText === null) throw new Error("ENOENT"); return fileText; } };
  return new Function("fs", "getToday", `${FROZEN_OLD_PNL(bot)}\nreturn getTodayRealizedPnl;`)(fsStub, () => today);
}

// readDayPeak / bumpDayPeak against the REAL fs, with DAYPEAK_FILE
// pointed at a scratch path — this is the only way to exercise the
// tmp+rename path honestly.
function makePeak(bot, file, today = "2026-10-20") {
  return new Function("fs", "getToday", "DAYPEAK_FILE",
    `${CONSTS(bot)}\n${grab(src[bot], RE.readPk, `readPk/${bot}`)}\n${grab(src[bot], RE.bumpPk, `bumpPk/${bot}`)}\n` +
    `return { readDayPeak, bumpDayPeak };`)(fs, () => today, file);
}

// optionExpiryISO, extracted verbatim.
const makeExpiry = bot =>
  new Function(`${grab(src[bot], RE.expiry, `expiry/${bot}`)}\nreturn optionExpiryISO;`)();

// The reconcile unrealised-sum loop body, lifted verbatim and driven with a
// list of fake positions — so the exclusion logic under test is the shipped
// text, not a restatement of it.
function runSumLoop(bot, positions, today = "2026-10-20") {
  const body = grab(src[bot], RE.sumLoop, `sumLoop/${bot}`);
  const v = bot === "v21" ? "pos" : "p";
  return new Function("positions", "getToday", "optionExpiryISO",
    `let unrealPl = 0, unrealIntraday = 0, exclN = 0, exclPl = 0, unparsedN = 0;
     for (const ${v} of positions) {
       ${body}
     }
     return { unrealPl, unrealIntraday, exclN, exclPl, unparsedN };`
  )(positions, () => today, makeExpiry(bot));
}

// The F2 early guard, lifted verbatim.
function runF2(bot, { enabled, dayCtx }) {
  const body = grab(src[bot], RE.f2, `f2/${bot}`);
  return new Function("PROFIT_FLOOR_ENABLED", "dayCtx", "symbol",
    `${body}\nreturn "continued";`)(enabled, dayCtx, "SPY");
}

// The gate block, lifted verbatim, with everything it touches stubbed.
function makeGate(bot, { dayCtx, premium, legs, calcQtyResult }) {
  const pctExpr = bot === "v21" ? "HARD_STOP_PCT/100" : "strategy.params.stopLossPct / 100";
  const legsCalls = [];
  const posts = [];
  const body = grab(src[bot], RE.gate, `gate/${bot}`);
  const fn = new Function(
    "dayCtx", "symbol", "opt", "qtyIn", "getQuoteLegs", "postOrder", "HARD_STOP_PCT", "strategy", "STOP_SLIPPAGE_PAD",
    `return (async () => {
       let qty = qtyIn;
       ${body}
       postOrder(qty);
       return { qty, skipped: false };
     })().catch(e => { throw e; });`
  );
  // The gate's early returns return undefined; wrap to detect them.
  const wrapped = new Function(
    "dayCtx", "symbol", "opt", "qtyIn", "getQuoteLegs", "postOrder", "HARD_STOP_PCT", "strategy", "STOP_SLIPPAGE_PAD",
    `return (async () => {
       let qty = qtyIn;
       ${body}
       postOrder(qty);
       return { qty, skipped: false };
     })();`
  );
  return {
    run: () => wrapped(
      dayCtx, "SPY",
      { symbol: "SPY261020P00600000", premium },
      calcQtyResult,
      async s => { legsCalls.push(s); return legs; },
      q => posts.push(q),
      -35,
      { params: { stopLossPct: -30 } },
      0.10,
    ).then(r => r ?? { skipped: true }),
    legsCalls, posts,
  };
}

const DAY = "2026-10-20";
function logOf(trades, { day = DAY, reverse = false, extraDays = [] } = {}) {
  const rows = trades.map((pnl, i) => ({
    day, tradeId: `SYM_${i}`, pnl,
    exitTime: new Date(Date.parse(`${day}T14:00:00Z`) + i * 60000).toISOString(),
  }));
  if (reverse) rows.reverse();
  return [...rows, ...extraDays].map(r => JSON.stringify(r)).join("\n") + "\n";
}
const otherDay = (day, pnl, i = 0) => ({
  day, tradeId: `OTHER_${day}_${i}`, pnl,
  exitTime: new Date(Date.parse(`${day}T14:00:00Z`) + i * 60000).toISOString(),
});

const LIMITS = { v21: { loss: -280, floor: 170, pct: -35 }, lab: { loss: -500, floor: 300, pct: -30 } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "daypeak-"));

console.log("\n═══════════════════════════════════════════════════════════");
console.log(" TIER-1 DAILY STOP + PROFIT FLOOR — no network, no keys");
console.log(`  pinned base: ${BASE_SHA.slice(0, 12)}   old impl: frozen literal`);
console.log("═══════════════════════════════════════════════════════════");

// ── A) constants / profitFloor ────────────────────────────
console.log("\n── A) الثوابت و profitFloor ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  check(`${bot}: STOP_DAY_LOSS = ${L.loss}`, new RegExp(`=\\s*${L.loss};`).test(grab(src[bot], RE.loss)), grab(src[bot], RE.loss), L.loss);
  check(`${bot}: PROFIT_FLOOR = ${L.floor}`, new RegExp(`=\\s*${L.floor};`).test(grab(src[bot], RE.floor)), grab(src[bot], RE.floor), L.floor);
  check(`${bot}: PROFIT_FLOOR_ENABLED = true`, /= true;/.test(grab(src[bot], RE.enabled)), grab(src[bot], RE.enabled), "true");
  check(`${bot}: STOP_SLIPPAGE_PAD = 0.10`, /=\s*0\.10;/.test(grab(src[bot], RE.pad)), grab(src[bot], RE.pad), "0.10");
  check(`${bot}: DAYPEAK_FILE = daypeak_${bot === "v21" ? "v21" : "lab"}.json`,
    grab(src[bot], RE.pkFile).includes(`daypeak_${bot === "v21" ? "v21" : "lab"}.json`), grab(src[bot], RE.pkFile), bot);
  const pf = new Function(`${CONSTS(bot)}\nreturn profitFloor;`)();
  check(`${bot}: profitFloor() ثابت لأي مُدخل (ratchet-ready)`,
    pf(0) === L.floor && pf(99999) === L.floor && pf(undefined) === L.floor, pf(99999), L.floor);
  check(`${bot}: لا أثر لـ PROFIT_ARM / PROFIT_GIVEBACK`,
    !/PROFIT_ARM|PROFIT_GIVEBACK/.test(src[bot]), "still present", "removed");
  check(`${bot}: لا نص "حماية الربح" في أي تنبيه`, !/حماية الربح/.test(src[bot]), "present", "absent");
}
check("lab: ثوابت الأرضية داخل كتلة HARD SAFETY LIMITS",
  /HARD SAFETY LIMITS[\s\S]*?const PROFIT_FLOOR\s*=[\s\S]*?const MARKET_OPEN_UTC/.test(src.lab), "outside", "inside");

// ── B) loss stop (kept from tier 1) ───────────────────────
console.log("\n── B) حدّ الخسارة المحقق (بقي كما هو) ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  const at = makeDay(bot, logOf([L.loss])).getTodayRealizedDay();
  check(`${bot}: net == ${L.loss} ⇒ متوقف (loss)`, at.stopped && at.reason === "loss", at, { stopped: true, reason: "loss" });
  const just = makeDay(bot, logOf([L.loss + 1])).getTodayRealizedDay();
  check(`${bot}: net == ${L.loss + 1} ⇒ غير متوقف`, just.stopped === false && just.reason === null, just, { stopped: false });
  const sticky = makeDay(bot, logOf([L.loss, 900])).getTodayRealizedDay();
  check(`${bot}: لاصق — خسارة ثم تعافٍ ⇒ ما زال متوقفاً`, sticky.stopped && sticky.reason === "loss", sticky, { stopped: true });
  const prof = makeDay(bot, logOf([L.floor + 50, -20])).getTodayRealizedDay();
  check(`${bot}: يوم رابح لا يُوقفه حدّ الخسارة`, prof.stopped === false, prof, { stopped: false });
  const miss = makeDay(bot, null).getTodayRealizedDay();
  check(`${bot}: سجل غير مقروء ⇒ أصفار (يفشل مفتوحاً)`,
    eq(miss, { net: 0, peak: 0, stopped: false, reason: null }), miss, "zeros");
  const rev = makeDay(bot, logOf([L.loss, 900], { reverse: true })).getTodayRealizedDay();
  check(`${bot}: ترتيب الملف معكوساً ⇒ نفس النتيجة`, eq(rev, sticky), rev, sticky);
  const other = makeDay(bot, logOf([10], { extraDays: [otherDay("2026-10-19", -9999)] })).getTodayRealizedDay();
  check(`${bot}: أيام أخرى تُتجاهل`, other.net === 10, other, { net: 10 });
}

// ── C) peak file ──────────────────────────────────────────
console.log("\n── C) ملف القمة (daypeak) ──");
for (const bot of ["v21", "lab"]) {
  const f = path.join(TMP, `pk_${bot}.json`);
  try { fs.unlinkSync(f); } catch {}
  const pk = makePeak(bot, f);

  check(`${bot}: ملف غير موجود ⇒ القمة 0 (متسامح)`, pk.readDayPeak().peakTotal === 0, pk.readDayPeak(), 0);
  check(`${bot}: أول bump يكتب 390`, pk.bumpDayPeak(390) === 390 && pk.readDayPeak().peakTotal === 390, pk.readDayPeak(), 390);
  // 11) lower write rejected
  check(`${bot}: كتابة أدنى (350) مرفوضة — الملف يبقى 390`,
    pk.bumpDayPeak(350) === 390 && pk.readDayPeak().peakTotal === 390, pk.readDayPeak(), 390);
  check(`${bot}: مساوٍ (390) لا يكتب`, pk.bumpDayPeak(390) === 390, pk.readDayPeak(), 390);
  check(`${bot}: أعلى (500) يرفع`, pk.bumpDayPeak(500) === 500, pk.readDayPeak(), 500);
  check(`${bot}: NaN لا يكتب ولا يرمي`, pk.bumpDayPeak(NaN) === 500, pk.readDayPeak(), 500);
  // 12) stale file from a previous day ignored
  fs.writeFileSync(f, JSON.stringify({ day: "2026-10-17", peakTotal: 9999 }));
  check(`${bot}: ملف بيوم سابق ⇒ القمة 0 (لا يُسلّح)`, pk.readDayPeak().peakTotal === 0, pk.readDayPeak(), 0);
  // Post-F3 the candidate must reach the floor to be written at all, so the
  // rewrite is driven with the floor itself rather than an arbitrary 42.
  const F0 = LIMITS[bot].floor;
  check(`${bot}: ثم bump عند الأرضية يكتب يوم اليوم`,
    pk.bumpDayPeak(F0) === F0 && JSON.parse(fs.readFileSync(f, "utf8")).day === "2026-10-20",
    JSON.parse(fs.readFileSync(f, "utf8")), { day: "2026-10-20", peakTotal: F0 });
  check(`${bot}: وملف بيوم سابق + مرشّح تحت الأرضية ⇒ لا كتابة`, (() => {
    fs.writeFileSync(f, JSON.stringify({ day: "2026-10-17", peakTotal: 9999 }));
    const before = fs.readFileSync(f, "utf8");
    pk.bumpDayPeak(F0 - 1);
    return fs.readFileSync(f, "utf8") === before;
  })(), "file rewritten", "untouched");
  // 13) malformed
  fs.writeFileSync(f, "{not json");
  check(`${bot}: ملف تالف ⇒ القمة 0 بلا رمي`, pk.readDayPeak().peakTotal === 0, pk.readDayPeak(), 0);
  fs.writeFileSync(f, JSON.stringify({ day: "2026-10-20", peakTotal: "high" }));
  check(`${bot}: peakTotal غير رقمي ⇒ 0`, pk.readDayPeak().peakTotal === 0, pk.readDayPeak(), 0);
  // 14) tmp + rename
  check(`${bot}: الكتابة عبر tmp ثم rename`,
    /\.tmp`;/.test(grab(src[bot], RE.bumpPk)) && /renameSync/.test(grab(src[bot], RE.bumpPk)), "no tmp/rename", "tmp + rename");
  check(`${bot}: مفتاح اليوم هو getToday() نفسه (لا حساب تاريخ جديد)`,
    /d\.day === getToday\(\)/.test(grab(src[bot], RE.readPk)) &&
    /day: getToday\(\)/.test(grab(src[bot], RE.bumpPk)) &&
    !/toLocaleDateString|Intl\.|America\/Chicago/.test(grab(src[bot], RE.readPk) + grab(src[bot], RE.bumpPk)),
    "other date source", "getToday()");
}
// 9) the defect this file exists to fix, and 10) that it is fixed
console.log("\n── C2) النسيان بين الدورات: العيب والإصلاح ──");
for (const bot of ["v21", "lab"]) {
  const L = LIMITS[bot];
  const armedFrom = (peak, total) => (peak >= L.floor || total >= L.floor);
  check(`${bot}: بلا ملف — دورة N total ${L.floor + 90} تُسلّح، دورة N+1 total ${L.floor - 50} تنسى (العيب)`,
    armedFrom(0, L.floor + 90) === true && armedFrom(0, L.floor - 50) === false, "n/a", "defect reproduced");
  const f = path.join(TMP, `fix_${bot}.json`);
  try { fs.unlinkSync(f); } catch {}
  const pk = makePeak(bot, f);
  pk.bumpDayPeak(L.floor + 90);                       // cycle N, scan child
  const peakNext = pk.readDayPeak().peakTotal;        // cycle N+1, fresh process
  check(`${bot}: بالملف — دورة N+1 ما زالت مُسلَّحة (peak=${peakNext})`,
    armedFrom(peakNext, L.floor - 50) === true, { peakNext }, "armed");
}
// 15) monitor child must not write / 7) untrusted must not bump
console.log("\n── C3) مَن يكتب القمة ──");
for (const bot of ["v21", "lab"]) {
  const ctx = grab(src[bot], RE.ctx, `ctx/${bot}`);
  check(`${bot}: bumpDayPeak مشروط بـ positionsTrusted && MODE !== "monitor"`,
    /positionsTrusted && MODE !== "monitor"\)\n\s*\? bumpDayPeak\(dayTotal\)/.test(ctx), ctx.slice(0, 200), "guarded bump");
  check(`${bot}: وإلا يقرأ فقط (readDayPeak)`, /: readDayPeak\(\)\.peakTotal;/.test(ctx), "no read fallback", "readDayPeak");
}

// ── D) gate + sizing with the REAL stop price ─────────────
console.log("\n── D) البوابة والتحجيم بسعر الوقف الحقيقي ──");
{
  // v21: mid 1.00 -> stopPlaced = max(0.01, 0.65) = 0.65 ; ask 1.05
  // maxLoss/ct = 100*(1.05-0.65)*1.10 = 44.00   (NOT 100*1.05*0.35 = 36.75)
  const g = makeGate("v21", {
    dayCtx: { armed: true, trusted: true, budget: 100, total: 270, peak: 270, floor: 170 },
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 4,
  });
  const r = await captureAsync(() => g.run());
  const line = r.lines.find(l => l.includes("maxLoss/ct")) || "";
  check("v21: maxLoss/ct = $44.00 بسعر الوقف الحقيقي (لا $36.75)", line.includes("$44.00"), line, "$44.00");
  check("v21: budget 100 / 44 ⇒ allowed 2، qty 4 → 2", r.out.qty === 2 && g.posts[0] === 2, { qty: r.out?.qty, posts: g.posts }, 2);
}
{
  // LAB: mid 1.00 -> stopPlaced 0.70 ; ask 1.05 -> 100*(1.05-0.70)*1.10 = 38.50
  const g = makeGate("lab", {
    dayCtx: { armed: true, trusted: true, budget: 100, total: 400, peak: 400, floor: 300 },
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 5,
  });
  const r = await captureAsync(() => g.run());
  const line = r.lines.find(l => l.includes("maxLoss/ct")) || "";
  check("lab: maxLoss/ct = $38.50 (وقف -30%)", line.includes("$38.50"), line, "$38.50");
  check("lab: budget 100 / 38.5 ⇒ allowed 2", r.out.qty === 2, r.out?.qty, 2);
}
{
  // the 0.01 clamp: mid 0.02 -> round2(0.013) = 0.01 -> max(0.01,0.01) = 0.01
  const g = makeGate("v21", {
    dayCtx: { armed: true, trusted: true, budget: 1000, total: 1170, peak: 1170, floor: 170 },
    premium: 0.02, legs: { ask: 0.03, bid: 0.01, mid: 0.02 }, calcQtyResult: 50,
  });
  const r = await captureAsync(() => g.run());
  const line = r.lines.find(l => l.includes("maxLoss/ct")) || "";
  check("v21: قيد 0.01 — الوقف 0.01 والمخاطرة ≈ (ask-0.01)*100*1.1 = $2.20", line.includes("stop 0.01") && line.includes("$2.20"), line, "stop 0.01 / $2.20");
}
{
  const g = makeGate("v21", {
    dayCtx: { armed: true, trusted: true, budget: 0, total: 170, peak: 170, floor: 170 },
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 4,
  });
  const r = await captureAsync(() => g.run());
  check("v21: total == floor بالضبط ⇒ budget 0 ⇒ تخطٍّ، لا أمر شراء",
    r.out.skipped === true && g.posts.length === 0, { out: r.out, posts: g.posts }, "skipped");
}
{
  const g = makeGate("v21", {
    dayCtx: { armed: true, trusted: true, budget: 20, total: 190, peak: 300, floor: 170 },
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 4,
  });
  const r = await captureAsync(() => g.run());
  check("v21: budget 20 < maxLoss 44 ⇒ ولا عقد واحد يُناسب ⇒ تخطٍّ",
    r.out.skipped === true && g.posts.length === 0, { out: r.out, posts: g.posts }, "skipped");
}
{
  const g = makeGate("v21", {
    dayCtx: { armed: true, trusted: true, budget: 10000, total: 10170, peak: 10170, floor: 170 },
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 4,
  });
  const r = await captureAsync(() => g.run());
  check("v21: ميزانية وفيرة ⇒ qty يبقى 4 (لا يزيد أبداً)", r.out.qty === 4, r.out?.qty, 4);
}
// 20) NOT armed -> no legs call, qty untouched
console.log("\n── D2) غير مُسلَّح ⇒ لا نداء ask ولا تغيير ──");
for (const bot of ["v21", "lab"]) {
  const g = makeGate(bot, {
    dayCtx: { armed: false, trusted: true, budget: 0, total: -50, peak: 10, floor: LIMITS[bot].floor },
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 7,
  });
  const r = await captureAsync(() => g.run());
  check(`${bot}: غير مُسلَّح ⇒ getQuoteLegs لم تُستدعَ إطلاقاً`, g.legsCalls.length === 0, g.legsCalls, []);
  check(`${bot}: غير مُسلَّح ⇒ qty == calcQty بالضبط`, r.out.qty === 7 && g.posts[0] === 7, { qty: r.out?.qty }, 7);
  const g2 = makeGate(bot, {
    dayCtx: undefined,
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 7,
  });
  const r2 = await captureAsync(() => g2.run());
  check(`${bot}: dayCtx غير مُمرَّر (undefined) ⇒ البوابة خاملة`, r2.out.qty === 7 && g2.legsCalls.length === 0, r2.out?.qty, 7);
}
// PROFIT_FLOOR_ENABLED=false -> armed is false by construction
console.log("\n── D3) PROFIT_FLOOR_ENABLED = false ⇒ خامل تماماً ──");
for (const bot of ["v21", "lab"]) {
  const ctx = grab(src[bot], RE.ctx, `ctx/${bot}`);
  check(`${bot}: armed يشترط PROFIT_FLOOR_ENABLED`,
    /const armed = PROFIT_FLOOR_ENABLED && \(/.test(ctx), "not gated", "gated");
  const armedOf = new Function("PROFIT_FLOOR_ENABLED", "peakTotal", "dayTotal", "floorNow",
    `return PROFIT_FLOOR_ENABLED && (peakTotal >= floorNow || dayTotal >= floorNow);`);
  check(`${bot}: enabled=false مع قمة فوق الأرضية ⇒ غير مُسلَّح`,
    armedOf(false, 9999, 9999, LIMITS[bot].floor) === false, armedOf(false, 9999, 9999, LIMITS[bot].floor), false);
  check(`${bot}: enabled=true مع قمة فوق الأرضية ⇒ مُسلَّح`,
    armedOf(true, 9999, 0, LIMITS[bot].floor) === true, true, true);
  check(`${bot}: سطر اللوق يُطبع مهما كانت enabled`, /enabled=\$\{PROFIT_FLOOR_ENABLED \? "YES" : "NO"\}/.test(src[bot]), "missing", "present");
}

// ── E) fail-closed / fail-open directions ─────────────────
console.log("\n── E) اتجاه الفشل ──");
for (const bot of ["v21", "lab"]) {
  const g = makeGate(bot, {
    dayCtx: { armed: true, trusted: false, budget: 500, total: 700, peak: 700, floor: LIMITS[bot].floor },
    premium: 1.00, legs: { ask: 1.05, bid: 0.95, mid: 1.00 }, calcQtyResult: 4,
  });
  const r = await captureAsync(() => g.run());
  check(`${bot}: مُسلَّح + positions غير موثوق ⇒ تخطٍّ (fail closed) ولا نداء ask`,
    r.out.skipped === true && g.legsCalls.length === 0 && g.posts.length === 0, { out: r.out, legs: g.legsCalls }, "skipped");
  const g2 = makeGate(bot, {
    dayCtx: { armed: true, trusted: true, budget: 500, total: 700, peak: 700, floor: LIMITS[bot].floor },
    premium: 1.00, legs: null, calcQtyResult: 4,
  });
  const r2 = await captureAsync(() => g2.run());
  check(`${bot}: مُسلَّح + لا ask ⇒ تخطٍّ (fail closed)`,
    r2.out.skipped === true && g2.posts.length === 0, { out: r2.out }, "skipped");
  const legs = new Function("fetchWithTimeout", "ALPACA_KEY", "ALPACA_SECRET", "HEADERS",
    `${grab(src[bot], RE.legs, `legs/${bot}`)}\nreturn getQuoteLegs;`)(
      async () => ({ json: async () => ({ quotes: { X: { ap: 0, bp: 0 } } }) }), "k", "s", {});
  check(`${bot}: getQuoteLegs مع ask=0 ⇒ null`, (await legs("X")) === null, await legs("X"), null);
  const legs2 = new Function("fetchWithTimeout", "ALPACA_KEY", "ALPACA_SECRET", "HEADERS",
    `${grab(src[bot], RE.legs, `legs2/${bot}`)}\nreturn getQuoteLegs;`)(
      async () => { throw new Error("boom"); }, "k", "s", {});
  check(`${bot}: getQuoteLegs عند خطأ شبكي ⇒ null بلا رمي`, (await legs2("X")) === null, "threw", null);
}

// ── F) the stdout line ────────────────────────────────────
console.log("\n── F) سطر اللوق ──");
for (const bot of ["v21", "lab"]) {
  const line = grab(src[bot], RE.logLine, `log/${bot}`);
  for (const field of ["realized=", "unreal_pl=", "unreal_intraday=", "total=", "peak=", "floor=", "enabled=", "armed=", "budget=", "trusted=", "loss_stopped="]) {
    check(`${bot}: سطر اللوق يحمل ${field}`, line.includes(field), field, "present");
  }
  check(`${bot}: المجموعان كلاهما مسجَّلان`, line.includes("unreal_pl=") && line.includes("unreal_intraday="), "one only", "both");
  const ctx = grab(src[bot], RE.ctx, `ctx2/${bot}`);
  check(`${bot}: القرار يستخدم unrealPl فقط (لا intraday)`,
    /const dayTotal = realizedDay\.net \+ unrealPl;/.test(ctx) && !/unrealIntraday/.test(ctx), ctx.slice(0, 120), "unrealPl only");
}
check("v21: unrealized_intraday_pl مجموع للتسجيل فقط", /unrealIntraday \+= uplIntra;/.test(src.v21), "missing", "present");
check("lab: unrealized_intraday_pl مجموع للتسجيل فقط", /unrealIntraday \+= uplIntra;/.test(src.lab), "missing", "present");

// ── F1) expiry parsing and exclusion ─────────────────────
console.log("\n── F1) استبعاد العقود المنتهية من مجموع غير المحقق ──");
for (const bot of ["v21", "lab"]) {
  const exp = makeExpiry(bot);
  check(`${bot}: SPY261020P00600000 ⇒ 2026-10-20`, exp("SPY261020P00600000") === "2026-10-20", exp("SPY261020P00600000"), "2026-10-20");
  check(`${bot}: NVDA261017C00220000 ⇒ 2026-10-17`, exp("NVDA261017C00220000") === "2026-10-17", exp("NVDA261017C00220000"), "2026-10-17");
  check(`${bot}: رمز بلا تاريخ ⇒ null`, exp("WEIRD") === null && exp("") === null && exp(undefined) === null, exp("WEIRD"), null);

  const P = (symbol, upl, intra) => ({ symbol, unrealized_pl: String(upl), unrealized_intraday_pl: String(intra) });
  // today = 2026-10-20: 10-17 expired, 10-20 is 0DTE (kept), 10-22 future
  const r = runSumLoop(bot, [
    P("SPY261020P00600000", 40, 38),    // today, kept
    P("QQQ261022C00600000", 25, 20),    // future, kept
    P("NVDA261017C00220000", -90, 0),   // EXPIRED, excluded
    P("IWM261016P00240000", -15, 0),    // EXPIRED, excluded
    P("WEIRDSYMBOL", 7, 7),             // unparseable, kept + counted
  ]);
  check(`${bot}: المنتهية مُستبعدة من unrealPl (40+25+7 = 72)`, r.unrealPl === 72, r.unrealPl, 72);
  check(`${bot}: ومن unrealIntraday (38+20+7 = 65)`, r.unrealIntraday === 65, r.unrealIntraday, 65);
  check(`${bot}: excl_n = 2`, r.exclN === 2, r.exclN, 2);
  check(`${bot}: excl_pl = -105 (-90 + -15)`, r.exclPl === -105, r.exclPl, -105);
  check(`${bot}: unparsed_n = 1 والرمز محسوب داخل المجموع`, r.unparsedN === 1 && r.unrealPl === 72, { unparsedN: r.unparsedN }, 1);

  const kept = runSumLoop(bot, [P("SPY261020P00600000", 100, 90)]);
  check(`${bot}: عقد اليوم (0DTE) يُحتسب ولا يُستبعد`, kept.unrealPl === 100 && kept.exclN === 0, kept, { unrealPl: 100, exclN: 0 });
  const bad = runSumLoop(bot, [P("SPY261020P00600000", "n/a", "n/a")]);
  check(`${bot}: unrealized_pl غير رقمي ⇒ 0 بلا NaN`, bad.unrealPl === 0 && !Number.isNaN(bad.unrealPl), bad.unrealPl, 0);
  const badExcl = runSumLoop(bot, [P("NVDA261017C00220000", "n/a", "n/a")]);
  check(`${bot}: منتهٍ بقيمة غير رقمية ⇒ excl_n=1 و excl_pl=0`, badExcl.exclN === 1 && badExcl.exclPl === 0, badExcl, { exclN: 1, exclPl: 0 });

  check(`${bot}: سطر اللوق يحمل excl_n / excl_pl / unparsed_n`,
    ["excl_n=", "excl_pl=", "unparsed_n="].every(f => grab(src[bot], RE.logLine, "log").includes(f)), "missing", "all three");
  check(`${bot}: أساس اليوم في optionExpiryISO هو getToday()`,
    /expISO < getToday\(\)/.test(src[bot]) && !/toLocaleDateString|Intl\./.test(grab(src[bot], RE.expiry, "exp")), "other basis", "getToday()");
}

// ── F2) untrusted + not armed ⇒ skip ─────────────────────
console.log("\n── F2) لقطة غير موثوقة ⇒ تخطٍّ حتى بلا تسليح ──");
for (const bot of ["v21", "lab"]) {
  const r1 = capture(() => runF2(bot, { enabled: true, dayCtx: { trusted: false, armed: false } }));
  check(`${bot}: enabled + غير موثوق + غير مُسلَّح ⇒ يُرجِع (تخطٍّ)`, r1.out === undefined, r1.out, "undefined (returned)");
  check(`${bot}: ويسجّل السبب`, r1.lines.some(l => l.includes("untrusted") && l.includes("fail closed")), r1.lines, "logged");
  const r2 = capture(() => runF2(bot, { enabled: true, dayCtx: { trusted: true, armed: false } }));
  check(`${bot}: موثوق ⇒ يُكمل`, r2.out === "continued", r2.out, "continued");
  const r3 = capture(() => runF2(bot, { enabled: false, dayCtx: { trusted: false, armed: false } }));
  check(`${bot}: enabled=false ⇒ يُكمل (لا تغيير في السلوك)`, r3.out === "continued", r3.out, "continued");
  const r4 = capture(() => runF2(bot, { enabled: true, dayCtx: undefined }));
  check(`${bot}: dayCtx غير مُمرَّر ⇒ يُكمل (خامل)`, r4.out === "continued", r4.out, "continued");
  // placement: before any network call in scanEntry
  const fn = grab(src[bot], bot === "v21"
    ? /async function scanEntry\(state, symbol, portfolio, liveInAlpaca, dayCtx\) \{[\s\S]*?\n\}/
    : /async function scanEntry\(state, strategy, symbol, liveInAlpaca, dayCtx\) \{[\s\S]*?\n\}/, `scanEntry/${bot}`);
  const f2At = fn.indexOf("dayCtx?.trusted === false");
  const firstAwait = fn.search(/await (getBars|checkBreakout|getLatestPrice|alpaca|findOption|getQuoteLegs)/);
  check(`${bot}: حارس F2 قبل أول نداء شبكي`, f2At > -1 && firstAwait > -1 && f2At < firstAwait, { f2At, firstAwait }, "F2 first");
  check(`${bot}: التعليق لم يبقَ يدّعي التطابق التام بلا استثناء`,
    /EXCEPT when the positions snapshot/.test(fn), "stale claim", "corrected");
}

// ── F3) peak written only at/above the floor ─────────────
console.log("\n── F3) القمة تُكتب فقط عند الأرضية أو فوقها ──");
for (const bot of ["v21", "lab"]) {
  const F = LIMITS[bot].floor;
  const f = path.join(TMP, `f3_${bot}.json`);
  try { fs.unlinkSync(f); } catch {}
  const pk = makePeak(bot, f);
  check(`${bot}: تحت الأرضية (${F - 1}) ⇒ لا ملف`, pk.bumpDayPeak(F - 1) === 0 && !fs.existsSync(f), fs.existsSync(f), false);
  check(`${bot}: صفر ⇒ لا ملف`, pk.bumpDayPeak(0) === 0 && !fs.existsSync(f), fs.existsSync(f), false);
  check(`${bot}: سالب ⇒ لا ملف`, pk.bumpDayPeak(-500) === 0 && !fs.existsSync(f), fs.existsSync(f), false);
  check(`${bot}: عند الأرضية بالضبط (${F}) ⇒ يُكتب`, pk.bumpDayPeak(F) === F && fs.existsSync(f), pk.readDayPeak(), F);
  check(`${bot}: فوقها (${F + 120}) ⇒ يرتفع`, pk.bumpDayPeak(F + 120) === F + 120, pk.readDayPeak(), F + 120);
  check(`${bot}: ثم أدنى منها لكن فوق الأرضية ⇒ لا ينزل`, pk.bumpDayPeak(F + 10) === F + 120, pk.readDayPeak(), F + 120);
  check(`${bot}: ثم تحت الأرضية ⇒ لا ينزل ولا يكتب`, pk.bumpDayPeak(F - 999) === F + 120, pk.readDayPeak(), F + 120);
  check(`${bot}: التعليق يذكر أن peak يظهر +0 قبل بلوغ الأرضية`,
    /`peak` shows \+0 until the day's total first reaches the/.test(src[bot]), "missing note", "documented");
  check(`${bot}: bumpDayPeak يفحص الأرضية قبل الرتابة`,
    /if \(candidate < profitFloor\(candidate\)\) return cur\.peakTotal;/.test(grab(src[bot], RE.bumpPk, "bump")), "missing", "present");
}

// ── G) regressions ────────────────────────────────────────
console.log("\n── G) الانحدار ──");
for (const bot of ["v21", "lab"]) {
  const real = lf(fs.readFileSync(OUTCOMES[bot], "utf8"));
  const days = [...new Set(real.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l).day; } catch { return null; } }).filter(Boolean))].sort();
  let mismatch = 0;
  for (const d of days) if (makeDay(bot, real, d).getTodayRealizedPnl() !== makeOld(bot, real, d)()) mismatch++;
  check(`${bot}: الصافي مطابق للنسخة المجمَّدة على كل الأيام (${days.length} يوماً)`, mismatch === 0 && days.length > 0, { days: days.length, mismatch }, { mismatch: 0 });

  const TIER2 = bot === "v21"
    ? [["DAILY_LOSS_LIMIT", /const DAILY_LOSS_LIMIT\s*=\s*-600;/],
       ["force-close", /if \(getTodayRealizedPnl\(\) <= DAILY_LOSS_LIMIT\) \{\n    await closePosition\(state, symbol, pos, currentPremium, "daily_loss_breaker", "order_fill"\);\n    return;\n  \}/]]
    : [["MAX_DAILY_LOSS", /const MAX_DAILY_LOSS\s*=\s*1000;/],
       ["force-close", /if \(getTodayRealizedPnl\(\) <= -MAX_DAILY_LOSS\) \{\n    await closePosition\(state, symbol, pos, currentPremium, "daily_loss_breaker", "order_fill"\);\n    return;\n  \}/]];
  for (const [label, re] of TIER2) {
    check(`${bot}: tier-2 ${label} موجود في الأساس وفي الجديد`, re.test(src[bot]) && re.test(base[bot]), { now: re.test(src[bot]), old: re.test(base[bot]) }, "both");
  }
  for (const [label, re] of [
    ["alpaca()", /async function alpaca\([\s\S]*?\n\}/],
    ["getOwnedQty()", /async function getOwnedQty\([\s\S]*?\n\}/],
    ["getQuote()", /async function getQuote\(optSym\) \{[\s\S]*?\n\}/],
    ["monitorPosition()", /async function monitorPosition\([\s\S]*?\n\}/],
  ]) {
    check(`${bot}: ${label} مطابق للأساس حرفياً`, grab(src[bot], re, label) === grab(base[bot], re, `${label} base`), "changed", "identical");
  }
  check(`${bot}: monitorPosition لا يعرف شيئاً عن الأرضية`,
    !/PROFIT_FLOOR|dayCtx|getQuoteLegs|DAYPEAK/.test(grab(src[bot], /async function monitorPosition\([\s\S]*?\n\}/, "mp")), "knows", "clean");
}
const wv = lf(fs.readFileSync("scan_wvad.js", "utf8"));
check("wvad: غير معدَّل إطلاقاً", wv === lf(execFileSync("git", ["show", `${BASE_SHA}:scan_wvad.js`], { maxBuffer: 1 << 28 }).toString()), "changed", "identical");

// runner.js: ONLY the STATE_FILES line changed
const runNow = lf(fs.readFileSync("runner.js", "utf8"));
const runBase = lf(execFileSync("git", ["show", `${BASE_SHA}:runner.js`], { maxBuffer: 1 << 28 }).toString());
check("runner.js: daypeak_v21.json و daypeak_lab.json في STATE_FILES",
  /"daypeak_v21\.json", "daypeak_lab\.json",/.test(runNow), "missing", "present");
check("runner.js: لا شيء آخر تغيّر (بعد إزالة السطر الواحد يساوي الأساس)",
  runNow.replace('  "daypeak_v21.json", "daypeak_lab.json",\n', "") === runBase, "differs elsewhere", "identical");

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(` نجح ${pass} | فشل ${fail}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
process.exit(fail ? 1 : 0);
