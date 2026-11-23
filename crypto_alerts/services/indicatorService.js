/**
 * @file Technical Indicator Calculation Service
 * @description Provides mathematical calculation routines for technical indicators
 * (RSI_14, SMA_50, SMA_200, SMA Crossovers, 20-day Volume Average and Volume Spikes)
 * derived directly from daily OHLCV candlestick records.
 * @module services/indicatorService
 */

/**
 * Calculates the Relative Strength Index (RSI) using Wilder's smoothed moving average method
 * or standard standard exponential/simple moving average for a specified period (default 14).
 *
 * @param {Array<number>} closePrices - Array of closing prices sorted chronologically (oldest to newest).
 * @param {number} [period=14] - Lookback period.
 * @returns {number|null} Current RSI value (0 to 100), or null if insufficient data.
 */
function calculateRSI(closePrices, period = 14) {
  if (!Array.isArray(closePrices) || closePrices.length < period + 1) {
    return null;
  }

  // Calculate price changes
  const changes = [];
  for (let i = 1; i < closePrices.length; i++) {
    changes.push(closePrices[i] - closePrices[i - 1]);
  }

  // Initial average gain and loss over the first 'period' changes
  let totalGain = 0;
  let totalLoss = 0;

  for (let i = 0; i < period; i++) {
    const diff = changes[i];
    if (diff > 0) {
      totalGain += diff;
    } else {
      totalLoss += Math.abs(diff);
    }
  }

  let avgGain = totalGain / period;
  let avgLoss = totalLoss / period;

  // Wilder's smoothing for subsequent periods
  for (let i = period; i < changes.length; i++) {
    const diff = changes[i];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }
  if (avgGain === 0) {
    return 0;
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return parseFloat(rsi.toFixed(2));
}

/**
 * Calculates Simple Moving Average (SMA) for an array of numbers over a given period.
 *
 * @param {Array<number>} values - Series values in chronological order (oldest to newest).
 * @param {number} period - Number of periods for SMA.
 * @param {number} [offset=0] - Offset from the end (0 = latest, 1 = previous day, etc.).
 * @returns {number|null} Calculated SMA or null if not enough elements.
 */
function calculateSMA(values, period, offset = 0) {
  if (!Array.isArray(values) || values.length < period + offset) {
    return null;
  }
  const endIndex = values.length - offset;
  const startIndex = endIndex - period;
  let sum = 0;
  for (let i = startIndex; i < endIndex; i++) {
    sum += Number(values[i]) || 0;
  }
  return sum / period;
}

/**
 * Evaluates SMA Golden Cross or Death Cross (e.g. 50-day / 200-day SMA).
 * - Golden Cross: Fast SMA crosses ABOVE Slow SMA (current fast >= slow AND prev fast <= slow).
 * - Death Cross: Fast SMA crosses BELOW Slow SMA (current fast <= slow AND prev fast >= slow).
 *
 * @param {Array<number>} closePrices - Chronologically ordered closes (oldest to newest).
 * @param {number} [fastPeriod=50] - Fast SMA period.
 * @param {number} [slowPeriod=200] - Slow SMA period.
 * @returns {{
 *   fastSMA: number|null,
 *   slowSMA: number|null,
 *   prevFastSMA: number|null,
 *   prevSlowSMA: number|null,
 *   isGoldenCross: boolean,
 *   isDeathCross: boolean
 * }}
 */
function evaluateSMACross(closePrices, fastPeriod = 50, slowPeriod = 200) {
  const result = {
    fastSMA: null,
    slowSMA: null,
    prevFastSMA: null,
    prevSlowSMA: null,
    isGoldenCross: false,
    isDeathCross: false,
  };

  if (!Array.isArray(closePrices) || closePrices.length < slowPeriod) {
    return result;
  }

  // Current values
  result.fastSMA = calculateSMA(closePrices, fastPeriod, 0);
  result.slowSMA = calculateSMA(closePrices, slowPeriod, 0);

  // Previous day values if at least slowPeriod + 1 candles exist
  if (closePrices.length >= slowPeriod + 1) {
    result.prevFastSMA = calculateSMA(closePrices, fastPeriod, 1);
    result.prevSlowSMA = calculateSMA(closePrices, slowPeriod, 1);
  } else {
    // If exact boundary, approximate previous using identical or slight prior
    result.prevFastSMA = result.fastSMA;
    result.prevSlowSMA = result.slowSMA;
  }

  if (result.fastSMA !== null && result.slowSMA !== null) {
    // Cross detection
    if (result.prevFastSMA !== null && result.prevSlowSMA !== null) {
      result.isGoldenCross = (result.prevFastSMA <= result.prevSlowSMA) && (result.fastSMA >= result.slowSMA);
      result.isDeathCross = (result.prevFastSMA >= result.prevSlowSMA) && (result.fastSMA <= result.slowSMA);
    } else {
      // Static relation if previous day cannot be computed
      result.isGoldenCross = result.fastSMA >= result.slowSMA;
      result.isDeathCross = result.fastSMA <= result.slowSMA;
    }
  }

  return result;
}

/**
 * Evaluates whether current volume exceeds N times the 20-day historical moving average volume.
 *
 * @param {Array<number>} volumes - Chronological array of volumes (oldest to newest).
 * @param {number} [multiplier=2.0] - Spike threshold factor (e.g. 2.0x, 3.0x).
 * @param {number} [period=20] - Number of baseline historical days (excluding current day).
 * @returns {{
 *   currentVolume: number,
 *   avgVolume20: number|null,
 *   volumeRatio: number|null,
 *   isSpike: boolean
 * }}
 */
function evaluateVolumeSpike(volumes, multiplier = 2.0, period = 20) {
  const result = {
    currentVolume: 0,
    avgVolume20: null,
    volumeRatio: null,
    isSpike: false,
  };

  if (!Array.isArray(volumes) || volumes.length === 0) {
    return result;
  }

  const currentVolume = Number(volumes[volumes.length - 1]) || 0;
  result.currentVolume = currentVolume;

  // We need historical baseline volume. If available, use preceding 'period' days (offset = 1)
  if (volumes.length >= period + 1) {
    result.avgVolume20 = calculateSMA(volumes, period, 1);
  } else if (volumes.length > 1) {
    // If fewer than 20 days, average available historical days
    const availableHist = volumes.slice(0, volumes.length - 1);
    const sum = availableHist.reduce((acc, v) => acc + (Number(v) || 0), 0);
    result.avgVolume20 = sum / availableHist.length;
  } else {
    // Only 1 day
    result.avgVolume20 = currentVolume;
  }

  if (result.avgVolume20 && result.avgVolume20 > 0) {
    result.volumeRatio = parseFloat((currentVolume / result.avgVolume20).toFixed(2));
    result.isSpike = result.volumeRatio >= multiplier;
  } else if (currentVolume > 0 && (!result.avgVolume20 || result.avgVolume20 === 0)) {
    result.volumeRatio = multiplier + 1;
    result.isSpike = true;
  }

  return result;
}

/**
 * Helper to compute technical indicators directly from an array of OHLCV candle records
 * (objects with close_price, volume, or array rows [timestamp, open, high, low, close, volume]).
 *
 * @param {Array<object|Array>} candles - Array of candle objects or CCXT tuples.
 * @returns {{
 *   rsi14: number|null,
 *   sma50: number|null,
 *   sma200: number|null,
 *   smaCross: { isGoldenCross: boolean, isDeathCross: boolean, fastSMA: number|null, slowSMA: number|null },
 *   volumeSpike: { currentVolume: number, avgVolume20: number|null, volumeRatio: number|null, isSpike: boolean }
 * }}
 */
function computeIndicatorsFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      rsi14: null,
      sma50: null,
      sma200: null,
      smaCross: { isGoldenCross: false, isDeathCross: false, fastSMA: null, slowSMA: null },
      volumeSpike: { currentVolume: 0, avgVolume20: null, volumeRatio: null, isSpike: false },
    };
  }

  // Extract close prices and volumes in chronological order
  const closePrices = [];
  const volumes = [];

  for (const c of candles) {
    if (Array.isArray(c)) {
      // CCXT tuple [timestamp, open, high, low, close, volume]
      closePrices.push(parseFloat(c[4]) || 0);
      volumes.push(parseFloat(c[5]) || 0);
    } else if (c && typeof c === "object") {
      // DB row or object { close_price, volume }
      const close = c.close_price !== undefined ? c.close_price : (c.close !== undefined ? c.close : (c.y ? c.y[3] : 0));
      const vol = c.volume !== undefined ? c.volume : (c.v !== undefined ? c.v : 0);
      closePrices.push(parseFloat(close) || 0);
      volumes.push(parseFloat(vol) || 0);
    }
  }

  const rsi14 = calculateRSI(closePrices, 14);
  const smaCross = evaluateSMACross(closePrices, 50, 200);
  const volumeSpike = evaluateVolumeSpike(volumes, 2.0, 20);

  return {
    rsi14,
    sma50: smaCross.fastSMA,
    sma200: smaCross.slowSMA,
    smaCross,
    volumeSpike,
  };
}

