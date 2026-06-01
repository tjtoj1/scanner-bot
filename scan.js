🤖 Scanner Bot v9 — GitHub Actions Edition
// يشتغل كل 15 دقيقة، يفحص، يرسل تنبيهات، ثم ينطفئ
// ════════════════════════════════════════════════════════════════

const ALPACA_KEY    = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
const MIN_SCORE     = parseInt(process.env.MIN_SCORE || "70");

if (!ALPACA_KEY || !ALPACA_SECRET || !TG_TOKEN || !TG_CHAT_ID) {
  console.error("❌ متغيرات البيئة ناقصة!");
  process.exit(1);
}

const TICKERS = ["SPY", "QQQ", "NVDA", "TSLA", "META", "AAPL", "MSTR"];

const META = {
  SPY:  { strikeStep: 1,  posSize: "عادي 100%", risk: "عادي" },
  QQQ:  { strikeStep: 1,  posSize: "عادي 100%", risk: "عادي" },
  NVDA: { strikeStep: 1,  posSize: "50% فقط",   risk: "⚠ متوسط" },
  TSLA: { strikeStep: 1,  posSize: "50% فقط",   risk: "⚠ متوسط" },
  META: { strikeStep: 2.5,posSize: "عادي 100%", risk: "عادي" },
  AAPL: { strikeStep: 1,  posSize: "عادي 100%", risk: "عادي" },
  MSTR: { strikeStep: 5,  posSize: "25% فقط",   risk: "🚨 عالي" },
};

const ALPACA_HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
};

// ────────────────────────────────────────────────────────────────
// Alpaca API
// ────────────────────────────────────────────────────────────────
async function getLatestTrade(symbol) {
  const r = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/trades/latest?feed=iex`, { headers: ALPACA_HEADERS });
  if (!r.ok) throw new Error(`Trade ${symbol}: HTTP ${r.status}`);
  return (await r.json()).trade;
}

async function getBars(symbol, timeframe, daysBack) {
  const end = new Date(Date.now() - 60_000).toISOString();
  const start = new Date(Date.now() - daysBack * 86400_000).toISOString();
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&feed=iex&limit=500&adjustment=raw`;
  const r = await fetch(url, { headers: ALPACA_HEADERS });
  if (!r.ok) throw new Error(`Bars ${symbol} ${timeframe}: HTTP ${r.status}`);
  return (await r.json()).bars || [];
}

// ────────────────────────────────────────────────────────────────
// Indicators
// ────────────────────────────────────────────────────────────────

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function macd(closes) {
  if (closes.length < 35) return null;
  const vals = [];
  for (let i = 25; i < closes.length; i++) {
    const e12 = ema(closes.slice(0, i + 1), 12);
    const e26 = ema(closes.slice(0, i + 1), 26);
    if (e12 && e26) vals.push(e12 - e26);
  }
  const line = vals[vals.length - 1];
  const sig = vals.length >= 9 ? ema(vals, 9) : null;
  const hist = sig !== null ? line - sig : null;
  return {
    histogram: hist ? parseFloat(hist.toFixed(4)) : null,
    bias: hist > 0 ? "bullish" : hist < 0 ? "bearish" : "neutral",
  };
}

function bollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return {
    upper: parseFloat((mean + 2 * std).toFixed(2)),
    middle: parseFloat(mean.toFixed(2)),
    lower: parseFloat((mean - 2 * std).toFixed(2)),
  };
}

function vwap(bars) {
  let tv = 0, v = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    tv += tp * b.v;
    v += b.v;
  }
  return v > 0 ? parseFloat((tv / v).toFixed(2)) : null;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  return parseFloat((closes.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(2));
}

// ────────────────────────────────────────────────────────────────
// Setup Detection
// ────────────────────────────────────────────────────────────────

