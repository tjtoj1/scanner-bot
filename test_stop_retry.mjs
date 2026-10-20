// ============================================================
// ENTRY-STOP WASH-TRADE RETRY — TEST SUITE. No network, no API keys.
//
// postEntryStop, brief, stopOrderIdOrNull and the scanEntry stop block
// are EXTRACTED BY TEXT from the real scan_*.js files and run against a
// stubbed alpaca() and a fake setTimeout that records the requested
// delay and fires at once. If a regex stops matching, the suite throws
// instead of silently testing nothing.
//
// Baseline for regression checks: commit 0482f0ea (the branch point).
//
// Run:  node test_stop_retry.mjs
// ============================================================
import fs from "fs";
import { execFileSync } from "child_process";

const BASE_REF = "0482f0ea";
const FILES = { v21: "scan_v21.js", lab: "scan_lab.js", wvad: "scan_wvad.js" };
const lf = s => s.replace(/\r\n/g, "\n");

const src = {}, base = {};
for (const [bot, file] of Object.entries(FILES)) {
  src[bot]  = lf(fs.readFileSync(file, "utf8"));
  base[bot] = lf(execFileSync("git", ["show", `${BASE_REF}:${file}`], { maxBuffer: 1 << 28 }).toString());
}

const grab = (text, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`extraction failed (${what}) — the source no longer matches this regex`);
  return m[0];
};

let pass = 0, fail = 0;
const check = (name, ok, got, want) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✔" : "✖"} ${name}`);
  if (!ok) {
    console.log(`      got:  ${typeof got === "string" ? got : JSON.stringify(got)}`);
    console.log(`      want: ${typeof want === "string" ? want : JSON.stringify(want)}`);
  }
};

async function captureAsync(fn) {
  const lines = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const sink = (...a) => lines.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.error = sink; console.warn = sink; console.log = sink;
  try { return { out: await fn(), err: null, lines }; }
  catch (e) { return { out: undefined, err: e, lines }; }
  finally { Object.assign(console, orig); }
}

