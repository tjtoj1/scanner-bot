// ============================================================
// DAILY REPORT — combined v21 + LAB performance report, sent to
// Telegram once per day after market close. Invoked by runner.js
// within a fixed window (20:35-21:00 UTC); self-guards against
// re-sending the same day via report_state.json.
//
// Read-only: never touches scan_v21.js, scan_lab.js, or any state
// file other than its own report_state.json flag. The v21
// "improvement suggestion" section is data-justified text only —
// nothing here ever modifies strategy or trading logic. LAB's own
// changelog entries (if any fired today) are reported as fact, since
// LAB's self-tuning is pre-approved and already applied by scan_lab.js.
// ============================================================
import fs from "fs";

const TG_TOKEN      = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";

function readJSONL(path) {
  try {
    return fs.readFileSync(path, "utf8").split("\n").filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function readJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
}
function loadReportState() {
  try { return JSON.parse(fs.readFileSync("report_state.json", "utf8")); } catch { return {}; }
}
function saveReportState(s) { fs.writeFileSync("report_state.json", JSON.stringify(s, null, 2)); }

async function tg(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode: "HTML" }),
    });
    return await res.json();
  } catch (e) { console.error("tg failed:", e.message); return null; }
}

function stats(rows) {
  const n = rows.length;
  const wins = rows.filter(r => r.win).length;
  const wr = n ? Math.round(wins / n * 100) : 0;
  const net = rows.reduce((a, r) => a + r.pnl, 0);
  return { n, wr, net };
}
function fmtStats(rows) {
  const s = stats(rows);
  return `${s.n} صفقة | WR ${s.wr}% | ${s.net >= 0 ? "+" : ""}$${s.net}`;
}
function groupBy(rows, key) {
  const groups = {};
  for (const r of rows) { (groups[r[key]] ||= []).push(r); }
  return groups;
}

function detectPatterns(rows) {
  const notes = [];
  const n = rows.length;
  if (n < 2) return notes;

  for (const [reason, rs] of Object.entries(groupBy(rows, "reason"))) {
    if (n >= 3 && rs.length / n >= 0.5) {
      notes.push(`سبب الخروج "${reason}" يهيمن على ${rs.length}/${n} صفقة (${Math.round(rs.length/n*100)}%).`);
    }
  }
  for (const [sym, rs] of Object.entries(groupBy(rows, "symbol"))) {
    if (rs.length >= 2 && rs.every(r => !r.win)) {
      notes.push(`${sym}: كل صفقاته اليوم (${rs.length}) خاسرة.`);
    }
  }
  const entryTimes = rows.map(r => new Date(r.entryTime).getTime()).sort((a, b) => a - b);
  if (entryTimes.length >= 2) {
    const spanMin = (entryTimes[entryTimes.length - 1] - entryTimes[0]) / 60000;
    if (spanMin <= 15) {
      notes.push(`كل الدخول تركّز خلال ${spanMin.toFixed(0)} دقيقة فقط.`);
    }
  }
  const lateAlpacaStops = rows.filter(r => {
    if (r.reason !== "alpaca_stop" && r.reason !== "alpaca_stop_est") return false;
    const holdMin = (new Date(r.exitTime) - new Date(r.entryTime)) / 60000;
    return holdMin > 60;
  });
  if (lateAlpacaStops.length) {
    notes.push(`${lateAlpacaStops.length} صفقة أُغلقت عبر alpaca_stop بعد أكثر من ساعة من الدخول — احتمال تأخر مراقبة، السعر المسجَّل قد لا يعكس سعر التنفيذ الفعلي.`);
  }
  return notes;
}

function suggestV21Improvement(todayRows, allRows) {
  const rows = allRows.length >= 10 ? allRows : todayRows;
  if (rows.length < 3) {
    return "البيانات المتوفرة قليلة جداً (أقل من 3 صفقات) لاقتراح موثوق مبني على أرقام حقيقية.";
  }
  const byReason = groupBy(rows, "reason");
  const alpacaStop = byReason["alpaca_stop"] || [];
  const hardStop = byReason["hard_stop"] || [];
  const n = rows.length;

  if (alpacaStop.length / n > 0.4) {
    return `${alpacaStop.length}/${n} صفقة (${Math.round(alpacaStop.length/n*100)}%) أُغلقت عبر alpaca_stop — أي اكتُشف إغلاقها متأخراً بدل أن يديرها monitorPosition مباشرة وقت وقوعه. مقترح للمراجعة: تحقّق من استقرار جدولة Railway حول أوقات هذه الصفقات تحديداً.`;
  }
  if (hardStop.length / n > 0.4) {
    return `${hardStop.length}/${n} صفقة أُغلقت عبر وقف الخسارة الصلب (-35%) — نسبة مرتفعة قد تستدعي مراجعة شرط الدخول (تأكيد الحجم/الاتجاه) لتقليل الإشارات الضعيفة.`;
  }
  const wr = Math.round(rows.filter(r => r.win).length / n * 100);
  return `نسبة الربح الحالية ${wr}% على عينة ${n} صفقة — لا يوجد نمط حاد واحد يبرر تغييراً محدداً اليوم؛ يُنصح بمتابعة تراكم البيانات.`;
}

