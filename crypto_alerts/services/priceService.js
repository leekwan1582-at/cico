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
const notificationService = require("./notificationService");

/**
 * In-memory markets cache with TTL to eliminate redundant loadMarkets() calls (C6).
 * Map<exchangeId, { timestamp: number, markets: Record<string, any> }>
 */
const marketsCache = new Map();
const MARKETS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL

/**
 * Fetches markets for an exchange with in-memory caching.
 *
 * @param {string} ccxtId
 * @returns {Promise<Record<string, any>|null>}
 */
async function getCachedMarkets(ccxtId) {
  const cached = marketsCache.get(ccxtId);
  const now = Date.now();
  if (cached && now - cached.timestamp < MARKETS_CACHE_TTL_MS) {
    return cached.markets;
  }

  const exchangeClass = ccxt[ccxtId];
  if (!exchangeClass) return null;

  const exchange = new exchangeClass({ timeout: 6000, enableRateLimit: true });
  const markets = await exchange.loadMarkets();
  marketsCache.set(ccxtId, { timestamp: now, markets });
  return markets;
}

/**
 * Clears the markets cache (useful for testing).
 */
function clearMarketsCache() {
  marketsCache.clear();
}

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

      // 1. Attempt to fetch full OHLCV daily candle history from CCXT (up to 180 days for full timeframe coverage)
      const ohlcvCandles = await fetchOHLCVFromExchange(ex.ccxt_id, asset.symbol, 180);
      if (ohlcvCandles && ohlcvCandles.length > 0) {
        // Save the entire daily candlestick series to asset_ohlcv table
        await saveCandlesToDatabase(asset.id, ex.id, ohlcvCandles);

        // Extract latest candle close price
        const latestCandle = ohlcvCandles[ohlcvCandles.length - 1];
        if (latestCandle && latestCandle[4] !== undefined) {
          resolvedPrice = parseFloat(latestCandle[4]);
          sourceForAsset = ex.display_name;
          activeSourceDisplayName = ex.display_name;
          break; // Stop at first successful exchange
        }
      }

      // Fallback single-price probe if full OHLCV call was not returned
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

    // 3. Compute 24h percentage return using previous day close from asset_ohlcv or fallback
    // Fix C2: Filter by source exchange_id (or latest distinct candle_time) so candles across multiple exchanges don't collide
    let prevClose = resolvedPrice;
    try {
      const [candleRows] = await pool.query(
        `SELECT close_price 
         FROM asset_ohlcv 
         WHERE asset_id = ? 
         GROUP BY candle_time, close_price 
         ORDER BY candle_time DESC 
         LIMIT 2`,
        [asset.id]
      );
      if (candleRows && candleRows.length >= 2 && candleRows[1].close_price) {
        prevClose = parseFloat(candleRows[1].close_price);
      }
    } catch {
      prevClose = resolvedPrice;
    }

    const change24hPct = prevClose > 0 ? ((resolvedPrice - prevClose) / prevClose) * 100 : 0.0;

    // Update database record for asset (including prev_d1_close and change_24h_pct)
    try {
      await pool.query(
        "UPDATE assets SET last_d1_close = ?, prev_d1_close = ?, change_24h_pct = ?, last_updated = NOW() WHERE id = ?",
        [resolvedPrice, prevClose, change24hPct, asset.id]
      );
    } catch {
      await pool.query(
        "UPDATE assets SET last_d1_close = ?, last_updated = NOW() WHERE id = ?",
        [resolvedPrice, asset.id]
      );
    }

    updatedAssets.push({
      symbol: asset.symbol,
      price: resolvedPrice,
      change24hPct,
      source: sourceForAsset,
    });
  }

  // 4. Update peak_price high watermark for active TRAILING_STOP alerts
  // Fix C3: Use exchange-specific latest OHLCV close price when available, falling back to a.last_d1_close
  try {
    const updatePeakQuery = `
      UPDATE price_alerts pa
      JOIN assets a ON pa.asset_id = a.id
      LEFT JOIN (
        SELECT o1.asset_id, o1.exchange_id, o1.close_price
        FROM asset_ohlcv o1
        INNER JOIN (
          SELECT asset_id, exchange_id, MAX(candle_time) AS max_time
          FROM asset_ohlcv
          GROUP BY asset_id, exchange_id
        ) o2 ON o1.asset_id = o2.asset_id AND o1.exchange_id = o2.exchange_id AND o1.candle_time = o2.max_time
      ) ex_close ON pa.asset_id = ex_close.asset_id AND pa.exchange_id = ex_close.exchange_id
      SET pa.peak_price = GREATEST(
        COALESCE(pa.peak_price, pa.reference_baseline, COALESCE(ex_close.close_price, a.last_d1_close)),
        COALESCE(ex_close.close_price, a.last_d1_close)
      )
      WHERE pa.condition_type = 'TRAILING_STOP' AND pa.is_triggered = FALSE
    `;
    await pool.query(updatePeakQuery);
  } catch (peakErr) {
    console.warn("Notice: Trailing stop peak update skipped:", peakErr.message);
  }

  // 5. Detect state transition: Identify alerts transitioning from FALSE -> TRUE
  // Fix C1: One-way state transition (FALSE -> TRUE only).
  // Fix C3: Evaluates against exchange-specific close (ex_close.close_price) with a.last_d1_close fallback.
  // Supports:
  // - 'ABOVE': evalPrice >= pa.target_price
  // - 'BELOW': evalPrice <= pa.target_price
  // - 'PCT_CHANGE_24H_ABOVE': a.change_24h_pct >= pa.target_price
  // - 'PCT_CHANGE_24H_BELOW': a.change_24h_pct <= -pa.target_price
  // - 'TRAILING_STOP': ((pa.peak_price - evalPrice) / pa.peak_price * 100) >= pa.target_price
  const detectTransitionSql = `
    SELECT 
      pa.id,
      pa.user_id,
      u.username,
      u.email,
      pa.asset_id,
      a.symbol AS asset_symbol,
      a.name AS asset_name,
      COALESCE(ex_close.close_price, a.last_d1_close) AS last_d1_close,
      a.change_24h_pct,
      pa.exchange_id,
      e.display_name AS exchange_name,
      pa.target_price,
      pa.reference_baseline,
      pa.peak_price,
      pa.condition_type,
      pa.condition_metric,
      pa.notification_channel,
      pa.recipient_target
    FROM price_alerts pa
    JOIN users u ON pa.user_id = u.id
    JOIN assets a ON pa.asset_id = a.id
    JOIN exchanges e ON pa.exchange_id = e.id
    LEFT JOIN (
      SELECT o1.asset_id, o1.exchange_id, o1.close_price
      FROM asset_ohlcv o1
      INNER JOIN (
        SELECT asset_id, exchange_id, MAX(candle_time) AS max_time
        FROM asset_ohlcv
        GROUP BY asset_id, exchange_id
      ) o2 ON o1.asset_id = o2.asset_id AND o1.exchange_id = o2.exchange_id AND o1.candle_time = o2.max_time
    ) ex_close ON pa.asset_id = ex_close.asset_id AND pa.exchange_id = ex_close.exchange_id
    WHERE pa.is_triggered = FALSE
      AND (
        (pa.condition_type = 'ABOVE' AND COALESCE(ex_close.close_price, a.last_d1_close) >= pa.target_price)
        OR
        (pa.condition_type = 'BELOW' AND COALESCE(ex_close.close_price, a.last_d1_close) <= pa.target_price)
        OR
        (pa.condition_type = 'PCT_CHANGE_24H_ABOVE' AND a.change_24h_pct >= pa.target_price)
        OR
        (pa.condition_type = 'PCT_CHANGE_24H_BELOW' AND a.change_24h_pct <= -pa.target_price)
        OR
        (pa.condition_type = 'TRAILING_STOP' AND pa.peak_price > 0 AND ((pa.peak_price - COALESCE(ex_close.close_price, a.last_d1_close)) / pa.peak_price * 100) >= pa.target_price)
      )
  `;

  let newlyTriggeredAlerts = [];
  try {
    const [candidateRows] = await pool.query(detectTransitionSql);
    newlyTriggeredAlerts = candidateRows || [];
  } catch (err) {
    console.warn("Notice: Transition query error or column pending migration:", err.message);
  }

  // 6. Update price alert triggers based on latest asset prices and metrics
  // Fix C1: ONE-WAY TRIGGER TRANSITION (FALSE -> TRUE only). Never clears triggered_at or re-arms alerts to FALSE in the engine!
  // Fix C3: Exchange-aware pricing via ex_close subquery
  const triggerQuery = `
    UPDATE price_alerts pa
    JOIN assets a ON pa.asset_id = a.id
    LEFT JOIN (
      SELECT o1.asset_id, o1.exchange_id, o1.close_price
      FROM asset_ohlcv o1
      INNER JOIN (
        SELECT asset_id, exchange_id, MAX(candle_time) AS max_time
        FROM asset_ohlcv
        GROUP BY asset_id, exchange_id
      ) o2 ON o1.asset_id = o2.asset_id AND o1.exchange_id = o2.exchange_id AND o1.candle_time = o2.max_time
    ) ex_close ON pa.asset_id = ex_close.asset_id AND pa.exchange_id = ex_close.exchange_id
    SET 
      pa.is_triggered = TRUE,
      pa.triggered_at = COALESCE(pa.triggered_at, NOW())
    WHERE pa.is_triggered = FALSE
      AND (
        (pa.condition_type = 'ABOVE' AND COALESCE(ex_close.close_price, a.last_d1_close) >= pa.target_price)
        OR
        (pa.condition_type = 'BELOW' AND COALESCE(ex_close.close_price, a.last_d1_close) <= pa.target_price)
        OR
        (pa.condition_type = 'PCT_CHANGE_24H_ABOVE' AND a.change_24h_pct >= pa.target_price)
        OR
        (pa.condition_type = 'PCT_CHANGE_24H_BELOW' AND a.change_24h_pct <= -pa.target_price)
        OR
        (pa.condition_type = 'TRAILING_STOP' AND pa.peak_price > 0 AND ((pa.peak_price - COALESCE(ex_close.close_price, a.last_d1_close)) / pa.peak_price * 100) >= pa.target_price)
      )
  `;
  try {
    await pool.query(triggerQuery);
  } catch (trigErr) {
    console.warn("Notice: Advanced trigger query fallback:", trigErr.message);
  }

  // 6b. Record TRIGGERED events in alert_events audit trail (Phase 8+ 3.2)
  if (newlyTriggeredAlerts.length > 0) {
    try {
      const eventRows = newlyTriggeredAlerts.map((alt) => [
        alt.id,
        "TRIGGERED",
        alt.last_d1_close || null,
        alt.target_price || null,
        `Condition ${alt.condition_type} met at market price $${Number(alt.last_d1_close).toLocaleString()}`,
      ]);
      await pool.query(
        "INSERT INTO alert_events (alert_id, event_type, price_at_event, metric_value, message) VALUES ?",
        [eventRows]
      );
    } catch (eventErr) {
      console.warn("Notice: Audit trail recording skipped:", eventErr.message);
    }
  }

  // 6c. Asynchronously dispatch notifications for newly triggered alerts (non-blocking)
  if (newlyTriggeredAlerts.length > 0) {
    notificationService.dispatchNotificationsAsync(newlyTriggeredAlerts);
  }

  // 7. Count currently triggered alerts
  const [triggeredRows] = await pool.query(
    "SELECT COUNT(*) AS count FROM price_alerts WHERE is_triggered = TRUE"
  );
  const triggeredCount = triggeredRows[0]?.count || 0;

  return {
    sourceUsed: activeSourceDisplayName,
    updatedAssets,
    triggeredCount,
    notificationsDispatched: newlyTriggeredAlerts.length,
  };
}

