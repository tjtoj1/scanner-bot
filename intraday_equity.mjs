// ============================================================
// INTRADAY EQUITY CURVE — READ-ONLY, GET ONLY
//
// Why this exists: every day-level number produced so far came from
// outcomes_*.jsonl, which holds CLOSED trades only. The live code has
// the same blind spot — getTodayRealizedPnl() sums the log, so a bot
// holding -$800 unrealised reads its own daily P&L as $0. This asks
// Alpaca for the equity curve itself, which marks open positions, and
// reports the intraday peak and trough each day actually saw.
//
// It issues GET requests only, reads no repo file, and writes exactly
// one file: intraday_equity_report.txt. The API keys are read from the
// environment, never printed and never written anywhere.
//
// Usage:
//   ALPACA_KEY_2=... ALPACA_SECRET_2=... node intraday_equity.mjs v21
//   ALPACA_KEY_3=... ALPACA_SECRET_3=... node intraday_equity.mjs lab
//   ABDULLAH_TJ_KEY=... ABDULLAH_TJ_SECRET=... node intraday_equity.mjs wvad
//   node intraday_equity.mjs --help
// ============================================================
import fs from "fs";

const OUT_FILE = "intraday_equity_report.txt";
const OWN_FILES = new Set([OUT_FILE]);

// Every file that must never be clobbered by a mistaken constant edit.
// OUT_FILE is listed too, so redirecting it onto a data file is caught;
// assertWritable admits a path only as the output it was declared for.
const PROTECTED = new Set([
  "outcomes.jsonl", "outcomes_v21.jsonl", "outcomes_lab.jsonl", "outcomes_wvad.jsonl",
  "state.json", "state2.json", "state_v21.json", "state_lab.json", "state_wvad.json",
  "strategy_lab.json", "report_state.json", "research_log.json", "research_log2.json",
  "reprice_audit_v21.jsonl", "reconstructed_orphans_v21.jsonl",
  OUT_FILE,
]);

function assertWritable(target, declared) {
  if (target !== declared) {
    console.error(`✖ هدف الكتابة (${target}) ليس الملف المُصرَّح به (${declared}) — أرفض.`);
    process.exit(1);
  }
  if (!OWN_FILES.has(target)) {
    console.error(`✖ ${target} ليس من ملفات هذا السكربت — أرفض الكتابة.`);
    process.exit(1);
  }
}

// Env var names taken from the bots themselves, not from memory:
//   scan_v21.js:16-17   ALPACA_KEY_2    / ALPACA_SECRET_2
//   scan_lab.js:22-23   ALPACA_KEY_3    / ALPACA_SECRET_3
//   scan_wvad.js:37-38  ABDULLAH_TJ_KEY / ABDULLAH_TJ_SECRET   (off-convention on purpose)
const BOTS = {
  v21:  { key: "ALPACA_KEY_2",    secret: "ALPACA_SECRET_2"      },
  lab:  { key: "ALPACA_KEY_3",    secret: "ALPACA_SECRET_3"      },
  wvad: { key: "ABDULLAH_TJ_KEY", secret: "ABDULLAH_TJ_SECRET"   },
};
const TRADING_BASE = "https://paper-api.alpaca.markets/v2";   // same base in all three bots
const TZ = "America/Chicago";
const THRESHOLDS = [2, 3, 5];          // % of the day's baseline equity
const CALL_TIMEOUT_MS = 20000;
const CALL_DELAY_MS = 250;             // stay well under Alpaca's rate limit