// Net PnL as a share of (a) the account and (b) the capital actually
// put at risk. On a ~$99k paper account the first number is near zero
// for any realistic day, so it alone says nothing about whether the
// strategy worked; costBasis is the option premium actually spent
// (recorded per trade by scan_wvad.js). Older v21/LAB rows have no
// costBasis — that line is simply omitted for them.
function pctLine(rows, portfolioValue) {
  const net = rows.reduce((a, r) => a + r.pnl, 0);
  const parts = [];
  if (portfolioValue > 0) {
    parts.push(`${(net / portfolioValue * 100).toFixed(2)}% من المحفظة`);
  }
  const deployed = rows.reduce((a, r) => a + (r.costBasis || 0), 0);
  if (deployed > 0) {
    parts.push(`${(net / deployed * 100).toFixed(1)}% من رأس المال المنشور ($${deployed})`);
  }
  return parts.length ? `📐 ${parts.join(" | ")}\n` : "";
}

function buildBotSection(title, todayRows, activeSymbols, portfolioValue = 0) {
  let msg = `\n<b>━━ ${title} ━━</b>\n`;
  if (!todayRows.length) {
    msg += `لا صفقات مغلقة اليوم.\n`;
  } else {
    const s = stats(todayRows);
    const best = todayRows.reduce((a, r) => (!a || r.pnlPct > a.pnlPct) ? r : a, null);
    const worst = todayRows.reduce((a, r) => (!a || r.pnlPct < a.pnlPct) ? r : a, null);
    msg += `📋 ${s.n} صفقة | WR ${s.wr}% | صافي ${s.net>=0?"+":""}$${s.net}\n`;
    msg += pctLine(todayRows, portfolioValue);
    msg += `🥇 أفضل: ${best.symbol} ${best.signal} ${best.pnlPct.toFixed(1)}% (${best.pnl>=0?"+":""}$${best.pnl})\n`;
    msg += `🥉 أسوأ: ${worst.symbol} ${worst.signal} ${worst.pnlPct.toFixed(1)}% (${worst.pnl>=0?"+":""}$${worst.pnl})\n`;

    const bySymbol = groupBy(todayRows, "symbol");
    msg += `حسب الرمز: ` + Object.entries(bySymbol).map(([k, r]) => `${k}(${fmtStats(r)})`).join(" | ") + "\n";
    const bySignal = groupBy(todayRows, "signal");
    msg += `حسب الاتجاه: ` + Object.entries(bySignal).map(([k, r]) => `${k}(${fmtStats(r)})`).join(" | ") + "\n";
    const byReason = groupBy(todayRows, "reason");
    msg += `حسب سبب الخروج: ` + Object.entries(byReason).map(([k, r]) => `${k}(${fmtStats(r)})`).join(" | ") + "\n";

    const patterns = detectPatterns(todayRows);
    if (patterns.length) msg += `\n🔍 ملاحظات:\n` + patterns.map(p => `- ${p}`).join("\n") + "\n";
  }
  if (activeSymbols.length) msg += `\n📌 مفتوحة الآن: ${activeSymbols.join(", ")}\n`;
  return msg;
}

// strategy_lab.json's changelog holds two entry shapes: combo tier changes
// (comboKey/oldTier/newTier/oldMultiplier/newMultiplier) and the older
// global-parameter entries (param/oldValue/newValue) from the tuner retired
// on 2026-09-02. Rendering everything with the parameter fields printed
// "undefined: undefined → undefined" for the first combo entry that ever
// fired — the combo path had existed for a while but had never produced an
// entry, so the mismatch stayed hidden.
function formatLabChange(c) {
  const reason = c.reason ? `  السبب: ${c.reason}\n` : "";

  if (c.type === "combo_tier_change") {
    const stats = [
      c.sampleSize != null ? `${c.sampleSize} صفقة` : null,
      c.winRate != null ? `WR ${c.winRate}%` : null,
      c.netPnl != null ? `صافي $${c.netPnl}` : null,
      c.avgPnlPct != null ? `متوسط ${c.avgPnlPct}%${c.se != null ? ` ± ${c.se}pp` : ""}` : null,
    ].filter(Boolean).join(" | ");
    return `- <b>${c.comboKey}</b>: ${c.oldTier ?? "أول تصنيف"} → ${c.newTier} `
      + `(الحجم ×${c.oldMultiplier} → ×${c.newMultiplier})\n`
      + (stats ? `  العيّنة: ${stats}\n` : "")
      + reason;
  }

  if (c.param !== undefined) {
    return `- <b>${c.param}</b>: ${c.oldValue} → ${c.newValue}\n` + reason;
  }

  // Any future entry type: show what it is and let the reason explain it,
  // rather than printing undefined fields.
  return `- <b>${c.type || "تعديل"}</b>\n` + reason;
}