function detectSetup(d) {
  if (d.volRatio > 2 && d.macd5m.bias === "bullish" && d.price > d.vwap) {
    return { name: "Order Flow", icon: "💥", quality: "ممتاز", direction: "CALL" };
  }
  if (d.volRatio > 2 && d.macd5m.bias === "bearish" && d.price < d.vwap) {
    return { name: "Order Flow", icon: "💥", quality: "ممتاز", direction: "PUT" };
  }
  if (d.price > d.bollinger.upper && d.volRatio > 1.3 && d.macd5m.bias === "bullish") {
    return { name: "Breakout", icon: "🚀", quality: "ممتاز", direction: "CALL" };
  }
  if (d.price < d.bollinger.lower && d.volRatio > 1.3 && d.macd5m.bias === "bearish") {
    return { name: "Breakout", icon: "🚀", quality: "ممتاز", direction: "PUT" };
  }
  const vwapDist = Math.abs(d.price - d.vwap) / d.vwap;
  if (vwapDist < 0.002 && d.macd5m.bias === "bullish" && d.rsi5m > 45 && d.rsi5m < 65) {
    return { name: "VWAP Bounce", icon: "🎯", quality: "جيد", direction: "CALL" };
  }
  if (vwapDist < 0.002 && d.macd5m.bias === "bearish" && d.rsi5m < 55 && d.rsi5m > 35) {
    return { name: "VWAP Bounce", icon: "🎯", quality: "جيد", direction: "PUT" };
  }
  if (d.rsi5m < 30 && d.macd5m.histogram > d.macd15m.histogram) {
    return { name: "Oversold Reversal", icon: "↗", quality: "جيد", direction: "CALL" };
  }
  if (d.rsi5m > 70 && d.macd5m.histogram < d.macd15m.histogram) {
    return { name: "Overbought Reversal", icon: "↘", quality: "جيد", direction: "PUT" };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Analysis
// ────────────────────────────────────────────────────────────────

async function analyzeTicker(symbol) {
  const [trade, bars5m, bars15m] = await Promise.all([
    getLatestTrade(symbol),
    getBars(symbol, "5Min", 3),
    getBars(symbol, "15Min", 5),
  ]);

  if (!bars5m.length || !bars15m.length) return { symbol, error: "لا توجد شموع" };

  const price = trade.p;
  const closes5m = bars5m.map(b => b.c);
  const closes15m = bars15m.map(b => b.c);

  const rsi5m = rsi(closes5m);
  const rsi15m = rsi(closes15m);
  const macd5m = macd(closes5m);
  const macd15m = macd(closes15m);
  const boll = bollinger(closes5m);
  const vwap5m = vwap(bars5m.slice(-78));
  const sma20 = sma(closes5m, 20);
  const sma50 = sma(closes5m, 50);

  const lastBar = bars5m[bars5m.length - 1];
  const avgVol = bars5m.slice(-10).reduce((a, b) => a + b.v, 0) / 10;
  const volRatio = parseFloat((lastBar.v / avgVol).toFixed(2));

  const prevClose = bars5m[Math.max(0, bars5m.length - 78)]?.c || price;
  const pct = parseFloat(((price - prevClose) / prevClose * 100).toFixed(2));

  const trend15m = macd15m?.bias === "bullish" && price > sma20 ? "bullish"
                 : macd15m?.bias === "bearish" && price < sma20 ? "bearish"
                 : "neutral";
  const trigger5m = macd5m?.bias === "bullish" && price > vwap5m ? "bullish"
                  : macd5m?.bias === "bearish" && price < vwap5m ? "bearish"
                  : "neutral";
  const mtfAligned = trend15m === trigger5m && trend15m !== "neutral";

  const setup = detectSetup({ price, rsi5m, rsi15m, macd5m, macd15m, vwap: vwap5m, bollinger: boll, volRatio });

  let signal = "NEUTRAL", confirmed = [], score = 0;

  if (mtfAligned && setup && setup.direction === (trend15m === "bullish" ? "CALL" : "PUT")) {
    signal = setup.direction;
    confirmed.push("MTF Aligned ✓", `Setup: ${setup.name}`);
    score = 60;
    if (volRatio > 1.5) { confirmed.push(`Volume ${volRatio}x`); score += 10; }
    if (volRatio > 2.5) score += 5;
    if (signal === "CALL" && rsi5m < 70) { confirmed.push("RSI صحي"); score += 5; }
    if (signal === "PUT" && rsi5m > 30) { confirmed.push("RSI صحي"); score += 5; }
    if (setup.quality === "ممتاز") score += 10;
    if (sma20 && sma50 && signal === "CALL" && sma20 > sma50) { confirmed.push("SMA20>SMA50"); score += 5; }
    if (sma20 && sma50 && signal === "PUT" && sma20 < sma50) { confirmed.push("SMA20<SMA50"); score += 5; }
    score = Math.min(score, 95);
  }

  const strength = score >= 85 ? "قوية جداً" : score >= 70 ? "قوية" : score >= 55 ? "متوسطة" : score > 0 ? "ضعيفة" : "لا فرصة";

  const meta = META[symbol];
  const atmStrike = Math.round(price / meta.strikeStep) * meta.strikeStep;

  return {
    symbol, price: parseFloat(price.toFixed(2)), pct,
    volRatio, rsi5m, rsi15m,
    macd5m: macd5m?.bias, macd15m: macd15m?.bias,
    vwap: vwap5m, vwapBias: price > vwap5m ? "above" : "below",
    trend15m, trigger5m, mtfAligned,
    setup, signal, strength, score, confirmed,
    suggestedStrike: atmStrike,
    riskNote: meta.risk, posSize: meta.posSize,
  };
}

// ────────────────────────────────────────────────────────────────
// Telegram
// ────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) console.error(`Telegram error: ${await r.text()}`);
  return r.ok;
}

function formatAlert(r) {
  const emoji = r.signal === "CALL" ? "📈" : "📉";
  const arrow = r.pct >= 0 ? "▲" : "▼";
  return `🚨 <b>${r.symbol} — ${emoji} ${r.signal} ${r.strength}</b> (${r.score}%)

💵 <b>السعر:</b> $${r.price} ${arrow}${Math.abs(r.pct)}%
📊 <b>المخاطرة:</b> ${r.riskNote} · <b>حجم:</b> ${r.posSize}

${r.setup ? `<b>${r.setup.icon} Setup:</b> ${r.setup.name} (${r.setup.quality})\n` : ""}<b>⏱ MTF:</b> 15m ${r.trend15m === "bullish" ? "▲" : "▼"} · 5m ${r.trigger5m === "bullish" ? "▲" : "▼"} ${r.mtfAligned ? "✓" : "⚠"}

<b>📊 المؤشرات:</b>
• RSI 5m: <code>${r.rsi5m}</code> / 15m: <code>${r.rsi15m}</code>
• MACD: 5m ${r.macd5m === "bullish" ? "🟢" : "🔴"} / 15m ${r.macd15m === "bullish" ? "🟢" : "🔴"}
• VWAP: $${r.vwap} (${r.vwapBias === "above" ? "فوق ✓" : "تحت ✗"})
• Volume: <b>${r.volRatio}x</b> ${r.volRatio > 1.5 ? "🔥" : ""}

━━━━━━━━━━━━━━━━━━━
⭐ <b>اقتراح العقد (0DTE):</b>
${r.signal} <b>$${r.suggestedStrike}</b> — ينتهي اليوم
🎯 هدف: <b>+35%</b> على الـ Premium
🛑 وقف: <b>-30%</b> على الـ Premium
⏱ <b>مدة:</b> 5-30 دقيقة

⚠ افتح Webull للسعر الحقيقي
⚠ اخرج قبل 2 ظهر إجبارياً
⚠ ${r.posSize}`;
}

// ────────────────────────────────────────────────────────────────
// Market Hours Check
// ────────────────────────────────────────────────────────────────

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  // CDT = UTC-5, السوق 9:30-14:00 CDT = 14:30-19:00 UTC
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMin >= 14 * 60 + 30 && utcMin <= 19 * 60;
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n═══ ${new Date().toISOString()} — بدأ الفحص ═══`);

  if (!isMarketOpen()) {
    console.log("⏭ السوق مغلق");
    return;
  }

  const results = [];
  for (const symbol of TICKERS) {
    try {
      const r = await analyzeTicker(symbol);
      results.push(r);
      console.log(`✓ ${symbol}: $${r.price} | ${r.signal} ${r.score}% | ${r.setup?.name || "—"}`);
    } catch (e) {
      console.error(`✗ ${symbol}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // إرسال تنبيهات للفرص القوية
  const alerts = results.filter(r => r.score >= MIN_SCORE);
  console.log(`📊 ${alerts.length} فرصة قوية من ${results.length}`);

  for (const r of alerts) {
    await sendTelegram(formatAlert(r));
    console.log(`📱 ${r.symbol}: تم الإرسال`);
  }

  console.log(`═══ انتهى ═══\n`);
}

main().catch(e => {
  console.error("💥 خطأ فادح:", e);
  sendTelegram(`❌ <b>خطأ في البوت</b>\n${e.message}`).catch(() => {});
  process.exit(1);
});
