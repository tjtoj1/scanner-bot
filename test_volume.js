// ============================================================
// VOLUME HYPOTHESIS TEST — standalone, reads outcomes.jsonl.
// Question: our data keeps showing high-volume signals LOSE and
// normal-volume signals WIN — the opposite of textbook breakout theory.
// This script quantifies: if we had SKIPPED every high-volume (volSurge)
// signal, what happens to WR and net P&L? Sends the verdict to Telegram.
//
// Does NOT touch the bot. Pure read + analysis.
// Excludes the poisoned 07-23 day (last_equity bug).
// ============================================================
import fs from "fs";

const TG_TOKEN = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const EXCLUDE_DAYS = new Set(["2026-07-23"]); // last_equity bug day

function readJSONL(path) {
  try {
    return fs.readFileSync(path, "utf8").split("\n").filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

async function sendTelegram(text) {
  if (!TG_TOKEN) { console.log("(no TG_TOKEN — console only)"); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode: "HTML" }),
    });
    const d = await res.json();
    if (!d.ok) console.error("TG:", JSON.stringify(d).slice(0, 200));
  } catch (e) { console.error("TG failed:", e.message); }
}

function stat(rows) {
  const w = rows.filter(r => r.win).length;
  const net = rows.reduce((a, r) => a + r.pnl, 0);
  const wr = rows.length ? Math.round(w / rows.length * 100) : 0;
  return { n: rows.length, w, wr, net };
}

(async () => {
  let rows = readJSONL("outcomes.jsonl").filter(r => !EXCLUDE_DAYS.has(r.day));
  const days = [...new Set(rows.map(r => r.day))].sort();

  if (rows.length < 15) {
    const msg = `🔬 <b>اختبار فرضية الحجم</b>\n\nالعينة ${rows.length} صفقة — صغيرة. نحتاج 30+ للحكم.`;
    console.log(msg.replace(/<[^>]+>/g, ""));
    await sendTelegram(msg);
    return;
  }

  const all = stat(rows);
  const surge = stat(rows.filter(r => r.volSurge === true));
  const normal = stat(rows.filter(r => r.volSurge === false));

  // The simulated strategy: skip volSurge signals entirely
  const filtered = stat(rows.filter(r => r.volSurge !== true));

  let m = `🔬 <b>اختبار فرضية الحجم</b>\n`;
  m += `${days.length} أيام | ${all.n} صفقة (بدون 07-23)\n`;
  m += `\n<b>الوضع الحالي (كل الصفقات):</b>\n`;
  m += `  WR ${all.wr}% | ${all.net >= 0 ? "+" : ""}$${all.net}\n`;

  m += `\n<b>التقسيم حسب الحجم:</b>\n`;
  m += `  🔴 حجم مرتفع: ${surge.n}ص | WR ${surge.wr}% | ${surge.net >= 0 ? "+" : ""}$${surge.net}\n`;
  m += `  🟢 حجم عادي:  ${normal.n}ص | WR ${normal.wr}% | ${normal.net >= 0 ? "+" : ""}$${normal.net}\n`;

  m += `\n<b>لو تجاهلنا الحجم المرتفع:</b>\n`;
  m += `  WR ${filtered.wr}% | ${filtered.net >= 0 ? "+" : ""}$${filtered.net}\n`;

  const wrGain = filtered.wr - all.wr;
  const netGain = filtered.net - all.net;
  m += `\n<b>الفرق:</b> WR ${wrGain >= 0 ? "+" : ""}${wrGain} نقطة | ${netGain >= 0 ? "+" : ""}$${netGain}\n`;

  // verdict
  m += `\n<b>الحكم:</b>\n`;
  if (surge.n < 8 || normal.n < 8) {
    m += `⚠ عينة صغيرة بأحد الجانبين (مرتفع ${surge.n}, عادي ${normal.n}). مؤشر أولي فقط.\n`;
  }
  if (filtered.net > all.net && surge.wr < normal.wr - 15) {
    m += `✅ الفرضية تصمد: تجاهل الحجم المرتفع يحسّن النتيجة بـ ${netGain >= 0 ? "+" : ""}$${netGain}.\n`;
    m += `الحجم المرتفع = ارتدادات فاشلة (السعر يكسر بدل ما يرتد).`;
  } else if (filtered.net < all.net) {
    m += `❌ الفرضية تسقط: التجاهل يقلّل الربح. الحجم مو السبب.`;
  } else {
    m += `🟡 غير حاسم: الفرق صغير. نحتاج أيام أكثر.`;
  }

  // Per-day robustness: does it hold EVERY day, or driven by one day?
  m += `\n\n<b>هل يصمد كل يوم؟</b>\n`;
  for (const d of days) {
    const dr = rows.filter(r => r.day === d);
    const ds = stat(dr.filter(r => r.volSurge === true));
    const dn = stat(dr.filter(r => r.volSurge !== true));
    const arrow = ds.wr < dn.wr ? "✓" : ds.wr > dn.wr ? "✗" : "=";
    m += `  ${d.slice(5)}: مرتفع ${ds.wr}% / عادي ${dn.wr}% ${arrow}\n`;
  }
  m += `\n<i>✓ = العادي أفضل (يدعم الفرضية)</i>`;

  console.log(m.replace(/<[^>]+>/g, ""));
  await sendTelegram(m);
})();
