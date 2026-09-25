import fs from "fs";

const STOP_REASONS = new Set(["hard_stop", "alpaca_stop", "alpaca_stop_est"]);

function loadOutcomes() {
  const lines = fs.readFileSync("outcomes_lab.jsonl", "utf8").trim().split("\n");
  return lines.map(line => JSON.parse(line));
}

// Find all re-entry events (not just immediate chains, but ALL re-entries after stops)
function findAllReentries(trades) {
  const reentries = [];

  for (let i = 0; i < trades.length - 1; i++) {
    const current = trades[i];
    if (STOP_REASONS.has(current.reason) && current.pnlPct < 0) {
      // This is a losing stop. Look for immediate re-entries of same symbol+direction
      for (let j = i + 1; j < trades.length; j++) {
        const next = trades[j];
        if (next.symbol === current.symbol && next.signal === current.signal) {
          const gap = new Date(next.entryTime).getTime() - new Date(current.exitTime).getTime();

          reentries.push({
            chainIndex: i,
            precedingTrade: {
              symbol: current.symbol,
              signal: current.signal,
              pnl: current.pnl,
              pnlPct: current.pnlPct,
              reason: current.reason,
              exitTime: current.exitTime,
            },
            reentryTrade: {
              symbol: next.symbol,
              signal: next.signal,
              pnl: next.pnl,
              pnlPct: next.pnlPct,
              reason: next.reason,
              entryTime: next.entryTime,
            },
            gapMs: gap,
            gapMin: Math.round(gap / 60000),
            blockedBy30minCooldown: gap < 30 * 60 * 1000,
          });

          // Only look at the immediate next re-entry
          break;
        } else if (next.symbol === current.symbol && next.signal === current.signal) {
          // Another symbol/direction, stop looking
          break;
        }
      }
    }
  }

  return reentries;
}

// Analyze why diagnosis expected $3,256 but cooldown only saved $387
function analyzeGap() {
  const trades = loadOutcomes();
  const reentries = findAllReentries(trades);

  // Split by gap duration
  const within30min = reentries.filter(r => r.blockedBy30minCooldown);
  const after30min = reentries.filter(r => !r.blockedBy30minCooldown);

  const within30minPnl = within30min.reduce((sum, r) => sum + r.reentryTrade.pnl, 0);
  const after30minPnl = after30min.reduce((sum, r) => sum + r.reentryTrade.pnl, 0);

  console.log("\n📊 GAP ANALYSIS: Diagnosis ($3,256 expected) vs Cooldown (+$387 actual)\n");
  console.log("=" .repeat(70));

  console.log(`\nTotal re-entry events found: ${reentries.length}`);
  console.log(`  Within 30-minute cooldown:     ${within30min.length} trades, PnL: $${within30minPnl}`);
  console.log(`  After 30-minute cooldown:      ${after30min.length} trades, PnL: $${after30minPnl}`);

  // Gap distribution
  const gapBuckets = {
    "0-5min": reentries.filter(r => r.gapMin <= 5),
    "5-10min": reentries.filter(r => r.gapMin > 5 && r.gapMin <= 10),
    "10-20min": reentries.filter(r => r.gapMin > 10 && r.gapMin <= 20),
    "20-30min": reentries.filter(r => r.gapMin > 20 && r.gapMin <= 30),
    "30-60min": reentries.filter(r => r.gapMin > 30 && r.gapMin <= 60),
    "60+min": reentries.filter(r => r.gapMin > 60),
  };

  console.log(`\n⏱️  TIME GAP DISTRIBUTION (re-entry after losing stop):`);
  Object.entries(gapBuckets).forEach(([bucket, trades]) => {
    const pnl = trades.reduce((sum, r) => sum + r.reentryTrade.pnl, 0);
    if (trades.length > 0) {
      console.log(`   ${bucket.padEnd(12)}: ${String(trades.length).padEnd(3)} trades, $${pnl.toString().padStart(6)} PnL`);
    }
  });

  // Why is the diagnosis expecting much more?
  const allStopsAnalysis = trades.filter(t => STOP_REASONS.has(t.reason) && t.pnlPct < 0);
  const totalLosesFromStops = allStopsAnalysis.reduce((sum, t) => sum + t.pnl, 0);
  const reentryLegsLosses = within30min.reduce((sum, r) => sum + r.reentryTrade.pnl, 0);

  console.log(`\n🔍 DIAGNOSIS vs REALITY:`);
  console.log(`   Total PnL from ALL losing stops: $${totalLosesFromStops}`);
  console.log(`   Losing stops count: ${allStopsAnalysis.length}`);
  console.log(`   Within-cooldown re-entry legs: ${within30min.length}`);
  console.log(`   Their PnL: $${reentryLegsLosses}`);

  console.log(`\n💡 WHY THE GAP?`);
  console.log(`   Diagnosis likely counted: ALL trade pairs with same symbol+direction`);
  console.log(`   Cooldown only prevents: immediate re-entries within 30 min`);

  // Check if diagnosis might have used wider criteria
  console.log(`\n📌 WIDER MATCHING CRITERIA CHECK:`);

  // What if we considered re-entries regardless of time gap?
  const allReentriesAnyGap = trades.filter((t, i) => {
    if (i === 0) return false;
    const prev = trades[i-1];
    return t.symbol === prev.symbol && t.signal === prev.signal &&
           STOP_REASONS.has(prev.reason) && prev.pnlPct < 0;
  });
  const allReentriesPnl = allReentriesAnyGap.reduce((sum, t) => sum + t.pnl, 0);

  console.log(`   If we ignored time gaps (ANY re-entry after stop):`);
  console.log(`   Total re-entries: ${allReentriesAnyGap.length}`);
  console.log(`   Their combined PnL: $${allReentriesPnl}`);

  console.log(`\n✅ RECOMMENDATION:`);
  if (within30min.length < 20 && after30min.length > within30min.length) {
    console.log(`   ⚠️  Most re-entries (${after30min.length}) happen AFTER 30 minutes`);
    console.log(`   → Consider extending cooldown to 60-90 minutes to catch more chains`);
  } else if (within30min.length > 0) {
    console.log(`   ✓ 30-minute cooldown catches ${within30min.length} harmful re-entries`);
    console.log(`   → Current setting is appropriate`);
  }

  console.log("=" .repeat(70));

  return { within30min, after30min, gapBuckets, reentries };
}

const results = analyzeGap();

// Save detailed results
fs.writeFileSync("gap_analysis.json", JSON.stringify({
  timestamp: new Date().toISOString(),
  within30minCount: results.within30min.length,
  after30minCount: results.after30min.length,
  withinCooldownPnL: results.within30min.reduce((sum, r) => sum + r.reentryTrade.pnl, 0),
  afterCooldownPnL: results.after30min.reduce((sum, r) => sum + r.reentryTrade.pnl, 0),
  gapDistribution: Object.fromEntries(
    Object.entries(results.gapBuckets).map(([bucket, trades]) => [
      bucket,
      { count: trades.length, pnl: trades.reduce((sum, r) => sum + r.reentryTrade.pnl, 0) }
    ])
  ),
  reentries: results.reentries,
}, null, 2));

console.log("\n✅ Detailed gap analysis saved to gap_analysis.json");
