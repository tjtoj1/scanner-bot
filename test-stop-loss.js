// ============================================================
// Test: Stop Loss Orders for Options in Alpaca Paper
// ============================================================
const ALPACA_KEY = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;

const TRADING_BASE = "https://paper-api.alpaca.markets/v2";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type": "application/json",
};

async function call(url, method = "GET", body = null) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${r.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function getContracts(symbol) {
  const today = new Date().toISOString().split("T")[0];
  const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date=${today}&type=call&status=active&limit=5`;
  const data = await call(url);
  return data.option_contracts || [];
}

async function main() {
  console.log("=== Stop Loss Test for Options ===\n");

  // Step 1: Get account info
  console.log("1. Getting account...");
  const account = await call(`${TRADING_BASE}/account`);
  console.log(`   Cash: $${account.cash}, Buying Power: $${account.buying_power}\n`);

  // Step 2: Get a 0DTE call contract for SPY
  console.log("2. Finding SPY 0DTE call contract...");
  const contracts = await getContracts("SPY");
  if (contracts.length === 0) {
    console.error("   No contracts found! Maybe market is closed.");
    process.exit(1);
  }
  const contract = contracts[0];
  console.log(`   Found: ${contract.symbol} (Strike: $${contract.strike_price})\n`);

  // Step 3: Test BUY with attached STOP LOSS (Order Class: oto)
  console.log("3. Testing BUY + Stop Loss (one-triggers-other)...");
  try {
    const order = await call(`${TRADING_BASE}/orders`, "POST", {
      symbol: contract.symbol,
      qty: "1",
      side: "buy",
      type: "market",
      time_in_force: "day",
      order_class: "oto", // one-triggers-other (buy first, then stop)
      stop_loss: {
        stop_price: "0.10", // Very low test stop
      },
    });
    console.log(`   ✅ Order placed: ${order.id}`);
    console.log(`   Status: ${order.status}`);
    console.log(`   Order class: ${order.order_class}`);
  } catch (e) {
    console.error(`   ❌ Failed: ${e.message}\n`);

    // Try alternative approach: separate Stop Loss order
    console.log("4. Trying alternative: separate Stop Loss order...");
    try {
      // First, place buy order
      const buy = await call(`${TRADING_BASE}/orders`, "POST", {
        symbol: contract.symbol,
        qty: "1",
        side: "buy",
        type: "market",
        time_in_force: "day",
      });
      console.log(`   ✅ Buy placed: ${buy.id}`);

      // Wait for fill
      await new Promise(r => setTimeout(r, 2000));

      // Place stop loss separately
      const stop = await call(`${TRADING_BASE}/orders`, "POST", {
        symbol: contract.symbol,
        qty: "1",
        side: "sell",
        type: "stop",
        stop_price: "0.10",
        time_in_force: "day",
      });
      console.log(`   ✅ Stop Loss placed: ${stop.id}`);
      console.log(`   Status: ${stop.status}`);
    } catch (e2) {
      console.error(`   ❌ Alternative failed: ${e2.message}`);
    }
  }

  console.log("\n=== Test Complete ===");
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
