// ============================================================
// REPRICE AUDIT — v21 only, READ-ONLY against outcomes_v21.jsonl
//
// Why this exists: 74 of v21's 105 logged trades exited through the
// reconciliation path, where exitPremium is a market quote sampled at
// the moment the position was noticed gone — NOT the price the order
// actually filled at. Every pnl, PF and expectancy figure for those
// trades rests on that quote. This script asks Alpaca what the fills
// really were and writes the comparison to its OWN file.
//
// It never writes to outcomes_*, state_*, strategy_lab.json or any
// other repo file. It never prints or stores the API keys.
//
// Usage:
//   ALPACA_KEY_2=... ALPACA_SECRET_2=... node reprice_audit.js
//   node reprice_audit.js --dry-run     # no network, logic check only
// ============================================================
import fs from "fs";

const IN_FILE  = "outcomes_v21.jsonl";
const OUT_FILE = "reprice_audit_v21.jsonl";

// Hard guard: this script must never be able to write over live data,
// however the constants above are later edited. Checked before any write.
const PROTECTED = new Set([
  "outcomes.jsonl", "outcomes_v21.jsonl", "outcomes_lab.jsonl", "outcomes_wvad.jsonl",
  "state.json", "state2.json", "state_v21.json", "state_lab.json", "state_wvad.json",
  "strategy_lab.json", "report_state.json", "research_log.json", "research_log2.json",
]);

const ALPACA_KEY    = process.env.ALPACA_KEY_2;
const ALPACA_SECRET = process.env.ALPACA_SECRET_2;
const TRADING_BASE  = "https://paper-api.alpaca.markets/v2";

const DRY_RUN       = process.argv.includes("--dry-run");
const RETENTION_FROM = "2026-08-24T00:00:00Z"; // day of v21's first logged trade
const MATCH_GRACE_MS = 10 * 60 * 1000;         // exitTime + 10 min, per the audit spec
const PAGE_SIZE      = 100;                    // Alpaca's max for this endpoint
const MAX_PAGES      = 200;                    // circuit breaker; 200×100 = 20k fills
const PAGE_DELAY_MS  = 120;                    // stay well under Alpaca's rate limit