/**
 * Calculates Exponential Moving Average (EMA) for an array of numbers over a given period.
 *
 * @param {Array<number>} values - Series values in chronological order (oldest to newest).
 * @param {number} period - Number of periods for EMA.
 * @returns {Array<number>} Array of calculated EMA values corresponding to values index.
 */
function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return [];
  }

  const k = 2 / (period + 1);
  const emaValues = new Array(values.length).fill(null);

  // Initial EMA is simple moving average of first 'period' values
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += Number(values[i]) || 0;
  }
  let prevEma = sum / period;
  emaValues[period - 1] = prevEma;

  for (let i = period; i < values.length; i++) {
    const val = Number(values[i]) || 0;
    const currentEma = val * k + prevEma * (1 - k);
    emaValues[i] = currentEma;
    prevEma = currentEma;
  }

  return emaValues;
}

/**
 * Calculates Moving Average Convergence Divergence (MACD).
 * Standard parameters: fast=12, slow=26, signal=9.
 *
 * @param {Array<number>} closePrices - Chronological close prices.
 * @param {number} [fastPeriod=12]
 * @param {number} [slowPeriod=26]
 * @param {number} [signalPeriod=9]
 * @returns {{
 *   macdLine: number|null,
 *   signalLine: number|null,
 *   histogram: number|null,
 *   isBullishCross: boolean,
 *   isBearishCross: boolean
 * }}
 */
