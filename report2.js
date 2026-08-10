// ============================================================
// DAILY REPORT — BOT #2 (FVG Strategy)
// Runs after market close, sends summary to personal chat
// ============================================================
import fs from "fs";

const ALPACA_KEY    = process.env.ALPACA_KEY_2;
const ALPACA_SECRET = process.env.ALPACA_SECRET_2;
const TG_TOKEN      = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";
const TRADING_BASE  = "https://paper-api.alpaca.markets/v2";

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode: "HTML" })
  });
}

(async () => {
  const today = new Date().toLocaleDateString("en-US", {
    weekday:"short", month:"short", day:"2-digit", year:"numeric", timeZone:"America/Chicago"
  });

  // Get account info
  const acct = await fetch(`${TRADING_BASE}/account`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
  }).then(r=>r.json());

  const portfolio  = parseFloat(acct.portfolio_value);
  const lastEquity = parseFloat(acct.last_equity);
  const dailyPnl   = portfolio - lastEquity;
  const dailyPct   = (dailyPnl / lastEquity * 100).toFixed(2);

  // Get today's closed orders
  const orders = await fetch(`${TRADING_BASE}/orders?status=closed&limit=50&after=${new Date().toISOString().split("T")[0]}T00:00:00Z`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
  }).then(r=>r.json());

  // Get activities for P&L per trade
  const activities = await fetch(`${TRADING_BASE}/account/activities/FILL?date=${new Date().toISOString().split("T")[0]}`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET }
  }).then(r=>r.json());

  // Count buy/sell pairs
  const buys  = Array.isArray(orders) ? orders.filter(o=>o.side==="buy" && o.filled_qty>0).length : 0;
  const sells = Array.isArray(orders) ? orders.filter(o=>o.side==="sell" && o.filled_qty>0).length : 0;
  const trades = Math.min(buys, sells);

  const won  = dailyPnl > 0 ? "✅" : "❌";
  const sign = dailyPnl >= 0 ? "+" : "";

  const msg = `📊 <b>FVG Bot Report - ${today}</b>

💼 صفقات: ~${trades}
💎 الواقع من Alpaca:
${won} ${sign}$${dailyPnl.toFixed(0)} (${sign}${dailyPct}%)

📈 الرصيد: $${portfolio.toFixed(0)}`;

  console.log(msg.replace(/<[^>]+>/g,""));
  await tg(msg);
})();