// Same pattern as the bots: fetch has no default timeout, and a stalled
// connection would hang this script with no error.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Returns { ok, status, data } and never throws. The keys go into the
// headers here and nowhere else — they are never logged, and the error
// paths below deliberately report only status codes, never response
// bodies, which can echo request headers back.
async function alpaca(path) {
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = n => (n >= 0 ? "+$" : "-$") + Math.abs(Math.round(n));

function readOutcomes() {
  let raw;
  try {
    raw = fs.readFileSync(IN_FILE, "utf8");
  } catch (e) {
    console.error(`✖ تعذّر قراءة ${IN_FILE}: ${e.code || e.message}`);
    process.exit(1);
  }
  const rows = [];
  let bad = 0;
  raw.split("\n").filter(l => l.trim()).forEach((l, i) => {
    try { rows.push(JSON.parse(l)); } catch { bad++; console.warn(`  سطر ${i + 1} غير صالح — تُجوهل`); }
  });
  if (bad) console.warn(`  أسطر تالفة: ${bad}`);
  return rows;
}

// ─── STEP 1: prove the credentials reach the RIGHT account ───
// Querying v21's log with LAB's or WVAD's keys returns an empty fill
// set, which looks exactly like "no fills found" — a silent wrong
// answer. Printing the account's last 4 digits makes that visible
// without exposing the number or the keys.
async function verifyAccount() {
  const r = await alpaca("/account");
  if (!r.ok || !r.data) {
    console.error(`✖ GET /v2/account فشل (status ${r.status}${r.error ? ` / ${r.error}` : ""}) — توقّف.`);
    console.error("  تحقّق أن ALPACA_KEY_2 و ALPACA_SECRET_2 معرّفان ويخصّان حساب v21.");
    process.exit(1);
  }
  const num = String(r.data.account_number || "");
  const last4 = num.length >= 4 ? num.slice(-4) : "????";
  console.log(`✔ الحساب متصل — آخر 4 أرقام: ****${last4}`);
  console.log(`  الحالة: ${r.data.status || "?"} | قيمة المحفظة: $${Math.round(parseFloat(r.data.portfolio_value) || 0)}`);
  console.log(`  ⚠ تأكّد بنفسك أن ****${last4} هو حساب v21 — سجلّ بوت آخر سيُطابق صفراً ويبدو كأن لا تنفيذات.`);
  return last4;
}

// ─── STEP 2: how far back does Alpaca actually keep fills? ───
// direction=asc is added on purpose: the endpoint defaults to desc,
// which would hand back the NEWEST fill and tell us nothing about
// retention. One record is enough.
async function probeRetention() {
  const r = await alpaca(`/account/activities/FILL?after=${RETENTION_FROM}&page_size=1&direction=asc`);
  if (!r.ok) {
    console.error(`✖ فحص مدى الاحتفاظ فشل (status ${r.status}${r.error ? ` / ${r.error}` : ""}) — توقّف.`);
    process.exit(1);
  }
  const arr = Array.isArray(r.data) ? r.data : [];
  if (!arr.length) {
    console.warn(`⚠ لا تنفيذات بعد ${RETENTION_FROM} إطلاقاً.`);
    console.warn("  إمّا أن Alpaca لا يحتفظ بالسجل لهذا المدى، أو أن المفاتيح لحساب آخر.");
    return null;
  }
  const oldest = arr[0].transaction_time || arr[0].date || "?";
  console.log(`✔ أقدم تنفيذ متاح: ${oldest}`);
  const gapDays = Math.round((new Date(oldest) - new Date(RETENTION_FROM)) / 86400000);
  if (gapDays > 1) {
    console.warn(`⚠ أقدم تنفيذ متأخّر ${gapDays} يوماً عن ${RETENTION_FROM.slice(0, 10)} —`);
    console.warn("  الصفقات الأقدم منه ستظهر unresolved بسبب حدّ الاحتفاظ، لا بسبب خطأ.");
  }
  return oldest;
}

// ─── STEP 3: page through every FILL ───
// page_token for this endpoint is the id of the last item of the
// previous page. No token handling means silently reading only the
// first 100 fills — the same class of bug as v21's bars limit=100.
async function fetchAllFills() {
  const fills = [];
  let token = null;
  let page = 0;
  while (page < MAX_PAGES) {
    page++;
    const q = `/account/activities/FILL?after=${RETENTION_FROM}&page_size=${PAGE_SIZE}&direction=asc`
            + (token ? `&page_token=${encodeURIComponent(token)}` : "");
    const r = await alpaca(q);
    if (!r.ok) {
      console.error(`✖ صفحة ${page} فشلت (status ${r.status}${r.error ? ` / ${r.error}` : ""}) — توقّف قبل اكتمال الجلب.`);
      console.error("  لا أكتب مخرجاً جزئياً: نتيجة مبنية على تنفيذات ناقصة أسوأ من لا نتيجة.");
      process.exit(1);
    }
    const arr = Array.isArray(r.data) ? r.data : [];
    fills.push(...arr);
    process.stdout.write(`\r  صفحة ${page}: +${arr.length} (المجموع ${fills.length})   `);
    if (arr.length < PAGE_SIZE) break;
    token = arr[arr.length - 1].id;
    if (!token) {
      console.warn(`\n⚠ آخر عنصر في صفحة ${page} بلا id — تعذّر الترقيم، توقّف الجلب هنا.`);
      break;
    }
    await sleep(PAGE_DELAY_MS);
  }
  console.log(`\n✔ إجمالي التنفيذات المجلوبة: ${fills.length} على ${page} صفحة`);
  if (page >= MAX_PAGES) console.warn(`⚠ بلغ حدّ ${MAX_PAGES} صفحة — قد تكون هناك تنفيذات لم تُجلب.`);
  return fills;
}

// ─── STEP 4: match each logged trade to its sell fills ───
// Index by option symbol first — matching is per-contract, and the
// contract symbol already encodes underlying + expiry + type + strike,
// so it is close to a unique key per trade.
function indexFills(fills) {
  const bySymbol = new Map();
  for (const f of fills) {
    const side = String(f.side || "");
    if (!side.startsWith("sell")) continue;      // only exits; covers sell / sell_short
    const sym = f.symbol;
    if (!sym) continue;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push({
      id: f.id,
      orderId: f.order_id,
      price: parseFloat(f.price),
      qty: parseFloat(f.qty),
      t: new Date(f.transaction_time).getTime(),
      type: f.type,
    });
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.t - b.t);
  return bySymbol;
}

function weightedAvg(group) {
  const totQty = group.reduce((a, f) => a + f.qty, 0);
  if (!totQty) return null;
  return group.reduce((a, f) => a + f.price * f.qty, 0) / totQty;
}

// Classification is deliberately strict: anything the data does not
// settle unambiguously is labelled, never guessed. A wrong "exact" is
// worse than an honest "ambiguous".
function matchTrade(rec, bySymbol) {
  const list = bySymbol.get(rec.optionSymbol) || [];
  const from = new Date(rec.entryTime).getTime();
  const to   = new Date(rec.exitTime).getTime() + MATCH_GRACE_MS;
  const cands = list.filter(f => f.t >= from && f.t <= to && Number.isFinite(f.price) && Number.isFinite(f.qty));

  if (!cands.length) return { confidence: "unresolved", fillPrice: null, note: "لا تنفيذ بيع في النافذة" };

  const byOrder = new Map();
  for (const f of cands) {
    const k = f.orderId || `__no_order_${f.id}`;
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(f);
  }

  if (byOrder.size > 1) {
    return {
      confidence: "ambiguous", fillPrice: null,
      note: `${byOrder.size} أوامر بيع مختلفة في النافذة (${cands.length} تنفيذ)`,
    };
  }

  const group = [...byOrder.values()][0];
  const qty = group.reduce((a, f) => a + f.qty, 0);
  const price = weightedAvg(group);
  if (price == null) return { confidence: "ambiguous", fillPrice: null, note: "كمية صفرية" };

  if (qty !== rec.qty) {
    return {
      confidence: "ambiguous", fillPrice: +price.toFixed(4),
      note: `الكمية لا تطابق: التنفيذ ${qty} مقابل السجل ${rec.qty}`,
    };
  }
  if (group.length === 1) return { confidence: "exact", fillPrice: +price.toFixed(4), note: "تنفيذ واحد كامل" };
  return { confidence: "partial", fillPrice: +price.toFixed(4), note: `${group.length} تنفيذ جزئي، متوسط مرجَّح` };
}

function buildRecord(rec, m) {
  const fp = m.fillPrice;
  const deltaPct = fp != null && rec.exitPremium ? (fp - rec.exitPremium) / rec.exitPremium * 100 : null;
  const pnlRepriced = fp != null ? Math.round((fp - rec.entryPremium) * rec.qty * 100) : null;
  return {
    tradeId: rec.tradeId,
    day: rec.day,
    symbol: rec.symbol,
    signal: rec.signal,
    optionSymbol: rec.optionSymbol,
    reason: rec.reason,
    fillSource: rec.fillSource ?? null,
    qty: rec.qty,
    entryPremium: rec.entryPremium,
    exitPremium: rec.exitPremium,          // as recorded (the quote)
    fillPrice: fp,                          // what Alpaca says, or null
    deltaPct: deltaPct == null ? null : +deltaPct.toFixed(2),
    pnlRecorded: rec.pnl,
    pnlRepriced,
    pnlDelta: pnlRepriced == null ? null : pnlRepriced - rec.pnl,
    confidence: m.confidence,
    note: m.note,
  };
}

function writeOut(records) {
  if (PROTECTED.has(OUT_FILE)) {
    console.error(`✖ OUT_FILE (${OUT_FILE}) ملف بيانات محمي — أرفض الكتابة.`);
    process.exit(1);
  }
  fs.writeFileSync(OUT_FILE, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.log(`✔ كُتب ${records.length} سجلاً في ${OUT_FILE} (ولم يُلمس أي ملف آخر)`);
}

// ─── STEP 6: summary ───
function summarize(records) {
  const byConf = {};
  records.forEach(r => byConf[r.confidence] = (byConf[r.confidence] || 0) + 1);

  console.log(`\n${"=".repeat(62)}\nالملخص`);
  console.log(`  الإجمالي: ${records.length}`);
  for (const k of ["exact", "partial", "ambiguous", "unresolved"]) {
    const n = byConf[k] || 0;
    console.log(`  ${k.padEnd(11)} ${String(n).padStart(4)}  (${records.length ? (n / records.length * 100).toFixed(0) : 0}%)`);
  }

  const ex = records.filter(r => r.confidence === "exact");
  console.log(`\n-- الصافي على الصفقات exact فقط (${ex.length} صفقة) --`);
  if (!ex.length) {
    console.log("  لا صفقات exact — لا يمكن قياس الانحياز.");
  } else {
    const rec = ex.reduce((a, r) => a + r.pnlRecorded, 0);
    const rep = ex.reduce((a, r) => a + r.pnlRepriced, 0);
    console.log(`  المسجّل:        ${money(rec)}`);
    console.log(`  المعاد تسعيره:  ${money(rep)}`);
    console.log(`  الفرق:          ${money(rep - rec)}  (${rec ? ((rep - rec) / Math.abs(rec) * 100).toFixed(1) : "—"}%)`);
    const d = ex.map(r => r.deltaPct).filter(x => x != null).sort((a, b) => a - b);
    if (d.length) {
      console.log(`  انحياز deltaPct: الوسيط ${d[Math.floor(d.length / 2)].toFixed(2)}%  |  المدى ${d[0].toFixed(2)}% → ${d[d.length - 1].toFixed(2)}%`);
      console.log(`  (سالب = السعر المسجّل كان متفائلاً، أي الربح الحقيقي أقل)`);
    }
  }

  // The two 2026-09-21 trades carry 152% of v21's entire net profit.
  // If they are not confirmed, nothing about v21's profitability is known.
  const key = records.filter(r => r.day === "2026-09-21");
  console.log(`\n-- صفقتا 2026-09-21 (تمثّلان 152% من صافي v21) --`);
  if (!key.length) {
    console.log("  لا سجلات بهذا التاريخ في الملف.");
  } else {
    key.forEach(r => console.log(
      `  ${r.symbol} ${r.signal}  مسجّل ${money(r.pnlRecorded)}  →  ` +
      (r.pnlRepriced == null ? `غير محسوم (${r.confidence}: ${r.note})`
        : `معاد ${money(r.pnlRepriced)}  فرق ${money(r.pnlDelta)}  (${r.confidence})`)
    ));
    const confirmed = key.filter(r => r.confidence === "exact" || r.confidence === "partial");
    console.log(`  النتيجة: ${confirmed.length === key.length && key.length === 2
      ? "✔ الصفقتان مؤكَّدتان — ربح v21 الظاهر قائم على سعر حقيقي"
      : `✖ غير مؤكَّدتين (${confirmed.length}/${key.length}) — ربح v21 الظاهر ما يزال غير متحقَّق منه`}`);
  }

  const unres = records.filter(r => r.confidence === "unresolved");
  if (unres.length) {
    const days = [...new Set(unres.map(r => r.day))].sort();
    console.log(`\n-- unresolved: ${unres.length} صفقة على ${days.length} يوم (${days[0]} → ${days[days.length - 1]}) --`);
    console.log(`  أسباب محتملة: حدّ احتفاظ Alpaca، أو إغلاق بانتهاء صلاحية 0DTE`);
    console.log(`  (نشاط EXP/OPASN لا FILL)، أو تصفية من الوسيط. لا تُخمَّن أسعارها.`);
  }
  console.log(`${"=".repeat(62)}`);
}

// ─── MAIN ───
async function main() {
  console.log(`=== reprice audit (v21) — قراءة فقط — ${new Date().toISOString()} ===`);
  console.log(`  المدخل: ${IN_FILE}   المخرج: ${OUT_FILE}`);

  const rows = readOutcomes();
  console.log(`✔ قُرئ ${rows.length} سجلاً${rows.length ? ` (${rows[0].day} → ${rows[rows.length - 1].day})` : ""}`);

  if (DRY_RUN) {
    console.log("\n⚠ --dry-run: لا اتصال بالشبكة، لا مفاتيح، لا كتابة.");
    console.log("  يُشغّل منطق المطابقة على مجموعة تنفيذات فارغة للتحقق من المسارات فقط.");
    const empty = indexFills([]);
    const records = rows.map(r => buildRecord(r, matchTrade(r, empty)));
    summarize(records);
    console.log("\n✔ dry-run انتهى. كل سجل unresolved كما هو متوقَّع بلا بيانات.");
    return;
  }

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.error("\n✖ ALPACA_KEY_2 و/أو ALPACA_SECRET_2 غير معرّفين في البيئة — توقّف.");
    console.error("  شغّله حيث المتغيّران موجودان (Console الحاوية أو جهازك).");
    console.error("  لفحص الصياغة والمنطق بلا مفاتيح: node reprice_audit.js --dry-run");
    process.exit(1);
  }

  console.log("\n--- 1) التحقق من الحساب ---");
  await verifyAccount();

  console.log("\n--- 2) مدى احتفاظ Alpaca بالسجل ---");
  await probeRetention();

  console.log("\n--- 3) جلب كل التنفيذات ---");
  const fills = await fetchAllFills();

  console.log("\n--- 4) المطابقة ---");
  const bySymbol = indexFills(fills);
  console.log(`  تنفيذات بيع على ${bySymbol.size} عقد مختلف`);
  const records = rows.map(r => buildRecord(r, matchTrade(r, bySymbol)));

  console.log("\n--- 5) الكتابة ---");
  writeOut(records);

  summarize(records);
}

main().catch(e => {
  console.error("✖ خطأ غير متوقَّع:", e.message);
  process.exit(1);
});
