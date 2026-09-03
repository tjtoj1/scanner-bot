# Re-Entry Cooldown Mechanism — Implementation Summary

## Problem
After a losing hard_stop/alpaca_stop/alpaca_stop_est, the bot immediately re-enters the same symbol and direction in the next cycle because:
1. closePosition() deletes state[symbol]
2. scanEntry() in the next cycle sees the symbol free again
3. computeSignal() returns the identical signal from the same unfinished candle
4. Result: 18+ re-entry chain legs in 147 trades, costing -$387 in portfolio bleed

## Solution Implemented
**30-minute cooldown per (symbol × signal direction)** triggered ONLY on losing stops:
- Blocks immediate re-entry of the same (symbol × direction) combo
- Clears naturally after 30 minutes OR when direction actually reverses
- Applies only to hard_stop/alpaca_stop/alpaca_stop_est, NOT ladder_stop/regime_flip/force_exit
- Does not affect position-sizing system, daily-loss cap, or other constraints

## Code Changes

### 1. Constants (scan_lab.js:62-64)
```javascript
const STOP_REASONS       = new Set(["hard_stop", "alpaca_stop", "alpaca_stop_est"]);
const COOLDOWN_DURATION  = 30 * 60 * 1000; // 30 minutes in ms
```

### 2. closePosition() — Set cooldown on losing stops (scan_lab.js:457-462)
```javascript
// Set re-entry cooldown: block this (symbol × signal × direction) for 30 min after losing stops
if (STOP_REASONS.has(reason) && pnlPct < 0) {
  state._cooldowns = state._cooldowns || {};
  state._cooldowns[`${symbol}_${pos.signal}`] = Date.now() + COOLDOWN_DURATION;
  console.log(`⏸️  Re-entry cooldown: ${symbol} ${pos.signal} blocked for 30min (${reason}, ${pnlPct.toFixed(1)}%)`);
}
```

### 3. scanEntry() — Check cooldown before entry (scan_lab.js:640-647)
```javascript
// Check re-entry cooldown: block immediate re-entry of same (symbol × direction) after losing stops
state._cooldowns = state._cooldowns || {};
const cooldownKey = `${symbol}_${sig.signal}`;
if (state._cooldowns[cooldownKey] && state._cooldowns[cooldownKey] > Date.now()) {
  const remainMin = Math.ceil((state._cooldowns[cooldownKey] - Date.now()) / 60000);
  console.log(`⏸️  ${symbol} ${sig.signal}: cooldown active (${remainMin}min remaining) — skipping entry`);
  return;
}
delete state._cooldowns[cooldownKey]; // Clear expired cooldown
```

## Test Results (test_cooldown.js)

Simulated cooldown mechanism against all 147 real trades:

**Chain Detection:**
- Re-entry chain legs detected: 18 (beyond first entry in each chain)
- Legs blocked by cooldown: 12
- Legs still allowed (cooldown expired): 6
- Chains fully prevented: 2

**Portfolio Impact:**
```
Original portfolio (with all chains):  -$144
With cooldown applied:                 +$243
Improvement:                           +$387 ✅
```

**Sample of Blocked Legs:**
- IWM PUT: -$132 (-27.5%) via alpaca_stop
- IWM PUT: +$4 (+0.9%) via alpaca_stop  
- AMZN CALL: +$87 (+19.9%) via alpaca_stop
- TSLA CALL: +$46 (+11.5%) via alpaca_stop
- QQQ PUT: -$95 (-28.0%) via alpaca_stop

## Syntax Verification
✅ `node --check scan_lab.js` passed with no errors

## Design Notes
- **State persistence:** Cooldowns stored in state._cooldowns (saved to state_lab.json)
- **Expiration:** Automatic cleanup on scanEntry() check (deletes expired keys)
- **Reversal handling:** If sig.signal changes (direction reverses), new signal has fresh cooldown key
- **Safety:** Never blocks winning exits or ladder_stop/regime_flip/force_exit
- **Transparency:** Console logs show cooldown activation/skips for debugging

## Files Modified
- scan_lab.js: Added cooldown constants, modified closePosition() and scanEntry()

## Files Created (for testing)
- test_cooldown.js: Simulation tool
- cooldown_test_results.json: Detailed test output
- COOLDOWN_IMPLEMENTATION.md: This document