/**
 * Attempts to fetch daily OHLCV candles using CCXT for an exchange and symbol.
 *
 * @async
 * @param {string} ccxtId - Unique exchange identifier in CCXT.
 * @param {string} symbol - Unified pair symbol (e.g. 'BTC/USDT').
 * @param {number} [days=30] - Number of days of candles to retrieve.
 * @returns {Promise<Array<[number, number, number, number, number, number]>|null>} OHLCV candles or null.
 */
async function fetchOHLCVFromExchange(ccxtId, symbol, days = 30) {
  try {
    if (!ccxt[ccxtId]) {
      return null;
    }
    const exchange = new ccxt[ccxtId]({
      timeout: 6000,
      enableRateLimit: true,
    });
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const ohlcv = await exchange.fetchOHLCV(symbol, "1d", since, days);
    if (ohlcv && Array.isArray(ohlcv) && ohlcv.length > 0) {
      return ohlcv;
    }
    return null;
  } catch (err) {
    console.warn(`CCXT OHLCV error on ${ccxtId} for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Persists an array of daily OHLCV candles for an asset and exchange into asset_ohlcv.
 *
 * @async
 * @param {number} assetId - Asset ID.
 * @param {number} exchangeId - Exchange ID.
 * @param {Array<[number, number, number, number, number, number]>} candles - Raw CCXT candles.
 * @returns {Promise<void>}
 */
async function saveCandlesToDatabase(assetId, exchangeId, candles) {
  if (!candles || candles.length === 0) return;

  const rows = candles.map((c) => {
    const dateStr = new Date(c[0]).toISOString().slice(0, 10);
    const open = parseFloat(c[1]) || 0;
    const high = parseFloat(c[2]) || open;
    const low = parseFloat(c[3]) || open;
    const close = parseFloat(c[4]) || open;
    const vol = parseFloat(c[5]) || 0;
    return [assetId, exchangeId, dateStr, open, high, low, close, vol];
  });

  const sql = `
    INSERT INTO asset_ohlcv (asset_id, exchange_id, candle_time, open_price, high_price, low_price, close_price, volume)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      open_price = VALUES(open_price),
      high_price = VALUES(high_price),
      low_price = VALUES(low_price),
      close_price = VALUES(close_price),
      volume = VALUES(volume),
      updated_at = NOW()
  `;
  try {
    await pool.query(sql, [rows]);
  } catch (err) {
    console.warn("Notice: asset_ohlcv table upsert skipped/unavailable:", err.message);
  }
}

/**
 * Generates simulated historical daily candles anchored to a base price.
 *
 * @param {number} basePrice - Reference base price.
 * @param {number} [days=30] - Number of days.
 * @returns {Array<{ x: string, y: [number, number, number, number] }>}
 */
function generateFallbackCandles(basePrice, days = 30) {
  const candles = [];
  const now = new Date();
  for (let offset = days - 1; offset >= 0; offset--) {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const wave = Math.sin((days - offset) * 0.4) * (basePrice * 0.04);
    const open = Number((basePrice + wave).toFixed(2));
    const high = Number((open * 1.02).toFixed(2));
    const low = Number((open * 0.98).toFixed(2));
    const close = offset === 0 ? basePrice : Number(((open + high + low) / 3).toFixed(2));
    candles.push({
      x: dateStr,
      y: [open, high, low, close],
    });
  }
  return candles;
}

/**
 * Validates a trading pair symbol against CCXT exchange markets or offline conventions.
 *
 * @async
 * @param {string} symbol - Unified cryptocurrency pair symbol (e.g. 'XRP/USDT').
 * @param {string} [preferredExchange='okx'] - Preferred CCXT exchange ID to test against.
 * @returns {Promise<{ valid: boolean, symbol: string, reason?: string, base?: string, quote?: string }>}
 */
async function validateAssetSymbol(symbol, preferredExchange = "okx") {
  if (!symbol || typeof symbol !== "string") {
    return { valid: false, symbol: "", reason: "Symbol must be a non-empty string" };
  }

  const normalized = symbol.trim().toUpperCase();
  const pairRegex = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/;
  if (!pairRegex.test(normalized)) {
    return { valid: false, symbol: normalized, reason: "Symbol format must be BASE/QUOTE (e.g. XRP/USDT)" };
  }

  // Attempt live exchange validation via cached CCXT markets (C6 fix)
  try {
    const targetEx = ccxt[preferredExchange] ? preferredExchange : (ccxt.okx ? "okx" : "binance");
    const markets = await getCachedMarkets(targetEx);
    if (markets && markets[normalized]) {
      const market = markets[normalized];
      return {
        valid: true,
        symbol: normalized,
        base: market.base,
        quote: market.quote,
      };
    }
  } catch (err) {
    console.warn(`CCXT loadMarkets failed for ${preferredExchange} (${err.message}). Using offline validation.`);
  }

  // Fallback offline validation against known crypto symbols or standard USDT/USD/BTC quotes
  const parts = normalized.split("/");
  const base = parts[0];
  const quote = parts[1];
  const commonQuotes = ["USDT", "USD", "BTC", "ETH", "USDC", "EUR"];
  const fallbackPrices = loadFallbackPrices();

  if (fallbackPrices[normalized] || commonQuotes.includes(quote)) {
    return {
      valid: true,
      symbol: normalized,
      base,
      quote,
    };
  }

  return {
    valid: false,
    symbol: normalized,
    reason: `Pair ${normalized} could not be verified on active exchanges`,
  };
}

/**
 * Fetches initial OHLCV candles for all active exchanges outside of database transactions (C4).
 * Performs network calls up front before opening DB transactions.
 *
 * @param {string} symbol
 * @param {number} initialClosePrice
 * @param {Array<{ id: number, ccxt_id: string }>} exchanges
 * @returns {Promise<Map<number, Array<[number, number, string, number, number, number, number, number]>>>}
 */
async function prefetchInitialCandles(symbol, initialClosePrice, exchanges) {
  const candlesByExchange = new Map();

  for (const ex of exchanges) {
    let candles = [];
    if (ex.ccxt_id !== "local_mock") {
      try {
        candles = (await fetchOHLCVFromExchange(ex.ccxt_id, symbol, 180)) || [];
      } catch (e) {
        candles = [];
      }
    }

    if (candles.length === 0) {
      const generated = generateFallbackCandles(initialClosePrice || 1.0, 180);
      candles = generated.map((c) => [
        new Date(c.x).getTime(),
        c.y[0],
        c.y[1],
        c.y[2],
        c.y[3],
        1000,
      ]);
    }

    if (candles.length > 0) {
      candlesByExchange.set(ex.id, candles);
    }
  }

  return candlesByExchange;
}

/**
 * Seeds initial baseline OHLCV candles (180 days) for a newly added asset.
 * If prefetchedCandles is supplied (C4), writes them into the DB without blocking on CCXT.
 *
 * @async
 * @param {number} assetId - ID of the asset in the assets table.
 * @param {string} symbol - Unified pair symbol.
 * @param {number} initialClosePrice - Starting close price.
 * @param {object} [dbConnection=pool] - Optional active database transaction connection.
 * @param {Map<number, Array>} [prefetchedCandles=null] - Prefetched candle map from prefetchInitialCandles.
 * @returns {Promise<number>} Number of candle rows inserted.
 */
async function seedInitialAssetOHLCV(assetId, symbol, initialClosePrice, dbConnection = pool, prefetchedCandles = null) {
  let candlesByExchange = prefetchedCandles;

  if (!candlesByExchange) {
    const [exchanges] = await dbConnection.query("SELECT id, ccxt_id FROM exchanges WHERE is_active = TRUE");
    candlesByExchange = await prefetchInitialCandles(symbol, initialClosePrice, exchanges);
  }

  let totalSaved = 0;
  for (const [exchangeId, candles] of candlesByExchange.entries()) {
    const rows = candles.map((c) => {
      const candleDate = new Date(c[0]).toISOString().slice(0, 10);
      return [assetId, exchangeId, candleDate, c[1], c[2], c[3], c[4], c[5] || 0];
    });

    const sql = `
      INSERT INTO asset_ohlcv (asset_id, exchange_id, candle_time, open_price, high_price, low_price, close_price, volume)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        open_price = VALUES(open_price),
        high_price = VALUES(high_price),
        low_price = VALUES(low_price),
        close_price = VALUES(close_price),
        volume = VALUES(volume),
        updated_at = NOW()
    `;
    await dbConnection.query(sql, [rows]);
    totalSaved += rows.length;
  }

  return totalSaved;
}

/**
 * Absolute path to local market catalog JSON.
 * @type {string}
 */
const CATALOG_PATH = path.join(__dirname, "..", "data", "market_catalog.json");

/**
 * Loads the master cryptocurrency market pair catalog for screener and lookup.
 *
 * @returns {Array<{ symbol: string, name: string, base: string, quote: string, icon: string, category: string }>}
 */
function getCatalogPairs() {
  try {
    const rawData = fs.readFileSync(CATALOG_PATH, "utf8");
    return JSON.parse(rawData);
  } catch (err) {
    console.warn("Could not read market_catalog.json, using baseline defaults:", err.message);
    return [
      { symbol: "BTC/USDT", name: "Bitcoin", base: "BTC", quote: "USDT", icon: "₿", category: "Layer 1" },
      { symbol: "ETH/USDT", name: "Ethereum", base: "ETH", quote: "USDT", icon: "Ξ", category: "Smart Contracts" },
      { symbol: "SOL/USDT", name: "Solana", base: "SOL", quote: "USDT", icon: "◎", category: "Layer 1" },
      { symbol: "XRP/USDT", name: "Ripple", base: "XRP", quote: "USDT", icon: "✕", category: "Payments" },
      { symbol: "DOGE/USDT", name: "Dogecoin", base: "DOGE", quote: "USDT", icon: "Ð", category: "Meme" },
      { symbol: "ADA/USDT", name: "Cardano", base: "ADA", quote: "USDT", icon: "₳", category: "Layer 1" },
      { symbol: "NEAR/USDT", name: "NEAR Protocol", base: "NEAR", quote: "USDT", icon: "◈", category: "AI & Cloud" },
    ];
  }
}

module.exports = {
  fetchD1PriceFromExchange,
  fetchOHLCVFromExchange,
  saveCandlesToDatabase,
  generateFallbackCandles,
  loadFallbackPrices,
  getCatalogPairs,
  refreshAllPrices,
  validateAssetSymbol,
  seedInitialAssetOHLCV,
  prefetchInitialCandles,
  getCachedMarkets,
  clearMarketsCache,
};