// Candidate (timeframe, period) pairs, finest first. NOTHING here is
// assumed to work: each is attempted, and the script reports what the
// service actually returned — bar count, distinct days, and the
// timeframe Alpaca echoes back, which can differ from the one asked.
const CANDIDATES = [
  { timeframe: "1Min", period: "1D" },
  { timeframe: "1Min", period: "1W" },
  { timeframe: "1Min", period: "1M" },
  { timeframe: "5Min", period: "1W" },
  { timeframe: "5Min", period: "1M" },
  { timeframe: "5Min", period: "2M" },
  { timeframe: "5Min", period: "3M" },
  { timeframe: "15Min", period: "3M" },
];

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`
intraday_equity.mjs — منحنى الرصيد اللحظي (يشمل غير المحقق)، قراءة فقط

  node intraday_equity.mjs <bot>        bot ∈ ${Object.keys(BOTS).join(" | ")}
  node intraday_equity.mjs --probe-only   يكتفي بفحص ما تُعيده Alpaca من دقة وأيام

المتغيّرات لكل بوت (من الكود نفسه):
${Object.entries(BOTS).map(([b, v]) => `  ${b.padEnd(5)} ${v.key} / ${v.secret}`).join("\n")}

المخرج: ${OUT_FILE} فقط. نداءات GET فقط. المفاتيح لا تُطبع ولا تُكتب.
`);
  process.exit(0);
}
const PROBE_ONLY = argv.includes("--probe-only");
const BOT = argv.find(a => !a.startsWith("-")) || "v21";
if (!BOTS[BOT]) {
  console.error(`✖ بوت غير معروف: ${BOT}. المتاح: ${Object.keys(BOTS).join(", ")}`);
  process.exit(1);
}
const ALPACA_KEY    = process.env[BOTS[BOT].key];
const ALPACA_SECRET = process.env[BOTS[BOT].secret];