function buildLabChangesSection(strategy, today) {
  const todayChanges = (strategy.changelog || []).filter(c => c.date === today);
  if (!todayChanges.length) return `\n<b>🧪 تعديلات LAB اليوم:</b> لا تعديل اليوم.\n`;
  let msg = `\n<b>🧪 تعديلات LAB اليوم (تلقائية — مُوافَق عليها مسبقاً):</b>\n`;
  for (const c of todayChanges) msg += formatLabChange(c);
  return msg;
}

// Equity of the WVAD account (the original ALPACA_KEY pair) — used
// only to express that bot's net PnL as a share of the account.
// Never fails the report: on any error the percentage line is simply
// dropped, leaving the section exactly as it would have been.
async function wvadPortfolioValue() {
  const key = process.env.ALPACA_KEY, secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return 0;
  try {
    const res = await fetch("https://paper-api.alpaca.markets/v2/account", {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
    });
    const d = await res.json();
    return parseFloat(d.portfolio_value) || 0;
  } catch (e) { console.error("[daily_report] wvad account fetch failed:", e.message); return 0; }
}

(async () => {
  const rs = loadReportState();
  const labState = readJSON("state_lab.json", {});
  const wvadState = readJSON("state_wvad.json", {});
  // LAB stays the primary clock (unchanged); the other two are
  // fallbacks so the report still fires on a day only they traded.
  const today = labState._lastDay || readJSON("state_v21.json", {})._lastDay || wvadState._lastDay;

  if (!today) {
    console.log("[daily_report] no trading day recorded in any state file — skipping");
    return;
  }

  if (rs.lastSentDay === today) {
    console.log(`[daily_report] already sent for ${today} — skipping`);
    return;
  }

  const v21Outcomes = readJSONL("outcomes_v21.jsonl");
  const v21Today = v21Outcomes.filter(r => r.day === today);
  const v21State = readJSON("state_v21.json", {});
  const v21Active = Object.keys(v21State).filter(k => !k.startsWith("_") && k !== "range" && v21State[k]?.active);

  const labOutcomes = readJSONL("outcomes_lab.jsonl");
  const labToday = labOutcomes.filter(r => r.day === today);
  const labActive = Object.keys(labState).filter(k => !k.startsWith("_") && labState[k]?.active);
  const strategy = readJSON("strategy_lab.json", { params: {}, changelog: [] });

  const wvadOutcomes = readJSONL("outcomes_wvad.jsonl");
  const wvadToday = wvadOutcomes.filter(r => r.day === today);
  const wvadActive = Object.keys(wvadState).filter(k => !k.startsWith("_") && wvadState[k]?.active);

  const hasData = v21Today.length > 0 || labToday.length > 0 || wvadToday.length > 0;
  if (!hasData) {
    console.log(`[daily_report] no trades found for ${today} — skipping to avoid empty report`);
    return;
  }

  let msg = `📊 <b>التقرير اليومي — ${today}</b>\n`;
  msg += buildBotSection("v21 ORB", v21Today, v21Active);
  msg += `\n💡 <b>اقتراح تحسين v21 — للمراجعة فقط، لا يُنفَّذ إلا بموافقة المستخدم و Claude معاً:</b>\n${suggestV21Improvement(v21Today, v21Outcomes)}\n`;
  msg += buildBotSection("LAB", labToday, labActive);
  msg += buildLabChangesSection(strategy, today);
  msg += buildBotSection("WVAD (SPY/QQQ)", wvadToday, wvadActive, await wvadPortfolioValue());

  const result = await tg(msg);
  if (result && result.ok) {
    console.log("[daily_report] sent successfully.");
    rs.lastSentDay = today;
    saveReportState(rs);
  } else {
    console.error("[daily_report] send failed, will retry next cycle:", JSON.stringify(result));
  }
})();