function calculateMACD(closePrices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const result = {
    macdLine: null,
    signalLine: null,
    histogram: null,
    isBullishCross: false,
    isBearishCross: false,
  };

  if (!Array.isArray(closePrices) || closePrices.length < slowPeriod + signalPeriod) {
    return result;
  }

  const fastEma = calculateEMA(closePrices, fastPeriod);
  const slowEma = calculateEMA(closePrices, slowPeriod);

  // Compute MACD Line = fastEma - slowEma
  const macdSeries = [];
  const validMacdIndices = [];

  for (let i = 0; i < closePrices.length; i++) {
    if (fastEma[i] !== null && slowEma[i] !== null) {
      macdSeries.push(fastEma[i] - slowEma[i]);
      validMacdIndices.push(i);
    }
  }

  if (macdSeries.length < signalPeriod) {
    return result;
  }

  // Signal Line is EMA(9) of MACD series
  const signalEma = calculateEMA(macdSeries, signalPeriod);

  const latestIdx = macdSeries.length - 1;
  const prevIdx = latestIdx - 1;

  const currentMacd = macdSeries[latestIdx];
  const currentSignal = signalEma[latestIdx];

  if (currentMacd !== undefined && currentSignal !== null && currentSignal !== undefined) {
    result.macdLine = Number(currentMacd.toFixed(4));
    result.signalLine = Number(currentSignal.toFixed(4));
    result.histogram = Number((currentMacd - currentSignal).toFixed(4));

    if (prevIdx >= 0 && signalEma[prevIdx] !== null) {
      const prevMacd = macdSeries[prevIdx];
      const prevSignal = signalEma[prevIdx];
      result.isBullishCross = prevMacd <= prevSignal && currentMacd > currentSignal;
      result.isBearishCross = prevMacd >= prevSignal && currentMacd < currentSignal;
    }
  }

  return result;
}

/**
 * Calculates Bollinger Bands (BB) for a series of closing prices.
 * Standard parameters: period=20, stdDevMultiplier=2.
 *
 * @param {Array<number>} closePrices - Chronological close prices.
 * @param {number} [period=20]
 * @param {number} [multiplier=2]
 * @returns {{
 *   middleBand: number|null,
 *   upperBand: number|null,
 *   lowerBand: number|null,
 *   bandwidth: number|null,
 *   percentB: number|null,
 *   isSqueeze: boolean
 * }}
 */
