// ============================================================
// Alpaca Paper Trading Options - Test Script
// ============================================================
// Purpose: Verify we can read Options data and account info
// NO TRADES will be executed in this test
// ============================================================

const ALPACA_KEY = process.env.ALPACA_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET;

const TRADING_BASE = "https://paper-api.alpaca.markets/v2";
const DATA_BASE = "https://data.alpaca.markets/v2";
const OPTIONS_DATA_BASE = "https://data.alpaca.markets/v1beta1/options";

const HEADERS = {
  "APCA-API-KEY-ID": ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type": "application/json",
};

// ============================================================
// Helper: API Call
// ============================================================
async function call(url, method = "GET", body = null) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return r.json();
}

// ============================================================
// Test 1: Check Account
// ============================================================
async function testAccount() {
  console.log("\n=== TEST 1: Account Info ===");
  try {
    const account = await call(`${TRADING_BASE}/account`);
    console.log(`✅ Account ID: ${account.id}`);
    console.log(`✅ Status: ${account.status}`);
    console.log(`✅ Cash: $${account.cash}`);
    console.log(`✅ Buying Power: $${account.buying_power}`);
    console.log(`✅ Portfolio Value: $${account.portfolio_value}`);
    console.log(`✅ Options Trading Level: ${account.options_trading_level || "N/A"}`);
    console.log(`✅ Options Approved Level: ${account.options_approved_level || "N/A"}`);
    return account;
  } catch (e) {
    console.error(`❌ Account error: ${e.message}`);
    throw e;
  }
}

// ============================================================
// Test 2: Get Options Chain for SPY (0DTE)
// ============================================================
async function testOptionsChain(symbol = "SPY") {
  console.log(`\n=== TEST 2: Options Chain for ${symbol} ===`);

  // Today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split("T")[0];
  console.log(`Looking for 0DTE expiring on: ${today}`);

  try {
    // Get current stock price first
    const quoteUrl = `${DATA_BASE}/stocks/${symbol}/snapshot`;
    const snap = await call(quoteUrl);
    const currentPrice = snap.latestTrade?.p || snap.latestQuote?.ap;
    console.log(`Current ${symbol} price: $${currentPrice}`);

    // Get options chain
    const url = `${OPTIONS_DATA_BASE}/snapshots/${symbol}?expiration_date=${today}&limit=10`;
    const data = await call(url);

    if (!data.snapshots || Object.keys(data.snapshots).length === 0) {
      console.log(`⚠️  No 0DTE options found for ${symbol} on ${today}`);
      console.log(`Try a future expiration date or different symbol`);
      return null;
    }

    const symbols = Object.keys(data.snapshots).slice(0, 5);
    console.log(`Found ${Object.keys(data.snapshots).length} contracts. Showing first 5:`);

    for (const optSym of symbols) {
      const snap = data.snapshots[optSym];
      const bid = snap.latestQuote?.bp || 0;
      const ask = snap.latestQuote?.ap || 0;
      const mid = (bid + ask) / 2;
      console.log(`  ${optSym}: Bid $${bid} | Ask $${ask} | Mid $${mid.toFixed(2)}`);
    }

    return data.snapshots;
  } catch (e) {
    console.error(`❌ Options chain error: ${e.message}`);
    throw e;
  }
}

// ============================================================
// Test 3: Get Options Contracts (Alternative endpoint)
// ============================================================
async function testOptionsContracts(symbol = "SPY") {
  console.log(`\n=== TEST 3: Options Contracts for ${symbol} ===`);

  const today = new Date().toISOString().split("T")[0];

  try {
    const url = `${TRADING_BASE}/options/contracts?underlying_symbols=${symbol}&expiration_date=${today}&limit=10`;
    const data = await call(url);

    if (!data.option_contracts || data.option_contracts.length === 0) {
      console.log(`⚠️  No contracts found via Trading API`);
      return null;
    }

    console.log(`Found ${data.option_contracts.length} contracts. Showing first 5:`);
    for (const c of data.option_contracts.slice(0, 5)) {
      console.log(`  ${c.symbol} | ${c.type} | Strike $${c.strike_price} | Tradable: ${c.tradable}`);
    }

    return data.option_contracts;
  } catch (e) {
    console.error(`❌ Contracts error: ${e.message}`);
    throw e;
  }
}

// ============================================================
// Test 4: Check Existing Positions
// ============================================================
async function testPositions() {
  console.log(`\n=== TEST 4: Current Positions ===`);
  try {
    const positions = await call(`${TRADING_BASE}/positions`);
    if (positions.length === 0) {
      console.log("✅ No open positions");
    } else {
      console.log(`Found ${positions.length} positions:`);
      for (const p of positions) {
        console.log(`  ${p.symbol}: Qty ${p.qty} | Avg $${p.avg_entry_price} | P&L $${p.unrealized_pl}`);
      }
    }
    return positions;
  } catch (e) {
    console.error(`❌ Positions error: ${e.message}`);
    throw e;
  }
}

// ============================================================
// Run All Tests
// ============================================================
async function main() {
  console.log("🧪 Starting Alpaca Paper Trading Test...");
  console.log(`Endpoint: ${TRADING_BASE}`);

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.error("❌ ALPACA_KEY or ALPACA_SECRET not set!");
    process.exit(1);
  }

  console.log(`Key prefix: ${ALPACA_KEY.substring(0, 6)}...`);

  try {
    await testAccount();
    await testPositions();
    await testOptionsChain("SPY");
    await testOptionsContracts("SPY");

    console.log("\n========================================");
    console.log("✅ ALL TESTS PASSED!");
    console.log("========================================");
    console.log("\nNext steps:");
    console.log("1. If you see options data above, Alpaca is ready");
    console.log("2. We can build v15 with confidence");
    console.log("3. If errors, we'll diagnose and adjust");
  } catch (e) {
    console.error("\n========================================");
    console.error("❌ TEST FAILED");
    console.error("========================================");
    console.error(`Error: ${e.message}`);
    console.error("\nPossible reasons:");
    console.error("- Options not enabled");
    console.error("- API keys wrong");
    console.error("- Endpoint changed");
    process.exit(1);
  }
}

main();
