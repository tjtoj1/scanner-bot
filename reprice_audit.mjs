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
// Entry side too: entryPremium is the mid of the option quote read
// just before the buy order went out (findOption/getQuote), not the
// buy's fill price either. So a fully repriced pnl needs BOTH sides,
// and the exit-only figure still carries the entry's error.
//
// It never writes to outcomes_*, state_*, strategy_lab.json or any
// other repo file. It never prints or stores the API keys.
//
// Usage:
//   ALPACA_KEY_2=... ALPACA_SECRET_2=... node reprice_audit.mjs
//   node reprice_audit.mjs --dry-run    # no network, logic check only
// ============================================================
import fs from "fs";

const IN_FILE  = "outcomes_v21.jsonl";
const OUT_FILE = "reprice_audit_v21.jsonl";
const ORPHAN_FILE = "reconstructed_orphans_v21.jsonl";

// The two files this script owns and is allowed to overwrite.
const OWN_FILES = new Set([OUT_FILE, ORPHAN_FILE]);

// Hard guard: this script must never be able to write over live data,
// however the constants above are later edited. Checked before any write.
// The two outputs are listed here as well, so that redirecting one of
// them onto the other — or onto a data file — is caught; assertWritable
// admits a path only as the output of the step that declared it.
const PROTECTED = new Set([
  "outcomes.jsonl", "outcomes_v21.jsonl", "outcomes_lab.jsonl", "outcomes_wvad.jsonl",
  "state.json", "state2.json", "state_v21.json", "state_lab.json", "state_wvad.json",
  "strategy_lab.json", "report_state.json", "research_log.json", "research_log2.json",
  OUT_FILE, ORPHAN_FILE,
]);

// `target` is the path about to be written; `declared` is the constant
// this step is supposed to be writing. They must be the same path, and
// it must be one of this script's own files.
function assertWritable(target, declared) {
  if (target !== declared) {
    console.error(`✖ هدف الكتابة (${target}) ليس الملف المُصرَّح به لهذه الخطوة (${declared}) — أرفض.`);
    process.exit(1);
  }
  if (!OWN_FILES.has(target) || (PROTECTED.has(target) && !OWN_FILES.has(target))) {
    console.error(`✖ ${target} ليس من ملفات هذا السكربت (أو ملف بيانات محمي) — أرفض الكتابة.`);
    process.exit(1);
  }
}

const ALPACA_KEY    = process.env.ALPACA_KEY_2;
const ALPACA_SECRET = process.env.ALPACA_SECRET_2;
const TRADING_BASE  = "https://paper-api.alpaca.markets/v2";

const DRY_RUN        = process.argv.includes("--dry-run");
const RETENTION_FROM = "2026-08-24T00:00:00Z"; // day of v21's first logged trade
const EXIT_GRACE_MS  = 10 * 60 * 1000;         // exitTime + 10 min
const ENTRY_WINDOW_MS = 3 * 60 * 1000;         // entryTime ± 3 min
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
const ms = s => new Date(s).getTime();

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

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

// ─── STEP 4a: index fills by contract, keeping BOTH sides ───
// Matching is per-contract, and the contract symbol already encodes
// underlying + expiry + type + strike, so it is close to a unique key
// per trade. Both sides are kept: entry needs buys, exit needs sells.
function indexFills(fills) {
  const bySymbol = new Map();
  for (const f of fills) {
    const side = String(f.side || "");
    if (!side.startsWith("buy") && !side.startsWith("sell")) continue;
    const sym = f.symbol;
    if (!sym) continue;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push({
      id: f.id,
      orderId: f.order_id,
      side: side.startsWith("buy") ? "buy" : "sell",
      price: parseFloat(f.price),
      qty: parseFloat(f.qty),
      t: new Date(f.transaction_time).getTime(),
      type: f.type,
    });
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.t - b.t);
  return bySymbol;
}

// ─── STEP 4b: the trade chain per contract ───
// 33 of 105 v21 trades share an option symbol with another trade, and
// the next entry often lands 1-3 SECONDS after the previous exit. With
// a ±3 min entry window and a +10 min exit grace, those windows
// overlap their neighbours and every one of them would come back
// ambiguous. This chain gives each trade its neighbours' boundaries so
// the retry pass can clamp the windows instead of guessing.
// (Verified on the log: zero trades on one contract overlap in time,
// so the chain is strictly sequential and the clamps are well defined.)
function buildChain(rows) {
  const byContract = new Map();
  rows.forEach(r => {
    if (!byContract.has(r.optionSymbol)) byContract.set(r.optionSymbol, []);
    byContract.get(r.optionSymbol).push(r);
  });
  const bounds = new Map(); // tradeId -> { prevExitMs, nextEntryMs, siblings }
  for (const list of byContract.values()) {
    list.sort((a, b) => ms(a.entryTime) - ms(b.entryTime));
    list.forEach((r, i) => bounds.set(r.tradeId, {
      prevExitMs:  i > 0 ? ms(list[i - 1].exitTime) : null,
      nextEntryMs: i < list.length - 1 ? ms(list[i + 1].entryTime) : null,
      siblings: list.length,
    }));
  }
  return bounds;
}