// ════════════════════════════════════════════════════════════
// Extraction
// ════════════════════════════════════════════════════════════
const RE = {
  brief:    /function brief\(x, max = 500\) \{[\s\S]*?\n\}/,
  idOrNull: /function stopOrderIdOrNull\(label, raw\) \{[\s\S]*?\n\}/,
  code:     /const WASH_TRADE_CODE = \d+;/,
  delay:    /const ENTRY_STOP_RETRY_MS = \d+;/,
  retry:    /async function postEntryStop\(body\) \{[\s\S]*?\n\}/,
  // The scanEntry stop block, from the declaration to the end of its catch line.
  block:    /let stopOrderId = null;\n  try \{\n[\s\S]*?\n  \} ?catch ?\(e\) \{[^\n]*\n/,
  // The full inserted helper, comment included — used to rebuild the baseline.
  helper:   /\n\/\/ Entry path only\. Alpaca rejects a sell stop[\s\S]*?\nasync function postEntryStop\(body\) \{[\s\S]*?\n\}\n/,
};

// One "world" per run: a scripted alpaca(), a fake setTimeout, and the real code.
function makeWorld(bot, responses) {
  const posts = [], waits = [];
  const alpaca = async (path, method, body) => {
    posts.push({ path, method, body });
    const r = responses[posts.length - 1];
    if (r === undefined) throw new Error(`unexpected POST #${posts.length}`);
    if (r instanceof Error) throw r;
    return r;
  };
  const fakeSetTimeout = (cb, ms) => { waits.push(ms); cb(); return 0; };
  const code = [
    grab(src[bot], RE.brief, `brief/${bot}`),
    grab(src[bot], RE.idOrNull, `stopOrderIdOrNull/${bot}`),
    grab(src[bot], RE.code, `WASH_TRADE_CODE/${bot}`),
    grab(src[bot], RE.delay, `ENTRY_STOP_RETRY_MS/${bot}`),
    grab(src[bot], RE.retry, `postEntryStop/${bot}`),
  ].join("\n");
  const blockText = grab(src[bot], RE.block, `scanEntry stop block/${bot}`);
  const runBlock = new Function("alpaca", "setTimeout", "symbol", "opt", "qty", "hardStopPrice",
    `${code}\nreturn (async () => {\n${blockText}\nreturn stopOrderId;\n})();`);
  const run = () => runBlock(alpaca, fakeSetTimeout, "QQQ",
    { symbol: "QQQ261014P00730000" }, 3, 1.21);
  return { posts, waits, run };
}

const OK1 = { id: "aaaaaaaa-0000-0000-0000-000000000001", status: "accepted" };
const OK2 = { id: "bbbbbbbb-0000-0000-0000-000000000002", status: "accepted" };
const WASH1 = { code: 40310000, message: "potential wash trade detected. use complex orders",
  reject_reason: "opposite side market/stop order exists", existing_order_id: "buy-1", marker: "FIRST" };
const WASH2 = { ...WASH1, marker: "SECOND" };
const OTHER = { code: 42210000, message: "invalid stop price" };
const EXPECTED_BODY = { symbol: "QQQ261014P00730000", qty: "3", side: "sell", type: "stop",
  time_in_force: "day", stop_price: "1.21" };
const placed = lines => lines.some(l => l.includes("hard stop placed"));
const RETRY_OK = id => `QQQ261014P00730000: entry stop placed on RETRY after wash-trade reject (order ${id})`;
const retryOk = lines => lines.some(l => l.includes("entry stop placed on RETRY"));

for (const bot of ["v21", "lab", "wvad"]) {
  console.log(`\n══════════ ${bot} ══════════`);

  // 1) accepted first time
  {
    const w = makeWorld(bot, [OK1]);
    const r = await captureAsync(w.run);
    console.log("── 1) نجاح من أول مرة");
    check(`${bot}: POST واحد`, w.posts.length === 1, w.posts.length, 1);
    check(`${bot}: بلا انتظار`, w.waits.length === 0, w.waits, []);
    check(`${bot}: stopOrderId = id`, r.out === OK1.id, r.out, OK1.id);
    check(`${bot}: الجسم مطابق (POST /orders، بيع وقف)`,
      w.posts[0].path === "/orders" && w.posts[0].method === "POST" &&
      JSON.stringify(w.posts[0].body) === JSON.stringify(EXPECTED_BODY), w.posts[0], EXPECTED_BODY);
    check(`${bot}: يطبع hard stop placed`, placed(r.lines), r.lines, "hard stop placed …");
    check(`${bot}: لا سطر "placed on RETRY"`, !retryOk(r.lines), r.lines, "absent");
  }

  // 2) wash-trade reject, then accepted
  {
    const w = makeWorld(bot, [WASH1, OK2]);
    const r = await captureAsync(w.run);
    console.log("── 2) رفض 40310000 ثم نجاح");
    check(`${bot}: POST اثنان بالضبط`, w.posts.length === 2, w.posts.length, 2);
    check(`${bot}: انتظار واحد = 2000ms`, w.waits.length === 1 && w.waits[0] === 2000, w.waits, [2000]);
    check(`${bot}: نفس الجسم في المحاولتين (نفس الكائن)`, w.posts[0].body === w.posts[1].body, "different", "same");
    check(`${bot}: stopOrderId = id الإعادة`, r.out === OK2.id, r.out, OK2.id);
    check(`${bot}: يطبع hard stop placed`, placed(r.lines), r.lines, "hard stop placed …");
    check(`${bot}: لا سجل فشل`, !r.lines.some(l => l.includes("retry failed") || l.includes("REJECTED")), r.lines, "none");
    check(`${bot}: سطر "placed on RETRY" موجود حرفياً ومرة واحدة`,
      r.lines.filter(l => l === RETRY_OK(OK2.id)).length === 1, r.lines, RETRY_OK(OK2.id));
  }

  // 3) wash-trade reject twice → no third attempt
  {
    const w = makeWorld(bot, [WASH1, WASH2, OK1]);
    const r = await captureAsync(w.run);
    console.log("── 3) رفض 40310000 مرتين");
    check(`${bot}: POST اثنان فقط (لا ثالث)`, w.posts.length === 2, w.posts.length, 2);
    check(`${bot}: انتظار واحد فقط`, w.waits.length === 1, w.waits, [2000]);
    check(`${bot}: stopOrderId = null`, r.out === null, r.out, null);
    const failLine = r.lines.find(l => l.includes("entry stop retry failed")) || "";
    check(`${bot}: سطر الفشل يحمل الجسمين`, failLine.includes('"marker":"FIRST"') && failLine.includes('"marker":"SECOND"'), failLine, "first=…FIRST… second=…SECOND…");
    check(`${bot}: لا سطر "placed on RETRY"`, !retryOk(r.lines), r.lines, "absent");
    check(`${bot}: لا hard stop placed`, !placed(r.lines), r.lines, "no placed line");
  }

  // 4) other rejection code → no retry
  {
    const w = makeWorld(bot, [OTHER, OK1]);
    const r = await captureAsync(w.run);
    console.log("── 4) رفض بكود آخر 42210000");
    check(`${bot}: POST واحد بلا إعادة`, w.posts.length === 1, w.posts.length, 1);
    check(`${bot}: بلا انتظار`, w.waits.length === 0, w.waits, []);
    check(`${bot}: stopOrderId = null`, r.out === null, r.out, null);
    check(`${bot}: لا hard stop placed`, !placed(r.lines), r.lines, "no placed line");
  }

  // 5) network exception on the first POST → no retry
  {
    const w = makeWorld(bot, [new Error("This operation was aborted"), OK1]);
    const r = await captureAsync(w.run);
    console.log("── 5) استثناء شبكي في الأولى");
    check(`${bot}: POST واحد بلا إعادة`, w.posts.length === 1, w.posts.length, 1);
    check(`${bot}: بلا انتظار`, w.waits.length === 0, w.waits, []);
    check(`${bot}: الاستثناء التقطه catch الموجود`, r.err === null && r.lines.some(l => l.includes("THREW")), r.lines, "…THREW…");
    check(`${bot}: stopOrderId = null`, r.out === null, r.out, null);
    check(`${bot}: لا hard stop placed`, !placed(r.lines), r.lines, "no placed line");
  }

  // 6) extra edges
  {
    console.log("── 6) حواف إضافية");
    let w = makeWorld(bot, [WASH1, new Error("aborted")]);
    let r = await captureAsync(w.run);
    check(`${bot}: 40310000 ثم استثناء → POST اثنان، لا ثالث`, w.posts.length === 2, w.posts.length, 2);
    check(`${bot}: … وجسم الرفض الأول مسجّل`, r.lines.some(l => l.includes('"marker":"FIRST"')), r.lines, "first=…FIRST…");
    check(`${bot}: … وstopOrderId = null`, r.out === null, r.out, null);

    w = makeWorld(bot, [{ ...OK1, code: 40310000 }, OK2]);
    r = await captureAsync(w.run);
    check(`${bot}: رد فيه id (حتى مع code) → لا إعادة`, w.posts.length === 1 && r.out === OK1.id, w.posts.length, 1);

    w = makeWorld(bot, ["<html>502 Bad Gateway</html>", OK1]);
    r = await captureAsync(w.run);
    check(`${bot}: رد نصي غير JSON → لا إعادة`, w.posts.length === 1 && r.out === null, w.posts.length, 1);

    w = makeWorld(bot, [{ ...WASH1, code: "40310000" }, OK1]);
    r = await captureAsync(w.run);
    check(`${bot}: code كنص "40310000" → لا إعادة (مطابقة صارمة)`, w.posts.length === 1, w.posts.length, 1);
  }

  // 7) structural: nothing else changed
  {
    console.log("── 7) لا تغيير خارج نطاق الدخول");
    const helper = grab(src[bot], RE.helper, `helper block/${bot}`);
    const rebuilt = src[bot]
      .replace(helper, "")
      .replace("await postEntryStop({", 'await alpaca("/orders", "POST", {')
      .replace("if (stopOrderId) console.log(`${symbol}: hard stop placed", "console.log(`${symbol}: hard stop placed");
    // Scoped to the entry-stop block, not the whole file. A whole-file
    // equality against a fixed old commit is a tripwire, not a guard: it
    // fails on EVERY later unrelated edit to scan_*.js, and keeping it
    // green would mean adding a new .replace() above for each one — which
    // would also let a real regression hide inside a sloppy reversal.
    // What this test exists to prove is that the retry change stayed
    // inside the entry-stop block, and comparing that block proves it
    // directly. Leakage outside it is covered by the checks below
    // (postEntryStop call count, updateStopOrder, alpaca(), no tg()).
    check(`${bot}: كتلة وقف الدخول = الأساس ${BASE_REF} بعد إزالة التعديل وحده`,
      grab(rebuilt, RE.block, `rebuilt block/${bot}`) === grab(base[bot], RE.block, `base block/${bot}`),
      "differs inside the entry-stop block", "identical");
    check(`${bot}: postEntryStop مستدعاة مرة واحدة فقط (مسار الدخول)`,
      (src[bot].match(/postEntryStop\(/g) || []).length === 2, (src[bot].match(/postEntryStop\(/g) || []).length - 1, 1);
    const upd = /async function updateStopOrder\([\s\S]*?\n\}/;
    check(`${bot}: updateStopOrder لم يتغير`, grab(src[bot], upd, "upd") === grab(base[bot], upd, "upd base"), "changed", "same");
    const alp = /async function alpaca\([\s\S]*?\n\}/;
    check(`${bot}: alpaca() لم تتغير`, grab(src[bot], alp, "alpaca") === grab(base[bot], alp, "alpaca base"), "changed", "same");
    check(`${bot}: لا client_order_id`, !src[bot].includes("client_order_id"), "found", "absent");
    const block = grab(src[bot], RE.block, "block");
    check(`${bot}: لا tg() في كتلة الوقف`, !/\btg\(/.test(block), "tg( found", "absent");
  }

  // 8) logTrade byte-for-byte regression
  {
    console.log("── 8) انحدار logTrade بايت ببايت");
    const re = bot === "v21"
      ? /function logTrade\(pos, symbol, exitPremium, reason, fillSource, exitStockPrice, exitFill = null\) \{[\s\S]*?\n\}/
      : /function logTrade\(pos, symbol, exitPremium, reason, fillSource, exitStockPrice\) \{[\s\S]*?\n\}/;
    const make = text => {
      const written = [];
      const fsStub = { readFileSync: () => "", appendFileSync: (_f, line) => written.push(line) };
      const fn = new Function("fs", "getToday", "OUTCOMES_FILE",
        `${grab(text, re, `logTrade/${bot}`)}\nreturn logTrade;`)(fsStub, () => "2026-10-14", "outcomes_x.jsonl");
      return { fn, written };
    };
    const POS = {
      signal: "PUT", optionSymbol: "QQQ261014P00730000", strike: 730,
      entryPremium: 1.86, qty: 3, entryTime: 1791995440527, level: 731.2,
      ladder1: false, ladder2: false, stopPct: -35, peakPct: 4.2,
      stopOrderId: null, hardStopPrice: 1.21, stopLossPct: -35,
      entryStockPrice: 731.0, vwapAtEntry: 731.4, rsiAtEntry: 44.1, volumeRatio: 1.6,
      signalType: "breakout", entryConditions: { comboKey: "PUT_mid" }, strategyVersion: "v9",
      wvadSumAtEntry: -8.1, signalLineAtEntry: -2.2, atrAtEntry: 0.9, slStock: 732.4, dte: 0,
    };
    const EXIT_FILL = { price: 1.2, confirmed: true, source: "stop_order", filledAt: "2026-10-14T17:02:11.000Z" };
    const cases = bot === "v21"
      ? [[POS, "QQQ", 1.2, "alpaca_stop", "quote_at_detection", 732.0, EXIT_FILL],
         [POS, "QQQ", 2.4, "ladder_stop", "order_fill", 729.0, null]]
      : [[POS, "QQQ", 1.2, "alpaca_stop", "quote_at_detection", 732.0],
         [POS, "QQQ", 2.4, "ladder_stop", "order_fill", 729.0]];
    // Freeze the clock completely (Date.now AND new Date()): logTrade
    // stamps exitTime itself, and two runs can straddle a millisecond.
    const RealDate = globalThis.Date;
    const FROZEN = 1791999000000;
    globalThis.Date = class extends RealDate {
      constructor(...a) { a.length ? super(...a) : super(FROZEN); }
      static now() { return FROZEN; }
    };
    try {
      for (const [i, args] of cases.entries()) {
        const a = make(src[bot]), b = make(base[bot]);
        await captureAsync(async () => a.fn(...args));
        await captureAsync(async () => b.fn(...args));
        check(`${bot}: سجل logTrade #${i + 1} مطابق بايتاً ببايت (${(a.written[0] || "").length} بايت)`,
          a.written.length === 1 && a.written[0] === b.written[0], a.written[0], b.written[0]);
      }
    } finally { globalThis.Date = RealDate; }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