// ─── plumbing ───
const out = [];
const say = s => { out.push(s); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const usd = n => n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
const pct = n => n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const chiTime = ms => new Date(ms).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const chiDate = ms => new Date(ms).toLocaleString("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function fetchWithTimeout(url, options = {}, timeoutMs = CALL_TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: c.signal }); }
  finally { clearTimeout(t); }
}

// GET only: there is no method parameter, so this helper cannot mutate
// anything even if a future edit tried. Error paths report status codes,
// never response bodies, which can echo request headers back.
async function get(path) {
  try {
    const res = await fetchWithTimeout(`${TRADING_BASE}${path}`, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

// ─── STEP 1: prove the credentials reach the RIGHT account ───
// Querying one bot's history with another bot's keys returns a valid
// but wrong curve — a silent wrong answer. The last 4 digits make that
// visible without exposing the account number or the keys.
async function verifyAccount() {
  const r = await get("/account");
  if (!r.ok || !r.data) {
    console.error(`✖ GET /v2/account فشل (status ${r.status}${r.error ? ` / ${r.error}` : ""}) — توقّف.`);
    console.error(`  تحقّق أن ${BOTS[BOT].key} و ${BOTS[BOT].secret} معرّفان ويخصّان حساب ${BOT}.`);
    process.exit(1);
  }
  const num = String(r.data.account_number || "");
  const last4 = num.length >= 4 ? num.slice(-4) : "????";
  say(`✔ الحساب متصل — آخر 4 أرقام: ****${last4}`);
  say(`  البوت المطلوب: ${BOT} (${BOTS[BOT].key})`);
  say(`  الحالة: ${r.data.status || "?"} | الرصيد الحالي: ${usd(parseFloat(r.data.portfolio_value))}`);
  say(`  ⚠ تأكّد بنفسك أن ****${last4} هو حساب ${BOT} — مفاتيح بوت آخر تُعيد منحنى صحيحاً لحساب خاطئ.`);
  return last4;
}

// ─── STEP 2: what does Alpaca ACTUALLY serve? ───
// No assumption about which timeframe/period pairs are allowed or how
// far back each one reaches. Every candidate is attempted and the real
// answer is tabulated: status, bar count, distinct Chicago days, span,
// and the timeframe the service echoes (it may silently coarsen).
async function probe() {
  say(`\n${"─".repeat(104)}`);
  say(`فحص ما تُعيده الخدمة فعلاً — لا افتراض عن الدقة ولا عن المدى`);
  say(`${"─".repeat(104)}`);
  say(`الطلب        | status | بارات | أيام | المدى (Chicago)               | timeframe المُعاد | ملاحظة`);
  say(`-------------|--------|-------|------|-------------------------------|-------------------|--------`);
  const results = [];
  for (const c of CANDIDATES) {
    const r = await get(`/account/portfolio/history?period=${c.period}&timeframe=${c.timeframe}&extended_hours=false`);
    await sleep(CALL_DELAY_MS);
    const label = `${c.timeframe}/${c.period}`;
    if (!r.ok || !r.data || !Array.isArray(r.data.timestamp)) {
      say(`${label.padEnd(13)}| ${String(r.status).padStart(6)} | ${"—".padStart(5)} | ${"—".padStart(4)} | ` +
          `${"—".padEnd(30)}| ${"—".padEnd(18)}| ${r.error || "رفض/بلا بيانات"}`);
      results.push({ ...c, ok: false, status: r.status });
      continue;
    }
    const ts = r.data.timestamp;
    const days = new Set(ts.map(t => chiDate(t * 1000)));
    const span = ts.length ? `${chiDate(ts[0] * 1000)} → ${chiDate(ts[ts.length - 1] * 1000)}` : "—";
    const echoed = r.data.timeframe || "(غير معاد)";
    const note = echoed !== c.timeframe ? `⚠ خُشّنت إلى ${echoed}` : "";
    say(`${label.padEnd(13)}| ${String(r.status).padStart(6)} | ${String(ts.length).padStart(5)} | ` +
        `${String(days.size).padStart(4)} | ${span.padEnd(30)}| ${echoed.padEnd(18)}| ${note}`);
    results.push({ ...c, ok: true, status: r.status, bars: ts.length, days: days.size, echoed, raw: r.data });
  }
  return results.filter(r => r.ok && r.bars > 0);
}

// ─── STEP 3: per-day peak / trough / close ───
// Baseline = the PREVIOUS day's closing equity, so the day's move is
// measured against what it opened with. The first day in the series has
// no predecessor: it is reported with baseline "—" and excluded from
// every threshold count rather than measured against itself.
function perDay(raw) {
  const { timestamp: ts, equity: eq } = raw;
  const byDay = new Map();
  ts.forEach((t, i) => {
    const v = eq[i] == null ? null : +eq[i];
    if (v == null || !Number.isFinite(v)) return;
    const d = chiDate(t * 1000);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ ms: t * 1000, eq: v });
  });
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, pts]) => {
      pts.sort((a, b) => a.ms - b.ms);
      const hi = pts.reduce((a, p) => p.eq > a.eq ? p : a, pts[0]);
      const lo = pts.reduce((a, p) => p.eq < a.eq ? p : a, pts[0]);
      return { date, nBars: pts.length, open: pts[0], close: pts[pts.length - 1], hi, lo };
    });
  // attach the previous day's close as the baseline
  days.forEach((d, i) => {
    d.baseline = i > 0 ? days[i - 1].close.eq : null;
    const b = d.baseline;
    d.peakPct  = b ? (d.hi.eq - b) / b * 100 : null;
    d.troughPct = b ? (d.lo.eq - b) / b * 100 : null;
    d.closePct = b ? (d.close.eq - b) / b * 100 : null;
    d.usable = b != null && b > 0;
  });
  return days;
}