function weightedAvg(group) {
  const totQty = group.reduce((a, f) => a + f.qty, 0);
  if (!totQty) return null;
  return group.reduce((a, f) => a + f.price * f.qty, 0) / totQty;
}

// Classification is deliberately strict: anything the data does not
// settle unambiguously is labelled, never guessed. A wrong "exact" is
// worse than an honest "ambiguous". Shared by the entry and exit
// passes — the only difference between them is side and window.
function matchSide(rec, bySymbol, side, from, to) {
  const list = bySymbol.get(rec.optionSymbol) || [];
  const cands = list.filter(f =>
    f.side === side && f.t >= from && f.t <= to &&
    Number.isFinite(f.price) && Number.isFinite(f.qty));

  const win = `${new Date(from).toISOString().slice(11, 19)}→${new Date(to).toISOString().slice(11, 19)}`;
  if (!cands.length) return { confidence: "unresolved", fillPrice: null, fillIds: [], note: `لا تنفيذ ${side} في النافذة ${win}` };

  const byOrder = new Map();
  for (const f of cands) {
    const k = f.orderId || `__no_order_${f.id}`;
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(f);
  }

  if (byOrder.size > 1) {
    return {
      confidence: "ambiguous", fillPrice: null, fillIds: [],
      note: `${byOrder.size} أوامر ${side} مختلفة في النافذة ${win} (${cands.length} تنفيذ)`,
    };
  }

  const group = [...byOrder.values()][0];
  const ids = group.map(f => f.id);
  const qty = group.reduce((a, f) => a + f.qty, 0);
  const price = weightedAvg(group);
  if (price == null) return { confidence: "ambiguous", fillPrice: null, fillIds: [], note: "كمية صفرية" };

  if (qty !== rec.qty) {
    return {
      confidence: "ambiguous", fillPrice: +price.toFixed(4), fillIds: [],
      note: `الكمية لا تطابق: التنفيذ ${qty} مقابل السجل ${rec.qty}`,
    };
  }
  if (group.length === 1) return { confidence: "exact", fillPrice: +price.toFixed(4), fillIds: ids, note: "تنفيذ واحد كامل" };
  return { confidence: "partial", fillPrice: +price.toFixed(4), fillIds: ids, note: `${group.length} تنفيذ جزئي، متوسط مرجَّح` };
}

// Two passes per side. Pass 1 uses the plain windows. Pass 2 runs ONLY
// on an ambiguous pass-1 result and ONLY narrows the window to the
// neighbouring trade's boundary on the same contract — it never widens
// anything and never picks a candidate by preference. If narrowing is
// impossible (no neighbour), the ambiguous verdict stands.
function resolveTrade(rec, bySymbol, bounds) {
  const b = bounds.get(rec.tradeId) || { prevExitMs: null, nextEntryMs: null, siblings: 1 };
  const entryMs = ms(rec.entryTime);
  const exitMs  = ms(rec.exitTime);

  // ── exit side ──
  let exit = matchSide(rec, bySymbol, "sell", entryMs, exitMs + EXIT_GRACE_MS);
  let exitRetried = false;
  if (exit.confidence === "ambiguous" && b.nextEntryMs != null) {
    const to = Math.min(exitMs + EXIT_GRACE_MS, b.nextEntryMs - 1);
    if (to > entryMs) {
      const second = matchSide(rec, bySymbol, "sell", entryMs, to);
      exitRetried = true;
      exit = { ...second, note: `${second.note} [ضُيّقت حتى دخول الصفقة التالية]` };
    }
  }

  // ── entry side ──
  let entry = matchSide(rec, bySymbol, "buy", entryMs - ENTRY_WINDOW_MS, entryMs + ENTRY_WINDOW_MS);
  let entryRetried = false;
  if (entry.confidence === "ambiguous") {
    // Symmetric clamp: a buy for THIS trade cannot precede the previous
    // trade's exit on the same contract, nor follow this trade's own exit.
    const from = b.prevExitMs != null
      ? Math.max(entryMs - ENTRY_WINDOW_MS, b.prevExitMs + 1)
      : entryMs - ENTRY_WINDOW_MS;
    const to = Math.min(entryMs + ENTRY_WINDOW_MS, exitMs);
    if (to > from && (from !== entryMs - ENTRY_WINDOW_MS || to !== entryMs + ENTRY_WINDOW_MS)) {
      const second = matchSide(rec, bySymbol, "buy", from, to);
      entryRetried = true;
      entry = { ...second, note: `${second.note} [ضُيّقت بحدود الصفقة المجاورة]` };
    }
  }

  return { exit, entry, exitRetried, entryRetried, siblings: b.siblings };
}

