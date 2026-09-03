import fs from "fs";

const STOP_REASONS = new Set(["hard_stop", "alpaca_stop", "alpaca_stop_est"]);
const COOLDOWN_DURATION = 30 * 60 * 1000; // 30 minutes

function loadOutcomes() {
  const lines = fs.readFileSync("outcomes_lab.jsonl", "utf8").trim().split("\n");
  return lines.map(line => JSON.parse(line));
}

// Simulate cooldown mechanism during all trades
function simulateCooldown(trades) {
  const state = { _cooldowns: {} };
  const results = {
    totalTrades: trades.length,
    blockedLegs: [],
    allowedLegs: [],
    chainAnalysis: {},
  };

  // Find all re-entry chains first (to categorize later)
  const reentryChains = findReentryChains(trades);
  const chainTradeIds = new Set();
  reentryChains.forEach(chain => chain.forEach(t => chainTradeIds.add(t.tradeId)));

  trades.forEach((trade, idx) => {
    const cooldownKey = `${trade.symbol}_${trade.signal}`;
    const entryTime = new Date(trade.entryTime).getTime();
    const exitTime = new Date(trade.exitTime).getTime();

    // Check if cooldown is active at entry time
    const cooldownActive = state._cooldowns[cooldownKey] && state._cooldowns[cooldownKey] > entryTime;

    if (cooldownActive && chainTradeIds.has(trade.tradeId)) {
      // This is a re-entry leg that would be blocked
      results.blockedLegs.push({
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        signal: trade.signal,
        pnl: trade.pnl,
        pnlPct: trade.pnlPct,
        reason: trade.reason,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        chainKey: `${trade.symbol}_${trade.signal}_${getChainId(reentryChains, trade.tradeId)}`,
      });
    } else if (chainTradeIds.has(trade.tradeId)) {
      results.allowedLegs.push({
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        signal: trade.signal,
        pnl: trade.pnl,
        pnlPct: trade.pnlPct,
        reason: trade.reason,
        chainKey: `${trade.symbol}_${trade.signal}_${getChainId(reentryChains, trade.tradeId)}`,
      });
    }

    // Update cooldown if this trade had a losing hard_stop/alpaca_stop/alpaca_stop_est
    if (STOP_REASONS.has(trade.reason) && trade.pnlPct < 0) {
      state._cooldowns[cooldownKey] = exitTime + COOLDOWN_DURATION;
    }

    // Cleanup expired cooldowns
    Object.keys(state._cooldowns).forEach(key => {
      if (state._cooldowns[key] <= entryTime) delete state._cooldowns[key];
    });
  });

  return results;
}

function findReentryChains(trades) {
  const chains = [];
  const visitedIds = new Set();

  trades.forEach((trade, idx) => {
    if (visitedIds.has(trade.tradeId)) return;

    const chain = [trade];
    visitedIds.add(trade.tradeId);

    // Look for immediate re-entries: same symbol + signal, within 30 min after losing stop
    let current = trade;
    for (let i = idx + 1; i < trades.length; i++) {
      const next = trades[i];
      if (next.symbol === current.symbol && next.signal === current.signal) {
        const currentExit = new Date(current.exitTime).getTime();
        const nextEntry = new Date(next.entryTime).getTime();
        const gap = nextEntry - currentExit;

        if (STOP_REASONS.has(current.reason) && current.pnlPct < 0 && gap < 30 * 60 * 1000) {
          chain.push(next);
          visitedIds.add(next.tradeId);
          current = next;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (chain.length > 1) {
      chains.push(chain);
    }
  });

  return chains;
}

function getChainId(chains, tradeId) {
  for (let i = 0; i < chains.length; i++) {
    if (chains[i].some(t => t.tradeId === tradeId)) return i;
  }
  return -1;
}

function analyzeResults(results, trades) {
  const blockedPnl = results.blockedLegs.reduce((sum, t) => sum + t.pnl, 0);
  const allowedPnl = results.allowedLegs.reduce((sum, t) => sum + t.pnl, 0);
  const totalChainPnl = blockedPnl + allowedPnl;

  // Count chains that would be fully prevented (all legs blocked)
  const chainsByKey = {};
  results.blockedLegs.forEach(t => {
    if (!chainsByKey[t.chainKey]) chainsByKey[t.chainKey] = { blocked: 0, allowed: 0 };
    chainsByKey[t.chainKey].blocked++;
  });
  results.allowedLegs.forEach(t => {
    if (!chainsByKey[t.chainKey]) chainsByKey[t.chainKey] = { blocked: 0, allowed: 0 };
    chainsByKey[t.chainKey].allowed++;
  });

  const fullyCoveredChains = Object.values(chainsByKey).filter(c => c.allowed === 0).length;

  // Calculate portfolio impact
  const originalPortfolio = trades.reduce((sum, t) => sum + t.pnl, 0);
  const withCooldown = originalPortfolio - blockedPnl;
  const improvement = withCooldown - originalPortfolio;

  console.log("\n📊 COOLDOWN MECHANISM TEST RESULTS\n");
  console.log("=" .repeat(60));
  console.log(`Total trades analyzed: ${results.totalTrades}`);
  console.log(`Re-entry chain legs (original): ${results.blockedLegs.length + results.allowedLegs.length}`);
  console.log(`\n🔒 LEGS BLOCKED BY COOLDOWN: ${results.blockedLegs.length}`);
  console.log(`   PnL prevented: $${blockedPnl}`);
  console.log(`\n✅ LEGS STILL ALLOWED (after first entry in cooldown): ${results.allowedLegs.length}`);
  console.log(`   PnL from allowed: $${allowedPnl}`);

  console.log(`\n📈 PORTFOLIO IMPACT:`);
  console.log(`   Original portfolio (with all chains): $${originalPortfolio}`);
  console.log(`   With cooldown applied: $${withCooldown}`);
  console.log(`   Improvement: $${improvement} ${improvement > 0 ? "✅" : "⚠️"}`);

  console.log(`\n🔗 CHAINS FULLY PREVENTED: ${fullyCoveredChains}`);
  console.log("=" .repeat(60));

  // Show sample of blocked legs
  if (results.blockedLegs.length > 0) {
    console.log("\n📋 SAMPLE OF BLOCKED RE-ENTRY LEGS (first 5):\n");
    results.blockedLegs.slice(0, 5).forEach(t => {
      console.log(`   ${t.symbol} ${t.signal}: ${t.pnl > 0 ? "+" : ""}$${t.pnl} (${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%) via ${t.reason}`);
    });
  }

  return { blockedPnl, allowedPnl, improvement, originalPortfolio, withCooldown, fullyCoveredChains };
}

// Main execution
const trades = loadOutcomes();
console.log(`\n🔄 Simulating cooldown mechanism over ${trades.length} trades...`);
const results = simulateCooldown(trades);
const analysis = analyzeResults(results, trades);

// Save detailed results to file for reference
fs.writeFileSync("cooldown_test_results.json", JSON.stringify({
  timestamp: new Date().toISOString(),
  summary: {
    totalTrades: results.totalTrades,
    blockedLegs: results.blockedLegs.length,
    allowedLegs: results.allowedLegs.length,
    blockedPnl: analysis.blockedPnl,
    allowedPnl: analysis.allowedPnl,
    improvement: analysis.improvement,
    originalPortfolio: analysis.originalPortfolio,
    withCooldown: analysis.withCooldown,
    fullyCoveredChains: analysis.fullyCoveredChains,
  },
  blockedLegs: results.blockedLegs,
}, null, 2));

console.log("\n✅ Full results saved to cooldown_test_results.json");