function report(days, label) {
  say(`\n${"=".repeat(104)}`);
  say(`## منحنى الرصيد اليومي — ${label}`);
  say(`أيام في السلسلة: ${days.length} | قابلة للقياس (لها أساس من اليوم السابق): ${days.filter(d => d.usable).length}`);
  say(`\nيوم        | بارات | الأساس   | أعلى رصيد | وقته  | %      | أدنى رصيد | وقته  | %      | الإغلاق  | %`);
  say(`-----------|-------|----------|-----------|-------|--------|-----------|-------|--------|----------|--------`);
  for (const d of days) {
    say(`${d.date} | ${String(d.nBars).padStart(5)} | ${(d.baseline == null ? "—" : usd(d.baseline)).padStart(8)} | ` +
        `${usd(d.hi.eq).padStart(9)} | ${chiTime(d.hi.ms)} | ${pct(d.peakPct).padStart(6)} | ` +
        `${usd(d.lo.eq).padStart(9)} | ${chiTime(d.lo.ms)} | ${pct(d.troughPct).padStart(6)} | ` +
        `${usd(d.close.eq).padStart(8)} | ${pct(d.closePct).padStart(6)}`);
  }

  const u = days.filter(d => d.usable);
  if (!u.length) { say(`\n⚠ لا يوم قابل للقياس — لا أساس متاح.`); return; }

  say(`\n### العتبات — على ذروة اليوم مقابل أساسه`);
  say(`العتبة | أيام بلغتها | انتهت بخسارة | إغلاق < نصف الذروة | انتهت فوق نصف الذروة | وسيط الذروة | وسيط الإغلاق`);
  say(`-------|-------------|--------------|--------------------|----------------------|-------------|-------------`);
  for (const T of THRESHOLDS) {
    const hit = u.filter(d => d.peakPct >= T);
    const red = hit.filter(d => d.closePct < 0);
    const halfBelow = hit.filter(d => d.closePct >= 0 && d.closePct < d.peakPct / 2);
    const above = hit.filter(d => d.closePct >= d.peakPct / 2);
    say(`${String(T).padStart(2)}%    | ${String(hit.length).padStart(11)} | ${String(red.length).padStart(12)} | ` +
        `${String(halfBelow.length).padStart(18)} | ${String(above.length).padStart(20)} | ` +
        `${(hit.length ? pct(median(hit.map(d => d.peakPct))) : "—").padStart(11)} | ` +
        `${hit.length ? pct(median(hit.map(d => d.closePct))) : "—"}`);
  }

  const t5 = u.filter(d => d.peakPct >= 5);
  const red5 = t5.filter(d => d.closePct < 0);
  say(`\n### الأيام التي بلغت ذروتها 5% وانتهت بخسارة — ${red5.length} من ${t5.length}`);
  if (!red5.length) say(`   لا شيء.`);
  else {
    say(`   يوم        | الأساس   | الذروة    | وقتها | ذروة % | الإغلاق  | إغلاق % | التراجع عن الذروة`);
    red5.forEach(d => say(`   ${d.date} | ${usd(d.baseline).padStart(8)} | ${usd(d.hi.eq).padStart(9)} | ` +
      `${chiTime(d.hi.ms)} | ${pct(d.peakPct).padStart(6)} | ${usd(d.close.eq).padStart(8)} | ` +
      `${pct(d.closePct).padStart(7)} | ${usd(d.close.eq - d.hi.eq)}`));
  }

  // The unrealised gap is the whole point of using equity instead of the log.
  say(`\n### السياق — سعة التحرك اليومي`);
  say(`وسيط (الذروة − القاع) كنسبة من الأساس: ${pct(median(u.map(d => d.peakPct - d.troughPct)))}`);
  say(`أيام أغلقت تحت أساسها: ${u.filter(d => d.closePct < 0).length}/${u.length}`);
  say(`أيام ذروتها فوق الأساس وقاعها تحته (تذبذب حول نقطة التعادل): ${u.filter(d => d.peakPct > 0 && d.troughPct < 0).length}`);
}

