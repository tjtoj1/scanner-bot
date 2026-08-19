// ============================================================
// ANALYZE v21 — Daily report + cumulative analysis
// ============================================================
import fs from "fs";

const TG_TOKEN      = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const ALPACA_KEY    = process.env.ALPACA_KEY_2;
const ALPACA_SECRET = process.env.ALPACA_SECRET_2;
const TRADING_BASE  = "https://paper-api.alpaca.markets/v2";

function readJSONL(p) {
  try { return fs.readFileSync(p,"utf8").split("\n").filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); }
  catch { return []; }
}

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({chat_id:PERSONAL_CHAT,text,parse_mode:"HTML"})
  });
}

function st(rows) {
  const w=rows.filter(r=>r.win).length;
  const net=rows.reduce((a,r)=>a+r.pnl,0);
  return `${rows.length}ص | WR ${rows.length?Math.round(w/rows.length*100):0}% | ${net>=0?"+":""}$${net}`;
}

(async()=>{
  const today = new Date().toLocaleDateString("en-CA",{timeZone:"America/Chicago"});
  const rows = readJSONL("outcomes_v21.jsonl");
  const todayRows = rows.filter(r=>r.day===today);

  // Get account
  const acct = await fetch(`${TRADING_BASE}/account`,{
    headers:{"APCA-API-KEY-ID":ALPACA_KEY,"APCA-API-SECRET-KEY":ALPACA_SECRET}
  }).then(r=>r.json());
  const portfolio  = parseFloat(acct.portfolio_value);
  const lastEquity = parseFloat(acct.last_equity);
  const dailyPnl   = portfolio - lastEquity;

  // Daily report
  const won  = todayRows.filter(r=>r.win).length;
  const lost = todayRows.filter(r=>!r.win).length;
  const best = todayRows.reduce((a,r)=>r.pnlPct>a?r.pnlPct:a, -Infinity);
  const worst= todayRows.reduce((a,r)=>r.pnlPct<a?r.pnlPct:a, Infinity);

  let msg = `📊 <b>v21 Daily Report - ${new Date().toLocaleDateString("en-US",{weekday:"short",month:"short",day:"2-digit",year:"numeric",timeZone:"America/Chicago"})}</b>\n\n`;
  msg += `💼 الصفقات: ${todayRows.length}\n`;
  msg += `✅ ربحانة: ${won} | ❌ خسرانة: ${lost}\n`;
  msg += `💎 الواقع: ${dailyPnl>=0?"✅":"❌"} ${dailyPnl>=0?"+":""}$${dailyPnl.toFixed(0)} (${(dailyPnl/lastEquity*100).toFixed(2)}%)\n`;
  if (todayRows.length) {
    msg += `🥇 أفضل: ${best.toFixed(1)}%\n`;
    msg += `🥉 أسوأ: ${worst.toFixed(1)}%\n`;
  }
  msg += `📈 الرصيد: $${portfolio.toFixed(0)}\n`;

  // Cumulative
  if (rows.length >= 5) {
    const days = [...new Set(rows.map(r=>r.day))].length;
    msg += `\n<b>📐 تراكمي — ${days} أيام | ${rows.length} صفقة</b>\n`;
    msg += `الكل: ${st(rows)}\n`;
    msg += `\nSPY: ${st(rows.filter(r=>r.symbol==="SPY"))}\n`;
    msg += `QQQ: ${st(rows.filter(r=>r.symbol==="QQQ"))}\n`;
    msg += `\nCALL: ${st(rows.filter(r=>r.signal==="CALL"))}\n`;
    msg += `PUT:  ${st(rows.filter(r=>r.signal==="PUT"))}\n`;

    // Exit reasons
    const structural = rows.filter(r=>r.reason==="structural_stop");
    const ladder     = rows.filter(r=>r.reason==="ladder_stop");
    const hard       = rows.filter(r=>r.reason==="hard_stop");
    const force      = rows.filter(r=>r.reason==="force_exit");
    if (structural.length||ladder.length||hard.length||force.length) {
      msg += `\n<b>أسباب الخروج:</b>\n`;
      if (structural.length) msg += `وقف بنيوي: ${st(structural)}\n`;
      if (ladder.length)     msg += `وقف ربح:   ${st(ladder)}\n`;
      if (hard.length)       msg += `وقف خسارة: ${st(hard)}\n`;
      if (force.length)      msg += `إجباري:    ${st(force)}\n`;
    }
  }

  console.log(msg.replace(/<[^>]+>/g,""));
  await tg(msg);
})();