function buildRecord(rec, m) {
  const xp = m.exit.fillPrice;
  const ep = m.entry.fillPrice;
  const exitDeltaPct  = xp != null && rec.exitPremium  ? (xp - rec.exitPremium)  / rec.exitPremium  * 100 : null;
  const entryDeltaPct = ep != null && rec.entryPremium ? (ep - rec.entryPremium) / rec.entryPremium * 100 : null;
  const pnlRepriced     = xp != null ? Math.round((xp - rec.entryPremium) * rec.qty * 100) : null;
  const pnlFullRepriced = xp != null && ep != null ? Math.round((xp - ep) * rec.qty * 100) : null;
  const solid = c => c === "exact" || c === "partial";

  return {
    tradeId: rec.tradeId,
    day: rec.day,
    symbol: rec.symbol,
    signal: rec.signal,
    optionSymbol: rec.optionSymbol,
    reason: rec.reason,
    fillSource: rec.fillSource ?? null,
    qty: rec.qty,
    siblingsOnContract: m.siblings,          // >1 means the windows had neighbours

    entryPremium: rec.entryPremium,          // as recorded (quote before the buy)
    entryFillPrice: ep,                      // what Alpaca says the buy filled at
    entryDeltaPct: entryDeltaPct == null ? null : +entryDeltaPct.toFixed(2),
    entryConfidence: m.entry.confidence,
    entryNote: m.entry.note,
    entryRetried: m.entryRetried,

    exitPremium: rec.exitPremium,            // as recorded (quote at detection)
    fillPrice: xp,                           // what Alpaca says the sell filled at
    deltaPct: exitDeltaPct == null ? null : +exitDeltaPct.toFixed(2),
    confidence: m.exit.confidence,           // exit-side confidence (original field)
    note: m.exit.note,
    exitRetried: m.exitRetried,

    pnlRecorded: rec.pnl,
    pnlRepriced,                             // exit repriced, entry as recorded
    pnlFullRepriced,                         // both sides from Alpaca
    pnlDelta:     pnlRepriced     == null ? null : pnlRepriced - rec.pnl,
    pnlFullDelta: pnlFullRepriced == null ? null : pnlFullRepriced - rec.pnl,
    fullyResolved: solid(m.exit.confidence) && solid(m.entry.confidence),
  };
}

function writeJsonl(rows, target, declared, label) {
  assertWritable(target, declared);
  fs.writeFileSync(target, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.log(`✔ كُتب ${rows.length} ${label} في ${target}`);
}

// ─── STEP 7a: which Alpaca fills did no logged trade claim? ───
// Only a RESOLVED match (exact/partial) consumes its fills. An
// ambiguous verdict decided nothing, so its real fills stay in the
// orphan pool — which means the pool is "not attributed to any
// resolved trade", NOT "proof of an untracked trade". The summary
// prints how many logged trades are unresolved so the contamination
// is visible rather than implied.
function collectConsumed(resolutions) {
  const consumed = new Set();
  for (const { m } of resolutions) {
    for (const side of [m.exit, m.entry]) {
      if (side.confidence === "exact" || side.confidence === "partial") {
        (side.fillIds || []).forEach(id => consumed.add(id));
      }
    }
  }
  return consumed;
}

function collectOrphans(bySymbol, consumed) {
  const orphans = [];
  for (const [sym, list] of bySymbol) {
    for (const f of list) if (!consumed.has(f.id)) orphans.push({ ...f, symbol: sym });
  }
  orphans.sort((a, b) => a.t - b.t);
  return orphans;
}

// ─── STEP 7b: FIFO reconstruction of the missing trades ───
// Per contract, in time order: a buy pushes a lot, a sell consumes
// from the front of the queue. Each (lot, sell) overlap is one
// reconstructed round trip, priced from two real fills. Anything that
// does not pair is reported as itself — a sell with no inventory, or a
// lot that was never sold inside the fetched range — and never
// guessed at. The day is the EXIT date, because that is when the cash
// actually moves, which is what the equity comparison below needs.
function reconstructFifo(orphans) {
  const byContract = new Map();
  for (const f of orphans) {
    if (!byContract.has(f.symbol)) byContract.set(f.symbol, []);
    byContract.get(f.symbol).push(f);
  }
  const out = [];
  for (const [sym, list] of byContract) {
    list.sort((a, b) => a.t - b.t);
    const lots = [];                                  // FIFO queue of open buys
    for (const f of list) {
      if (f.side === "buy") { lots.push({ ...f, left: f.qty }); continue; }
      let remaining = f.qty;
      while (remaining > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.left, remaining);
        out.push({
          kind: "reconstructed_trade",
          optionSymbol: sym,
          day: new Date(f.t).toISOString().slice(0, 10),   // exit date
          entryTime: new Date(lot.t).toISOString(),
          exitTime:  new Date(f.t).toISOString(),
          qty: take,
          entryPrice: +lot.price.toFixed(4),
          exitPrice:  +f.price.toFixed(4),
          pnl: Math.round((f.price - lot.price) * take * 100),
          holdSec: Math.round((f.t - lot.t) / 1000),
          buyFillId: lot.id, sellFillId: f.id,
          buyOrderId: lot.orderId, sellOrderId: f.orderId,
          split: take !== lot.qty || take !== f.qty,
          note: take === lot.qty && take === f.qty
            ? "ازدواج كامل buy↔sell"
            : `ازدواج جزئي: ${take} من lot ${lot.qty} ومن sell ${f.qty}`,
        });
        lot.left -= take; remaining -= take;
        if (lot.left === 0) lots.shift();
      }
      if (remaining > 0) out.push({
        kind: "unpaired_sell",
        optionSymbol: sym,
        day: new Date(f.t).toISOString().slice(0, 10),
        time: new Date(f.t).toISOString(),
        qty: remaining, price: +f.price.toFixed(4),
        fillId: f.id, orderId: f.orderId,
        note: "بيع بلا مخزون شراء مقابل — لا يُحسب له pnl",
      });
    }
    for (const lot of lots) if (lot.left > 0) out.push({
      kind: "open_lot",
      optionSymbol: sym,
      day: new Date(lot.t).toISOString().slice(0, 10),
      time: new Date(lot.t).toISOString(),
      qty: lot.left, price: +lot.price.toFixed(4),
      fillId: lot.id, orderId: lot.orderId,
      note: "شراء لم يُقابله بيع داخل المدى المجلوب — لا يُحسب له pnl",
    });
  }
  out.sort((a, b) => (a.exitTime || a.time).localeCompare(b.exitTime || b.time));
  return out;
}