// ─── main ───
async function main() {
  say("=".repeat(104));
  say(`منحنى الرصيد اللحظي (يشمل المراكز غير المحققة) — ${BOT}`);
  say(`التاريخ: ${new Date().toISOString()}  |  المنطقة الزمنية للعرض: ${TZ}`);
  say(`نداءات GET فقط. المخرج الوحيد: ${OUT_FILE}`);
  say("=".repeat(104));

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.error(`\n✖ ${BOTS[BOT].key} و/أو ${BOTS[BOT].secret} غير معرّفين في البيئة — توقّف.`);
    console.error(`  شغّله حيث المتغيّران موجودان (Console الحاوية أو جهازك).`);
    console.error(`  للمساعدة: node intraday_equity.mjs --help`);
    process.exit(1);
  }

  say(`\n--- 1) التحقق من الحساب ---`);
  await verifyAccount();

  say(`\n--- 2) فحص الدقة والمدى المتاحين ---`);
  const avail = await probe();
  if (!avail.length) {
    say(`\n✖ لم تُعِد الخدمة بيانات لأي تركيبة — لا تحليل.`);
    assertWritable(OUT_FILE, OUT_FILE);
    fs.writeFileSync(OUT_FILE, out.join("\n") + "\n");
    process.exit(1);
  }

  // Two picks, both reported, neither assumed: the widest coverage, and
  // the finest resolution that returned anything. They are often not the
  // same request, and the difference itself is a finding.
  const widest = [...avail].sort((a, b) => b.days - a.days || CANDIDATES.findIndex(c => c.timeframe === a.timeframe) - CANDIDATES.findIndex(c => c.timeframe === b.timeframe))[0];
  const finest = avail[0];
  say(`\nالأوسع تغطيةً: ${widest.timeframe}/${widest.period} — ${widest.days} يوماً، ${widest.bars} باراً`);
  say(`الأدقّ المتاح: ${finest.timeframe}/${finest.period} — ${finest.days} يوماً، ${finest.bars} باراً`);
  if (widest.timeframe !== finest.timeframe || widest.period !== finest.period) {
    say(`⚠ الأوسع والأدقّ ليسا نفس الطلب — يُعرض التحليل للاثنين، والاستنتاجات تُقرأ على مدى كل منهما.`);
  }

  if (PROBE_ONLY) {
    say(`\n--probe-only: توقّف قبل التحليل كما طُلب.`);
  } else {
    say(`\n--- 3) التحليل اليومي ---`);
    report(perDay(widest.raw), `${widest.timeframe} / ${widest.period} (الأوسع)`);
    if (widest !== finest) report(perDay(finest.raw), `${finest.timeframe} / ${finest.period} (الأدقّ)`);
  }

  // ─── STEP 5: limits, printed into the report itself ───
  say(`\n${"=".repeat(104)}`);
  say(`الحدود`);
  say(`${"=".repeat(104)}`);
  say(`1. دقة الفترة: الذروة والقاع هما أعلى وأدنى بار في السلسلة، لا أعلى وأدنى لحظة.`);
  say(`   ببارات ${widest.timeframe} تُفوَّت أي حركة داخل البار. والرقم الحقيقي للذروة ≥ المعروض،`);
  say(`   وللقاع ≤ المعروض — أي أن سعة التحرك المعروضة حدّ أدنى لا قيمة فعلية.`);
  say(`2. الأيام المتاحة: ${widest.days} يوماً فعلاً من الخدمة (لا افتراض) — اقرأ جدول الفحص أعلاه.`);
  say(`   أول يوم في السلسلة بلا أساس (لا إغلاق سابق) فاستُبعد من كل عدّ للعتبات.`);
  say(`3. الصفقات الجزئية: الرصيد يُقيَّم كاملاً عند كل بار، فمركز نُفِّذ جزئياً يظهر بكميته`);
  say(`   المنفَّذة فقط. ولا يمكن من هذه السلسلة معرفة أي جزء من التغيّر محقق وأيه غير محقق.`);
  say(`4. extended_hours=false في كل الطلبات، فحركة ما قبل الافتتاح وما بعد الإغلاق غير محتسبة.`);
  say(`5. الرصيد يشمل كل ما في الحساب. لو تداول هذا الحساب شيء آخر غير هذا البوت،`);
  say(`   أو أُودع/سُحب مال، فالمنحنى يخلط ذلك بأداء البوت ولا يفصله.`);
  say(`6. الأساس = إغلاق اليوم السابق، لا رصيد لحظة أول صفقة. أي تغيّر بين الإغلاق`);
  say(`   والافتتاح (فجوة السوق على مركز مبقى) يُحسب على اليوم التالي.`);
  say(`7. "الذروة" تُعرَف بعد انتهاء اليوم. لحظةً بلحظة لا أحد يعلم أنها الذروة،`);
  say(`   فأي قراءة تفترض إمكان التقاطها تقع في انحياز النظر إلى الأمام.`);

  assertWritable(OUT_FILE, OUT_FILE);
  fs.writeFileSync(OUT_FILE, out.join("\n") + "\n");
  console.log(`\n✔ التقرير في ${OUT_FILE} (ولم يُلمس أي ملف آخر)`);
}

main().catch(e => {
  console.error("✖ خطأ غير متوقَّع:", e.message);
  process.exit(1);
});
