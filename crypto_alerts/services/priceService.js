/**
 * @file Market Price Service
 * @description Handles multi-exchange price fetching (via CCXT), offline fallback snapshots,
 * database updates for asset daily close prices, and automated price alert evaluation.
 * @module services/priceService
 */

const fs = require("fs");
const path = require("path");
const ccxt = require("ccxt");
const pool = require("../config/db");

/**
 * Absolute path to local fallback JSON snapshot for offline resilience.
 * @type {string}
 */
const FALLBACK_PATH = path.join(__dirname, "..", "data", "fallback_d1.json");

/**
 * Loads offline snapshot fallback D1 close prices from disk.
 * If file reading or parsing fails, returns safe hardcoded defaults.
 *
 * @returns {Record<string, number>} Map of crypto symbol to daily close price (e.g., { 'BTC/USDT': 89200.0 })
 */
function loadFallbackPrices() {
  try {
    const rawData = fs.readFileSync(FALLBACK_PATH, "utf8");
    return JSON.parse(rawData);
  } catch (err) {
    console.warn("Could not read fallback_d1.json, using default hardcoded map:", err.message);
    return {
      "BTC/USDT": 89200.0,
      "ETH/USDT": 3180.0,
      "SOL/USDT": 192.5,
    };
  }
}

/**
 * Attempts to fetch the daily (1d) close price using CCXT for a specific exchange and asset symbol.
 *
 * @async
 * @param {string} ccxtId - Unique identifier of the exchange in CCXT (e.g., 'okx', 'binance').
 * @param {string} symbol - Unified cryptocurrency pair symbol (e.g., 'BTC/USDT').
 * @returns {Promise<number|null>} Resolves with the latest daily close price, or null if network fails/geo-blocked.
 */
async function fetchD1PriceFromExchange(ccxtId, symbol) {
  try {
    if (!ccxt[ccxtId]) {
      return null;
    }
    const exchange = new ccxt[ccxtId]({
      timeout: 6000,
      enableRateLimit: true,
    });

    // fetchOHLCV(symbol, timeframe, since, limit)
    const ohlcv = await exchange.fetchOHLCV(symbol, "1d", undefined, 1);
    if (ohlcv && ohlcv.length > 0 && ohlcv[0][4] !== undefined) {
      // ohlcv entry is [timestamp, open, high, low, close, volume]
      return parseFloat(ohlcv[0][4]);
    }
    return null;
  } catch (err) {
    console.warn(`CCXT error on ${ccxtId} for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Refreshes daily close prices for all assets in the database,
 * prioritizing active exchanges (OKX -> Binance), falling back to offline JSON if needed,
 * and re-evaluating price alert triggers based on target conditions.
 *
 * @async
 * @returns {Promise<{
 *   sourceUsed: string,
 *   updatedAssets: Array<{ symbol: string, price: number, source: string }>,
 *   triggeredCount: number
 * }>} Summary object detailing the active data source, updated assets, and count of triggered alerts.
 */
async function refreshAllPrices() {
  const fallbackPrices = loadFallbackPrices();

  // 1. Get active exchanges sorted by priority_order
  const [exchanges] = await pool.query(
    "SELECT id, ccxt_id, display_name FROM exchanges WHERE is_active = TRUE ORDER BY priority_order ASC"
  );

  // 2. Get list of assets to update
  const [assets] = await pool.query("SELECT id, symbol FROM assets");

  let activeSourceDisplayName = "Offline D1 Snapshot";
  const updatedAssets = [];

  for (const asset of assets) {
    let resolvedPrice = null;
    let sourceForAsset = "Offline D1 Snapshot";

    // Attempt live fetch across active exchanges by priority
    for (const ex of exchanges) {
      if (ex.ccxt_id === "local_mock") continue;

      const price = await fetchD1PriceFromExchange(ex.ccxt_id, asset.symbol);
      if (price !== null && !isNaN(price)) {
        resolvedPrice = price;
        sourceForAsset = ex.display_name;
        activeSourceDisplayName = ex.display_name;
        break; // Stop at first successful exchange
      }
    }

    // Fall back to offline snapshot if all live calls failed
    if (resolvedPrice === null) {
      resolvedPrice = fallbackPrices[asset.symbol] ?? 0.0;
    }

    // 3. Update database record for asset
    await pool.query(
      "UPDATE assets SET last_d1_close = ?, last_updated = NOW() WHERE id = ?",
      [resolvedPrice, asset.id]
    );

    updatedAssets.push({
      symbol: asset.symbol,
      price: resolvedPrice,
      source: sourceForAsset,
    });
  }

  // 4. Update price alert triggers based on latest asset prices
  // Trigger condition:
  // - 'ABOVE': asset's last_d1_close >= alert.target_price
  // - 'BELOW': asset's last_d1_close <= alert.target_price
  const triggerQuery = `
    UPDATE price_alerts pa
    JOIN assets a ON pa.asset_id = a.id
    SET pa.is_triggered = CASE
      WHEN pa.condition_type = 'ABOVE' AND a.last_d1_close >= pa.target_price THEN TRUE
      WHEN pa.condition_type = 'BELOW' AND a.last_d1_close <= pa.target_price THEN TRUE
      ELSE FALSE
    END
  `;
  await pool.query(triggerQuery);

  // 5. Count currently triggered alerts
  const [triggeredRows] = await pool.query(
    "SELECT COUNT(*) AS count FROM price_alerts WHERE is_triggered = TRUE"
  );
  const triggeredCount = triggeredRows[0]?.count || 0;

  return {
    sourceUsed: activeSourceDisplayName,
    updatedAssets,
    triggeredCount,
  };
}

module.exports = {
  fetchD1PriceFromExchange,
  loadFallbackPrices,
  refreshAllPrices,
};
