// ============================================================
// BREAKOUT-CONFIRMATION TEST — standalone, reads outcomes.jsonl.
// Splits every clean trade into 4 quadrants: volume(surge/normal) x
// close(beyond level / not). Shows WR + P&L per quadrant, per day.
// Goal: verify Abdullah's rule —
//   high volume + close BEYOND level = confirmed breakout → trade WITH it
//   normal volume + close not beyond  = clean rejection    → trade AGAINST (current)
// Does NOT touch the bot. Excludes poisoned 07-23.
// ============================================================
import fs from "fs";

const TG_TOKEN = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const EXCLUDE = new Set(["2026-07-23"]);

function readJSONL(p){try{return fs.readFileSync(p,"utf8").split("\n").filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch(e){return null}}).filter(Boolean)}catch(e){return[]}}
async function sendTelegram(text){
  if(!TG_TOKEN){console.log("(no TG_TOKEN)");return;}
  try{const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:PERSONAL_CHAT,text,parse_mode:"HTML"})});const d=await res.json();if(!d.ok)console.error("TG:",JSON.stringify(d).slice(0,200));}catch(e){console.error(e.message);}
}
function stat(g){const w=g.filter(r=>r.win).length;const net=g.reduce((a,r)=>a+r.pnl,0);return{n:g.length,w,wr:g.length?Math.round(w/g.length*100):0,net}}
function fmtLine(s){return `${s.n}ص | WR ${s.wr}% | ${s.net>=0?"+":""}$${s.net}`}

(async()=>{
  let rows=readJSONL("outcomes.jsonl").filter(r=>!EXCLUDE.has(r.day));
  const days=[...new Set(rows.map(r=>r.day))].sort();

  if(rows.length<15){
    const m=`🔬 <b>اختبار الاختراق المؤكد</b>\n\nالعينة ${rows.length} صفقة — صغيرة. نحتاج 30+.`;
    console.log(m.replace(/<[^>]+>/g,""));await sendTelegram(m);return;
  }

  const q = {
    hiBreak: rows.filter(r=>r.volSurge===true  && r.beyond===true),   // confirmed breakout
    hiRej:   rows.filter(r=>r.volSurge===true  && r.beyond===false),  // high-vol rejection
    loBreak: rows.filter(r=>r.volSurge===false && r.beyond===true),
    loRej:   rows.filter(r=>r.volSurge===false && r.beyond===false),  // clean rejection
  };

  let m=`🔬 <b>اختبار الاختراق المؤكد</b>\n${days.length} أيام | ${rows.length} صفقة (بدون 07-23)\n`;
  m+=`\n<b>الفئات الأربع:</b>\n`;
  m+=`🚀 حجم مرتفع + اختراق: ${fmtLine(stat(q.hiBreak))}\n`;
  m+=`🔴 حجم مرتفع + رفض:   ${fmtLine(stat(q.hiRej))}\n`;
  m+=`🟡 حجم عادي + اختراق: ${fmtLine(stat(q.loBreak))}\n`;
  m+=`🟢 حجم عادي + رفض:    ${fmtLine(stat(q.loRej))}\n`;

  // The rule Abdullah proposes:
  //  - hiBreak: currently traded AS rejection (wrong way). If reversed → wins flip.
  //  - loRej: keep as-is (rejection works here).
  const hb=stat(q.hiBreak);
  m+=`\n<b>الفكرة: نعكس فئة "حجم مرتفع + اختراق"</b>\n`;
  if(q.hiBreak.length){
    const revWins=q.hiBreak.filter(r=>!r.win).length;
    const revNet=q.hiBreak.reduce((a,r)=>a+(r.win?-Math.abs(r.pnl)*0.7:Math.abs(r.pnl)),0);
    m+=`  الحالي (ضد الكسر): WR ${hb.wr}% | ${hb.net>=0?"+":""}$${hb.net}\n`;
    m+=`  لو عكسنا (مع الكسر): WR ~${Math.round(revWins/hb.n*100)}% | ~${revNet>=0?"+":""}$${Math.round(revNet)}\n`;
    m+=`  <i>(تقدير: العكس يخصم ~30% ثيتا)</i>\n`;
  } else m+=`  لا صفقات في الفئة بعد\n`;

  m+=`\n<b>حجم مرتفع + اختراق — كل يوم:</b>\n`;
  for(const d of days){
    const g=q.hiBreak.filter(r=>r.day===d);
    m+= g.length? `  ${d.slice(5)}: ${fmtLine(stat(g))}\n` : `  ${d.slice(5)}: —\n`;
  }

  m+=`\n<i>الفئة الحاسمة = 🚀. لو خاسرة الحين ورابحة معكوسة → فكرتك صحيحة</i>`;
  console.log(m.replace(/<[^>]+>/g,""));
  await sendTelegram(m);
})();
