import fs from "fs";

const STOP_REASONS = new Set(["hard_stop", "alpaca_stop", "alpaca_stop_est"]);
const COOLDOWN_DURATION = 30 * 60 * 1000;

function loadOutcomes() {
  const lines = fs.readFileSync("outcomes_lab.jsonl", "utf8").trim().split("\n");
  return lines.map(line => JSON.parse(line));
}

// The test_cooldown.js method: looking for CHAINS (consecutive losing stops)
function findChains(trades) {
  const chains = [];
  const visitedIds = new Set();

  trades.forEach((trade, idx) => {
    if (visitedIds.has(trade.tradeId)) return;

    const chain = [trade];
    visitedIds.add(trade.tradeId);

    let current = trade;
    for (let i = idx + 1; i < trades.length; i++) {
      const next = trades[i];
      if (next.symbol === current.symbol && next.signal === current.signal) {
        const currentExit = new Date(current.exitTime).getTime();
        const nextEntry = new Date(next.entryTime).getTime();
        const gap = nextEntry - currentExit;

        // Chain continues ONLY if current trade lost AND it was a stop reason AND gap is short
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

// The gap_analysis method: simple consecutive re-entries
function findSimpleReentries(trades) {
  const reentries = [];
  for (let i = 0; i < trades.length - 1; i++) {
    const curr = trades[i];
    const next = trades[i + 1];
    if (curr.symbol === next.symbol && curr.signal === next.signal && 
        STOP_REASONS.has(curr.reason) && curr.pnlPct < 0) {
      const gap = new Date(next.entryTime).getTime() - new Date(curr.exitTime).getTime();
      reentries.push({ gap, gapMin: Math.round(gap / 60000), pnl: next.pnl, within30: gap < 30 * 60 * 1000 });
    }
  }
  return reentries;
}

console.log("\n🔍 METHODOLOGY RECONCILIATION\n");
console.log("=" .repeat(70));

const trades = loadOutcomes();
const chains = findChains(trades);
const simpleReentries = findSimpleReentries(trades);

console.log("\n1. CHAIN DETECTION (test_cooldown.js method):");
console.log(`   Chains found: ${chains.length}`);
chains.forEach((chain, i) => {
  const chainPnl = chain.reduce((sum, t) => sum + t.pnl, 0);
  console.log(`   Chain ${i+1}: ${chain.length} trades, ${chain[0].symbol} ${chain[0].signal}, PnL: $${chainPnl}`);
});

console.log(`\n2. SIMPLE REENTRIES (gap_analysis method):`);
console.log(`   Total simple reentries: ${simpleReentries.length}`);
console.log(`   Within 30min: ${simpleReentries.filter(r => r.within30).length}, PnL: $${simpleReentries.filter(r => r.within30).reduce((s, r) => s + r.pnl, 0)}`);
console.log(`   After 30min: ${simpleReentries.filter(r => !r.within30).length}, PnL: $${simpleReentries.filter(r => !r.within30).reduce((s, r) => s + r.pnl, 0)}`);

console.log(`\n🤔 WHY DIFFERENT COUNTS?`);
console.log(`   Chain method (${chains.length}): Requires EACH trade to be a losing stop`);
console.log(`   Simple method (${simpleReentries.length}): Counts any consecutive re-entry after a stop`);

console.log(`\n   Chain method excludes:`);
simpleReentries.forEach((r, i) => {
  // Check if this reentry is in any chain
  let inChain = false;
  for (const chain of chains) {
    for (let j = 0; j < chain.length - 1; j++) {
      if (chain[j].tradeId === trades[i].tradeId && chain[j+1].tradeId === trades[i+1].tradeId) {
        inChain = true;
        break;
      }
    }
  }
  if (!inChain && r.pnl > 0) {
    console.log(`   - Gap ${r.gapMin}min: ${r.pnl > 0 ? "+" : ""}$${r.pnl} (profitable, excluded from chains)`);
  }
});

console.log("=" .repeat(70));
