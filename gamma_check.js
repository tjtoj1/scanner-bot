// ============================================================
// GAMMA LEVELS CHECK — standalone research script
// Does NOT touch the trading bot. Fetches dealer-positioning levels
// (GEX, gamma flip, call wall, put wall) once per day for individual
// stocks (free tier = equities only, no ETFs), sends them to Telegram,
// and appends them to gamma_log.jsonl for later study.
//
// Free tier = 5 requests/day, so we query 3 tickers and keep 2 spare.
// ============================================================

import fs from "fs";

const FA_KEY = process.env.FLASHALPHA_KEY;
const TG_TOKEN = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";

if (!FA_KEY || !TG_TOKEN) {
  console.log("Missing FLASHALPHA_KEY or TG_TOKEN");
  process.exit(1);
}

const BASE = "https://lab.flashalpha.com";
// Free tier: individual US equities only (NOT SPY/QQQ/IWM/GLD)
const TICKERS = ["NVDA", "TSLA", "MSTR"];

async function faGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Api-Key": FA_KEY },
  });
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 300), remaining };
  }
  try {
    return { ok: true, data: JSON.parse(text), remaining };
  } catch (e) {
    return { ok: false, status: "parse", body: text.slice(0, 300), remaining };
  }
}

// The exact response shape isn't documented publicly, so pull values
// defensively by trying several likely field names.
function pick(obj, ...names) {
  if (!obj || typeof obj !== "object") return null;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  // one level deeper
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      for (const n of names) {
        if (v[n] !== undefined && v[n] !== null) return v[n];
      }
    }
  }
  return null;
}

function fmt(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
    return v.toFixed(2);
  }
  return String(v);
}

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode: "HTML" }),
    });
    const d = await res.json();
    if (!d.ok) console.error("TG error:", JSON.stringify(d).slice(0, 200));
  } catch (e) {
    console.error("Telegram failed:", e.message);
  }
}

(async () => {
  const today = new Date().toISOString().split("T")[0];
  console.log(`=== Gamma check ${new Date().toISOString()} ===`);

  let msg = `📊 <b>مستويات الجاما — ${today}</b>\n`;
  const records = [];

  for (const t of TICKERS) {
    const r = await faGet(`/v1/exposure/summary/${t}`);

    if (!r.ok) {
      console.log(`${t}: FAILED ${r.status} ${r.body}`);
      msg += `\n❌ <b>${t}</b> — خطأ ${r.status}\n<code>${String(r.body).slice(0, 120)}</code>\n`;
      records.push({ d: today, t, error: r.status, body: r.body });
      continue;
    }

    const d = r.data;
    // Log the full raw payload once so we can map fields exactly next run
    console.log(`${t} RAW:`, JSON.stringify(d).slice(0, 1200));

    const spot      = pick(d, "spot", "spot_price", "price", "underlying_price", "last");
    const gex       = pick(d, "gex", "total_gex", "net_gex", "gamma_exposure");
    const gammaFlip = pick(d, "gamma_flip", "gammaFlip", "flip_point", "zero_gamma", "flip");
    const callWall  = pick(d, "call_wall", "callWall", "call_resistance");
    const putWall   = pick(d, "put_wall", "putWall", "put_support");
    const maxPain   = pick(d, "max_pain", "maxPain");

    const regime = typeof gex === "number"
      ? (gex >= 0 ? "موجب (مستقر ↔)" : "سالب (متقلب ⚡)")
      : "—";

    msg += `\n<b>${t}</b>  ${spot !== null ? "$" + fmt(spot) : ""}\n`;
    msg += `  GEX: ${fmt(gex)}  ${typeof gex === "number" ? `→ ${regime}` : ""}\n`;
    if (gammaFlip !== null) msg += `  🔄 انقلاب الجاما: $${fmt(gammaFlip)}\n`;
    if (callWall !== null)  msg += `  🧱 جدار الكول: $${fmt(callWall)}\n`;
    if (putWall !== null)   msg += `  🛡 جدار البوت: $${fmt(putWall)}\n`;
    if (maxPain !== null)   msg += `  🎯 Max Pain: $${fmt(maxPain)}\n`;

    records.push({
      d: today, t, spot, gex, gammaFlip, callWall, putWall, maxPain,
      raw: d, // keep full payload for later analysis
    });

    if (r.remaining) console.log(`  quota remaining: ${r.remaining}`);
  }

  msg += `\n<i>للمراجعة فقط — البوت لا يتداول على هذي</i>`;

  // Append to log for later study
  try {
    for (const rec of records) {
      fs.appendFileSync("gamma_log.jsonl", JSON.stringify(rec) + "\n");
    }
    console.log(`Logged ${records.length} records`);
  } catch (e) {
    console.error("Log write failed:", e.message);
  }

  await sendTelegram(msg);
  console.log("Done.");
})();