// ─── STEP 7c: Alpaca's equity curve ───
// NOTE on profit_loss: at timeframe=1D it is CUMULATIVE against
// base_value and never resets, so it is NOT a per-day change and must
// not be compared to a daily net. The per-day measure used everywhere
// below is eqDelta = equity[i] - equity[i-1]; profit_loss is carried
// only as a labelled reference column.
// The first bar has no predecessor, so its eqDelta is null and any day
// landing on it is reported as "—" and never counted as conclusive.
// The last bar is the PREVIOUS session's close, so today has no bar yet.
// Dates come from unix timestamps read as UTC, which is where a one-day
// shift appears — so the offset is MEASURED below, never assumed.
async function fetchPortfolioHistory() {
  const r = await alpaca("/account/portfolio/history?period=3M&timeframe=1D");
  if (!r.ok || !r.data || !Array.isArray(r.data.timestamp)) {
    console.warn(`⚠ portfolio/history فشل (status ${r.status}${r.error ? ` / ${r.error}` : ""}) — تُتخطّى مقارنة الرصيد.`);
    return null;
  }
  const { timestamp: ts, equity: eq = [], profit_loss: pl = [], base_value: base } = r.data;
  const rows = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    tsIso: new Date(t * 1000).toISOString(),
    equity: eq[i] == null ? null : +eq[i],
    plCum: pl[i] == null ? null : +pl[i],   // cumulative vs base_value — reference only
    eqDelta: i > 0 && eq[i] != null && eq[i - 1] != null ? +eq[i] - +eq[i - 1] : null,
  }));
  console.log(`✔ portfolio/history: ${rows.length} باراً (${rows[0]?.date} → ${rows[rows.length - 1]?.date})`);
  console.log(`  base_value: ${base == null ? "—" : "$" + Math.round(+base)}`);
  console.log(`  أول طابع زمني كامل: ${rows[0]?.tsIso}  — منه تُقرأ اتفاقية تأريخ البار`);
  console.log(`  المقياس اليومي = eqDelta (equity[i] − equity[i−1]).`);
  console.log(`  profit_loss تراكمي من base_value ولا يُعاد ضبطه — مرجع فقط، لا يُقارن بصافٍ يومي.`);
  console.log(`  أول بار بلا eqDelta (لا سابق له)، وآخر بار هو إغلاق الجلسة السابقة فاليوم الحالي بلا بار.`);
  return rows;
}

