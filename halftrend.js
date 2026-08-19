// ============================================================
// HalfTrend Engine — translated from BigBeluga Pine Script
// Works on 15-min bars array from Alpaca
// Returns: { trend, buySignal, sellSignal, htLine, atr2,
//            activeSL, activeTP1, activeTP2, activeTP3 }
// ============================================================

function sma(arr, len) {
  if (arr.length < len) return null;
  const slice = arr.slice(-len);
  return slice.reduce((a, b) => a + b, 0) / len;
}

function highest(arr, len) {
  if (arr.length < len) return null;
  return Math.max(...arr.slice(-len));
}

function lowest(arr, len) {
  if (arr.length < len) return null;
  return Math.min(...arr.slice(-len));
}

function atr(bars, len) {
  if (bars.length < len + 1) return null;
  const trs = [];
  for (let i = bars.length - len; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const tr = Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c)
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / len;
}

// Main HalfTrend calculation
// bars: array of {o, h, l, c, v, t} — must be at least amplitude + 100 bars
// amplitude: lookback for swing pivots (default 20)
// channelDeviation: ATR multiplier (default 2.0)
// baseRiskMult: R multiplier for SL/TP (default 3)
function computeHalfTrend(bars, amplitude = 20, channelDeviation = 2.0, baseRiskMult = 3) {
  if (bars.length < amplitude + 100) return null;

  // State variables (simulating Pine Script's var)
  let trend = 0, nextTrend = 0;
  let maxLowPrice = bars[0].l;
  let minHighPrice = bars[0].h;
  let up = 0, down = 0;
  let prevUp = 0, prevDown = 0;
  let prevTrend = 0;

  let activeSL = null, activeTP1 = null, activeTP2 = null, activeTP3 = null;
  let tradeState = 0, entryPx = null;
  let buySignal = false, sellSignal = false;
  let htLine = null;

  // Process each bar
  for (let i = 1; i < bars.length; i++) {
    const slice = bars.slice(0, i + 1);
    const bar = bars[i];
    const prev = bars[i - 1];

    const atr2Val = atr(slice, 100);
    if (!atr2Val) continue;

    const atr2 = atr2Val / 2;
    const dev  = channelDeviation * atr2;

    // Swing high/low over amplitude bars
    const highPrice = highest(slice.map(b => b.h), Math.min(amplitude, slice.length));
    const lowPrice  = lowest(slice.map(b => b.l),  Math.min(amplitude, slice.length));

    const highs = slice.slice(-Math.min(amplitude, slice.length)).map(b => b.h);
    const lows  = slice.slice(-Math.min(amplitude, slice.length)).map(b => b.l);
    const highma = sma(highs, Math.min(amplitude, highs.length));
    const lowma  = sma(lows,  Math.min(amplitude, lows.length));

    prevTrend = trend;
    prevUp    = up;
    prevDown  = down;

    // Trend Logic Matrix
    if (nextTrend === 1) {
      maxLowPrice = Math.max(lowPrice, maxLowPrice);
      if (highma < maxLowPrice && bar.c < (prev.l || bar.l)) {
        trend = 1;
        nextTrend = 0;
        minHighPrice = highPrice;
      }
    } else {
      minHighPrice = Math.min(highPrice, minHighPrice);
      if (lowma > minHighPrice && bar.c > (prev.h || bar.h)) {
        trend = 0;
        nextTrend = 1;
        maxLowPrice = lowPrice;
      }
    }

    // Baseline Paths
    if (trend === 0) {
      if (prevTrend !== 0) {
        up = prevDown || down;
      } else {
        up = Math.max(maxLowPrice, prevUp || maxLowPrice);
      }
    } else {
      if (prevTrend !== 1) {
        down = prevUp || up;
      } else {
        down = Math.min(minHighPrice, prevDown || minHighPrice);
      }
    }

    htLine = trend === 0 ? up : down;

    // Signals (confirmed on bar close)
    buySignal  = trend === 0 && prevTrend === 1;
    sellSignal = trend === 1 && prevTrend === 0;

    // Risk management
    if (buySignal) {
      const dist = atr2 * baseRiskMult;
      activeSL  = bar.c - dist;
      activeTP1 = bar.c + dist;
      activeTP2 = bar.c + dist * 2;
      activeTP3 = bar.c + dist * 3;
      tradeState = 1;
      entryPx = bar.c;
    } else if (sellSignal) {
      const dist = atr2 * baseRiskMult;
      activeSL  = bar.c + dist;
      activeTP1 = bar.c - dist;
      activeTP2 = bar.c - dist * 2;
      activeTP3 = bar.c - dist * 3;
      tradeState = -1;
      entryPx = bar.c;
    }
  }

  const lastBar = bars[bars.length - 1];
  const lastAtr2 = atr(bars, 100) / 2;

  return {
    trend,           // 0 = bullish, 1 = bearish
    buySignal,       // true on this bar close
    sellSignal,
    htLine,
    atr2: lastAtr2,
    activeSL,
    activeTP1,
    activeTP2,
    activeTP3,
    tradeState,
    entryPx,
    // For 0DTE options: use stock price levels as stop/target guide
    // Enter CALL when buySignal, stop when stock < activeSL
    // Enter PUT when sellSignal, stop when stock > activeSL
  };
}

export { computeHalfTrend };