function calculateBollingerBands(closePrices, period = 20, multiplier = 2) {
  const result = {
    middleBand: null,
    upperBand: null,
    lowerBand: null,
    bandwidth: null,
    percentB: null,
    isSqueeze: false,
  };

  if (!Array.isArray(closePrices) || closePrices.length < period) {
    return result;
  }

  const window = closePrices.slice(closePrices.length - period);
  const currentPrice = closePrices[closePrices.length - 1];

  // Middle Band is simple moving average
  const sum = window.reduce((acc, v) => acc + (Number(v) || 0), 0);
  const mean = sum / period;

  // Standard deviation
  const variance = window.reduce((acc, v) => acc + Math.pow((Number(v) || 0) - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mean + multiplier * stdDev;
  const lower = mean - multiplier * stdDev;

  result.middleBand = Number(mean.toFixed(2));
  result.upperBand = Number(upper.toFixed(2));
  result.lowerBand = Number(lower.toFixed(2));

  if (mean > 0) {
    result.bandwidth = Number((((upper - lower) / mean) * 100).toFixed(2));
    result.isSqueeze = result.bandwidth < 5.0; // Bandwidth under 5% indicates volatility compression/squeeze
  }

  if (upper !== lower) {
    result.percentB = Number((((currentPrice - lower) / (upper - lower)) * 100).toFixed(2));
  }

  return result;
}

/**
 * Calculates Average True Range (ATR) for volatility and risk stop-loss sizing.
 *
 * @param {Array<{ high: number, low: number, close: number }>} candles - Chronological candles.
 * @param {number} [period=14]
 * @returns {number|null} Current ATR value.
 */
function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) {
    return null;
  }

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high !== undefined ? candles[i].high : (candles[i][2] || 0));
    const low = Number(candles[i].low !== undefined ? candles[i].low : (candles[i][3] || 0));
    const prevClose = Number(candles[i - 1].close !== undefined ? candles[i - 1].close : (candles[i - 1][4] || 0));

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  // Initial ATR is simple average of first 'period' TRs
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Smoothed ATR for subsequent periods
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return Number(atr.toFixed(4));
}

/**
 * Evaluates the 200-Week Simple Moving Average (200W SMA - The Generational Bottom Indicator).
 *
 * @param {Array<number>} weeklyClosePrices - Weekly closing prices in chronological order.
 * @param {number} currentPrice - Current market asset price.
 * @returns {{
 *   sma200w: number|null,
 *   currentPrice: number,
 *   distancePct: number|null,
 *   isAtOrBelow200w: boolean,
 *   isApproaching200w: boolean,
 *   zone: 'GENERATIONAL_VALUE'|'APPROACHING_FLOOR'|'ABOVE_MACRO_AVERAGE'|'INSUFFICIENT_DATA'
 * }}
 */
function evaluate200WSMA(weeklyClosePrices, currentPrice) {
  const result = {
    sma200w: null,
    currentPrice: Number(currentPrice) || 0,
    distancePct: null,
    isAtOrBelow200w: false,
    isApproaching200w: false,
    zone: "INSUFFICIENT_DATA",
    candleCount: Array.isArray(weeklyClosePrices) ? weeklyClosePrices.length : 0,
    requiredCount: 200,
    reason: Array.isArray(weeklyClosePrices) && weeklyClosePrices.length < 200
      ? `Insufficient history: ${weeklyClosePrices.length}/200 weekly candles`
      : null,
  };

  if (!Array.isArray(weeklyClosePrices) || weeklyClosePrices.length < 200) {
    return result;
  }

  const sma = calculateSMA(weeklyClosePrices, 200);
  if (sma === null || isNaN(sma)) {
    return result;
  }

  result.sma200w = Number(sma.toFixed(2));
  const diffPct = ((result.currentPrice - sma) / sma) * 100;
  result.distancePct = Number(diffPct.toFixed(2));

  if (result.currentPrice <= sma) {
    result.isAtOrBelow200w = true;
    result.zone = "GENERATIONAL_VALUE";
  } else if (diffPct <= 7.5) {
    result.isApproaching200w = true;
    result.zone = "APPROACHING_FLOOR";
  } else {
    result.zone = "ABOVE_MACRO_AVERAGE";
  }

  return result;
}

module.exports = {
  calculateRSI,
  calculateSMA,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  evaluate200WSMA,
  evaluateSMACross,
  evaluateVolumeSpike,
  computeIndicatorsFromCandles,
};