// Alpaca dates a 1D bar as the trading day PLUS ONE, so the expected
// offset in shiftDate(day, off) is +1. That is not hard-coded: the
// offset is scored from the data (-1 / 0 / +1 by mean |mismatch| against
// the fill-derived daily net) and all three are printed, so a wrong
// expectation shows up instead of silently biasing every row, and the
// script self-corrects if the convention ever changes.
// Scored on eqDelta, never on profit_loss, which is cumulative.
function pickDayOffset(ourByDay, histRows) {
  const byDate = new Map(histRows.map(h => [h.date, h]));
  const shiftDate = (d, days) => new Date(new Date(d + "T00:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10);
  const scores = [];
  for (const off of [-1, 0, 1]) {
    let total = 0, matched = 0;
    for (const [day, net] of ourByDay) {
      const h = byDate.get(shiftDate(day, off));
      if (!h || h.eqDelta == null) continue;
      total += Math.abs(net - h.eqDelta); matched++;
    }
    scores.push({ off, total, matched, mean: matched ? total / matched : Infinity });
  }
  scores.forEach(s => console.log(`  إزاحة ${s.off >= 0 ? "+" : ""}${s.off} يوم: ${s.matched} باراً مطابقاً، متوسط |الفرق| $${s.mean === Infinity ? "—" : s.mean.toFixed(0)}`));
  const best = scores.filter(s => s.matched > 0).sort((a, b) => a.mean - b.mean)[0] || { off: 0 };
  console.log(`  ⇒ الإزاحة المختارة: ${best.off >= 0 ? "+" : ""}${best.off} يوم (أقل متوسط |فرق|) — المتوقَّع +1`);
  if (best.off !== 1) console.log(`  ⚠ الإزاحة المقيسة تخالف المتوقَّع (+1) — راجع اتفاقية التأريخ قبل تصديق الجدول.`);
  return best.off;
}

// ─── Static integrity check — no network needed ───
// Two v21 records carry byte-identical premiums, qty and pnl a week
// apart. Either the log double-counted something, or it is a rounding
// coincidence. The contract symbol and tradeId settle it without
// asking Alpaca anything.
function checkLookalikes(rows) {
  console.log(`\n-- فحص التكرار: 09-01 SPY CALL مقابل 09-08 SPY PUT --`);
  const hits = rows.filter(r => r.qty === 4 && r.pnl === 32 &&
    Math.abs(r.entryPremium - 1.055) < 0.001 && Math.abs(r.exitPremium - 1.13) < 0.001);
  if (hits.length < 2) { console.log(`  وُجد ${hits.length} سجلاً فقط بهذه القيم — لا مقارنة.`); return; }
  hits.forEach(r => console.log(`  ${r.day}  ${r.symbol} ${r.signal.padEnd(4)}  ${r.optionSymbol}  in=${r.entryTime}  out=${r.exitTime}  id=${r.tradeId}`));
  const uniq = k => new Set(hits.map(r => r[k])).size === hits.length;
  const diffs = ["day", "signal", "optionSymbol", "tradeId", "entryTime", "exitTime"].filter(uniq);
  console.log(`  تختلف في: ${diffs.join(", ")}`);
  console.log(`  الحكم: ${diffs.includes("optionSymbol") && diffs.includes("tradeId")
    ? "✔ صفقتان مختلفتان — تطابق القيم محض تقريب، لا تكرار"
    : "⚠ تحتاج فحصاً يدوياً"}`);
}

// ─── STEP 7d: per-day reconciliation ───
// recorded (pnlFullRepriced) + reconstructed = total, against eqDelta
// — the day-over-day equity change, which is the only per-day figure
// portfolio/history actually provides. profit_loss is shown beside it
// as "cumulative from base_value" and is never differenced against the
// daily net. A day is conclusive only when every logged trade on it is
// fully resolved AND it lands on a bar that has an eqDelta; otherwise
// part of its net, or the benchmark itself, is missing and a residual
// proves nothing. That distinction is kept in the table rather than
// averaged away.
const DIFF_THRESHOLD = 25;

function dailyReconciliation(records, rows, orphanRows, histRows) {
  const exitDayOf = new Map(rows.map(r => [r.tradeId, r.exitTime.slice(0, 10)]));
  const days = new Map(); // day -> { rec, missing, orphan, nOrphan }
  const touch = d => { if (!days.has(d)) days.set(d, { rec: 0, missing: 0, orphan: 0, nOrphan: 0, nRec: 0 }); return days.get(d); };

  for (const r of records) {
    const d = exitDayOf.get(r.tradeId) || r.day;
    const e = touch(d);
    e.nRec++;
    if (r.pnlFullRepriced != null) e.rec += r.pnlFullRepriced; else e.missing++;
  }
  for (const o of orphanRows) {
    if (o.kind !== "reconstructed_trade") continue;
    const e = touch(o.day);
    e.orphan += o.pnl; e.nOrphan++;
  }

  console.log(`\n${"-".repeat(64)}\nمطابقة يومية: المسجّل + المعاد بناؤه مقابل eqDelta (تغيّر رصيد Alpaca اليومي)`);
  if (!histRows) { console.log("  لا بيانات portfolio/history — تُتخطّى المقارنة."); return; }

  const ourByDay = new Map([...days.entries()].map(([d, e]) => [d, e.rec + e.orphan]));
  console.log(`\n  اختبار إزاحة التاريخ (لا أفترضها — أقيسها):`);
  const off = pickDayOffset(ourByDay, histRows);

  const byDate = new Map(histRows.map(h => [h.date, h]));
  const shiftDate = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

  const table = [...days.keys()].sort().map(day => {
    const e = days.get(day);
    const h = byDate.get(shiftDate(day, off));
    const total = e.rec + e.orphan;
    const eqDelta = h?.eqDelta ?? null;              // the per-day benchmark
    return {
      day, ...e, total, eqDelta,
      plCum: h?.plCum ?? null,                       // cumulative — reference only
      barDate: h?.date ?? null,
      diff: eqDelta == null ? null : total - eqDelta,
      conclusive: e.missing === 0 && eqDelta != null,
      why: !h ? "لا بار مقابل" : eqDelta == null ? "أول بار، بلا سابق" : e.missing ? `${e.missing} صفقة بلا تسعير كامل` : "",
    };
  });

  console.log(`\n  يوم         صفقات  مسجّل     ناقص  يتيم(ن)      مجموع    eqDelta     الفرق   حاسم؟  plCum(مرجع)`);
  for (const t of table) {
    console.log(
      `  ${t.day}  ${String(t.nRec).padStart(5)}  ${money(t.rec).padStart(8)}  ${String(t.missing).padStart(4)}  ` +
      `${money(t.orphan).padStart(7)}(${t.nOrphan})  ${money(t.total).padStart(8)}  ` +
      `${(t.eqDelta == null ? "—" : money(t.eqDelta)).padStart(8)}  ${(t.diff == null ? "—" : money(t.diff)).padStart(8)}   ` +
      `${(t.conclusive ? "نعم" : "لا").padEnd(4)}  ${(t.plCum == null ? "—" : money(t.plCum)).padStart(9)}`
    );
  }

  const flagged = table.filter(t => t.diff != null && Math.abs(t.diff) > DIFF_THRESHOLD);
  console.log(`\n  أيام الفرق فيها > $${DIFF_THRESHOLD}: ${flagged.length} من ${table.length}`);
  flagged.forEach(t => console.log(
    `    ${t.day}  الفرق ${money(t.diff)}  (مجموعنا ${money(t.total)} مقابل eqDelta ${money(t.eqDelta)})` +
    `${t.conclusive ? "  — حاسم: كل صفقات اليوم مسعَّرة وللبار eqDelta" : `  — غير حاسم: ${t.why}`}`
  ));
  console.log(`  منها حاسمة: ${flagged.filter(t => t.conclusive).length}`);
  const noBar = table.filter(t => t.diff == null);
  if (noBar.length) {
    console.log(`\n  أيام بلا مقياس يومي (الفرق "—"، وغير حاسمة): ${noBar.length}`);
    noBar.forEach(t => console.log(`    ${t.day}  ${t.why}`));
  }
  console.log(`\n  ملاحظتان على المقياس:`);
  console.log(`  • eqDelta يشمل تقييم المراكز المفتوحة عند الإغلاق، فمركز لم يُغلق في يومه يُنتج فرقاً مشروعاً لا خطأً.`);
  console.log(`  • plCum تراكمي من base_value ولا يُعاد ضبطه — معروض للمرجع فقط ولم يُطرح من أي صافٍ يومي.`);
  return table;
}

// ─── STEP 6: summary ───
function summarize(records, rows, orphanFills = [], orphanRows = [], histRows = null) {
  const tally = key => {
    const c = {};
    records.forEach(r => c[r[key]] = (c[r[key]] || 0) + 1);
    return c;
  };
  const show = (label, c) => {
    console.log(`  ${label}`);
    for (const k of ["exact", "partial", "ambiguous", "unresolved"]) {
      const n = c[k] || 0;
      console.log(`    ${k.padEnd(11)} ${String(n).padStart(4)}  (${records.length ? (n / records.length * 100).toFixed(0) : 0}%)`);
    }
  };

  console.log(`\n${"=".repeat(64)}\nالملخص   (الإجمالي: ${records.length})`);
  show("الخروج (sell):", tally("confidence"));
  show("الدخول (buy):", tally("entryConfidence"));

  const noBuy = records.filter(r => r.entryConfidence === "unresolved").length;
  const retriedX = records.filter(r => r.exitRetried).length;
  const retriedE = records.filter(r => r.entryRetried).length;
  const rescuedX = records.filter(r => r.exitRetried && (r.confidence === "exact" || r.confidence === "partial")).length;
  const rescuedE = records.filter(r => r.entryRetried && (r.entryConfidence === "exact" || r.entryConfidence === "partial")).length;
  console.log(`\n  صفقات بلا تنفيذ شراء مطابق: ${noBuy}`);
  console.log(`  أُعيدت المحاولة بنافذة مضيّقة — خروج: ${retriedX} (حُسم ${rescuedX}) | دخول: ${retriedE} (حُسم ${rescuedE})`);
  console.log(`  صفقات تشارك عقدها صفقة أخرى: ${records.filter(r => r.siblingsOnContract > 1).length}`);

  // Three nets, each on the population it is actually valid for.
  const exitOk = records.filter(r => r.fillPrice != null);
  const full   = records.filter(r => r.fullyResolved && r.pnlFullRepriced != null);
  console.log(`\n-- الصافي، كل رقم على مجموعته الصحيحة --`);
  console.log(`  المسجّل (كل ${records.length} صفقة):            ${money(records.reduce((a, r) => a + r.pnlRecorded, 0))}`);
  if (exitOk.length) {
    console.log(`  خروج محسوم فقط (${exitOk.length} صفقة):`);
    console.log(`     المسجّل لها:        ${money(exitOk.reduce((a, r) => a + r.pnlRecorded, 0))}`);
    console.log(`     بالخروج المعاد:     ${money(exitOk.reduce((a, r) => a + r.pnlRepriced, 0))}`);
  } else console.log(`  لا صفقة بخروج محسوم.`);
  if (full.length) {
    console.log(`  الجانبان محسومان (${full.length} صفقة):`);
    console.log(`     المسجّل لها:        ${money(full.reduce((a, r) => a + r.pnlRecorded, 0))}`);
    console.log(`     بالخروج المعاد:     ${money(full.reduce((a, r) => a + r.pnlRepriced, 0))}`);
    console.log(`     بالجانبين (كامل):   ${money(full.reduce((a, r) => a + r.pnlFullRepriced, 0))}`);
    console.log(`     فرق الكامل عن المسجّل: ${money(full.reduce((a, r) => a + r.pnlFullDelta, 0))}`);
  } else console.log(`  لا صفقة محسومة الجانبين — لا يمكن حساب الصافي الكامل.`);

  const ed = records.map(r => r.entryDeltaPct).filter(x => x != null);
  const xd = records.map(r => r.deltaPct).filter(x => x != null);
  console.log(`\n-- انحراف السعر المسجّل عن التنفيذ --`);
  for (const [label, arr] of [["الدخول", ed], ["الخروج", xd]]) {
    if (!arr.length) { console.log(`  ${label}: لا بيانات`); continue; }
    const a = [...arr].sort((x, y) => x - y);
    console.log(`  ${label}: n=${a.length}  الوسيط ${median(a).toFixed(2)}%  المدى ${a[0].toFixed(2)}% → ${a[a.length - 1].toFixed(2)}%`);
  }
  console.log(`  (الدخول: موجب = دفعنا أكثر من المسجّل. الخروج: سالب = قبضنا أقل. كلاهما يقلّل الربح الحقيقي.)`);

  // The two 2026-09-21 trades carry 152% of v21's entire net profit.
  const key = records.filter(r => r.day === "2026-09-21");
  console.log(`\n-- صفقتا 2026-09-21 (تمثّلان 152% من صافي v21) --`);
  if (!key.length) console.log("  لا سجلات بهذا التاريخ في الملف.");
  else {
    key.forEach(r => console.log(
      `  ${r.symbol} ${r.signal}  مسجّل ${money(r.pnlRecorded)}  →  ` +
      (r.pnlFullRepriced != null ? `كامل ${money(r.pnlFullRepriced)} (فرق ${money(r.pnlFullDelta)})`
        : r.pnlRepriced != null ? `خروج فقط ${money(r.pnlRepriced)} — الدخول ${r.entryConfidence}`
        : `غير محسوم (خروج ${r.confidence} / دخول ${r.entryConfidence})`)
    ));
    const done = key.filter(r => r.fullyResolved);
    console.log(`  النتيجة: ${done.length === key.length && key.length === 2
      ? "✔ الصفقتان مؤكَّدتان الجانبين — ربح v21 الظاهر قائم على سعرَي تنفيذ حقيقيين"
      : `✖ غير مؤكَّدتين بالكامل (${done.length}/${key.length}) — ربح v21 الظاهر ما يزال غير متحقَّق منه`}`);
  }

  const unres = records.filter(r => r.confidence === "unresolved");
  if (unres.length) {
    const days = [...new Set(unres.map(r => r.day))].sort();
    console.log(`\n-- خروج unresolved: ${unres.length} صفقة على ${days.length} يوم (${days[0]} → ${days[days.length - 1]}) --`);
    console.log(`  أسباب محتملة: حدّ احتفاظ Alpaca، أو إغلاق بانتهاء صلاحية 0DTE`);
    console.log(`  (نشاط EXP/OPASN لا FILL)، أو تصفية من الوسيط. لا تُخمَّن أسعارها.`);
  }

  // ── orphan fills and what FIFO could rebuild from them ──
  console.log(`\n-- تنفيذات لم تُستهلك في أي صفقة محسومة --`);
  const unresolvedLogged = records.filter(r => r.confidence !== "exact" && r.confidence !== "partial").length;
  console.log(`  تنفيذات يتيمة: ${orphanFills.length}  (شراء ${orphanFills.filter(f => f.side === "buy").length} / بيع ${orphanFills.filter(f => f.side === "sell").length})`);
  console.log(`  ⚠ تلوّث المجموعة: ${unresolvedLogged} صفقة مسجّلة لم يُحسم خروجها، فتنفيذاتها الحقيقية داخل هذه المجموعة.`);
  console.log(`     أي أن "يتيم" تعني "غير منسوب لصفقة محسومة"، لا "دليل على صفقة غير مسجّلة".`);
  if (orphanFills.length) {
    const byDay = {};
    orphanFills.forEach(f => {
      const d = new Date(f.t).toISOString().slice(0, 10);
      (byDay[d] = byDay[d] || new Set()).add(f.symbol);
    });
    console.log(`  موزّعة على ${Object.keys(byDay).length} يوم و${new Set(orphanFills.map(f => f.symbol)).size} عقد:`);
    Object.keys(byDay).sort().forEach(d => {
      const n = orphanFills.filter(f => new Date(f.t).toISOString().slice(0, 10) === d).length;
      console.log(`    ${d}  ${String(n).padStart(3)} تنفيذ على ${byDay[d].size} عقد`);
    });
  }

  const rebuilt  = orphanRows.filter(o => o.kind === "reconstructed_trade");
  const unpaired = orphanRows.filter(o => o.kind === "unpaired_sell");
  const openLots = orphanRows.filter(o => o.kind === "open_lot");
  console.log(`\n-- إعادة البناء بـFIFO --`);
  console.log(`  صفقات معاد بناؤها: ${rebuilt.length}  (منها ${rebuilt.filter(o => o.split).length} ازدواج جزئي)`);
  console.log(`  صافيها بالتنفيذ: ${rebuilt.length ? money(rebuilt.reduce((a, o) => a + o.pnl, 0)) : "—"}`);
  console.log(`  بيع بلا مخزون مقابل: ${unpaired.length}${unpaired.length ? ` (${unpaired.reduce((a, o) => a + o.qty, 0)} عقد)` : ""} — لا pnl، لا تخمين`);
  console.log(`  شراء بلا بيع (مركز مفتوح أو خارج المدى): ${openLots.length}${openLots.length ? ` (${openLots.reduce((a, o) => a + o.qty, 0)} عقد)` : ""} — لا pnl، لا تخمين`);
  if (rebuilt.length) {
    console.log(`  أكبر 5 معاد بناؤها:`);
    [...rebuilt].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 5).forEach(o =>
      console.log(`    ${o.day} ${o.optionSymbol}  q=${o.qty}  ${o.entryPrice}→${o.exitPrice}  ${money(o.pnl)}  (${o.holdSec}s)`));
  }

  dailyReconciliation(records, rows, orphanRows, histRows);

  checkLookalikes(rows);
  console.log(`${"=".repeat(64)}`);
}

// ─── MAIN ───
async function main() {
  console.log(`=== reprice audit (v21) — قراءة فقط — ${new Date().toISOString()} ===`);
  console.log(`  المدخل: ${IN_FILE}   المخرج: ${OUT_FILE}`);

  const rows = readOutcomes();
  console.log(`✔ قُرئ ${rows.length} سجلاً${rows.length ? ` (${rows[0].day} → ${rows[rows.length - 1].day})` : ""}`);
  const bounds = buildChain(rows);
  const shared = rows.filter(r => (bounds.get(r.tradeId)?.siblings || 1) > 1).length;
  console.log(`  صفقات تشارك عقدها صفقة أخرى: ${shared} — نوافذها ستُضيَّق عند أي التباس`);

  if (DRY_RUN) {
    console.log("\n⚠ --dry-run: لا اتصال بالشبكة، لا مفاتيح، لا كتابة.");
    console.log("  يُشغّل منطق المطابقة وإعادة البناء على مجموعة تنفيذات فارغة للتحقق من المسارات فقط.");
    const empty = indexFills([]);
    const resolutions = rows.map(r => ({ rec: r, m: resolveTrade(r, empty, bounds) }));
    const records = resolutions.map(({ rec, m }) => buildRecord(rec, m));
    const orphanFills = collectOrphans(empty, collectConsumed(resolutions));
    summarize(records, rows, orphanFills, reconstructFifo(orphanFills), null);
    console.log("\n✔ dry-run انتهى. كل سجل unresolved على الجانبين، وصفر يتيم، كما هو متوقَّع بلا بيانات.");
    return;
  }

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.error("\n✖ ALPACA_KEY_2 و/أو ALPACA_SECRET_2 غير معرّفين في البيئة — توقّف.");
    console.error("  شغّله حيث المتغيّران موجودان (Console الحاوية أو جهازك).");
    console.error("  لفحص الصياغة والمنطق بلا مفاتيح: node reprice_audit.mjs --dry-run");
    process.exit(1);
  }

  console.log("\n--- 1) التحقق من الحساب ---");
  await verifyAccount();

  console.log("\n--- 2) مدى احتفاظ Alpaca بالسجل ---");
  await probeRetention();

  console.log("\n--- 3) جلب كل التنفيذات ---");
  const fills = await fetchAllFills();

  console.log("\n--- 4) المطابقة (دخول وخروج، مع إعادة محاولة مضيّقة) ---");
  const bySymbol = indexFills(fills);
  const sides = { buy: 0, sell: 0 };
  for (const list of bySymbol.values()) list.forEach(f => sides[f.side]++);
  console.log(`  تنفيذات على ${bySymbol.size} عقد مختلف — شراء ${sides.buy} / بيع ${sides.sell}`);
  const resolutions = rows.map(r => ({ rec: r, m: resolveTrade(r, bySymbol, bounds) }));
  const records = resolutions.map(({ rec, m }) => buildRecord(rec, m));

  console.log("\n--- 5) التنفيذات اليتيمة وإعادة بنائها ---");
  const orphanFills = collectOrphans(bySymbol, collectConsumed(resolutions));
  const orphanRows = reconstructFifo(orphanFills);
  console.log(`  ${orphanFills.length} تنفيذ يتيم → ${orphanRows.filter(o => o.kind === "reconstructed_trade").length} صفقة معاد بناؤها، ` +
              `${orphanRows.filter(o => o.kind === "unpaired_sell").length} بيع بلا مقابل، ` +
              `${orphanRows.filter(o => o.kind === "open_lot").length} شراء بلا بيع`);

  console.log("\n--- 6) منحنى الرصيد من Alpaca (المقياس اليومي = eqDelta) ---");
  const histRows = await fetchPortfolioHistory();

  console.log("\n--- 7) الكتابة ---");
  writeJsonl(records, OUT_FILE, OUT_FILE, "سجلاً");
  writeJsonl(orphanRows, ORPHAN_FILE, ORPHAN_FILE, "سطراً");
  console.log("  (ولم يُلمس أي ملف آخر)");

  summarize(records, rows, orphanFills, orphanRows, histRows);
}

main().catch(e => {
  console.error("✖ خطأ غير متوقَّع:", e.message);
  process.exit(1);
});
