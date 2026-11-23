/**
 * @file Database Seed Script
 * @description Resets database tables and inserts baseline demo data for users, exchanges,
 * crypto assets, and price alerts within an atomic transaction.
 * @module seed
 */

const mysql = require("mysql2/promise");
require("dotenv").config();

/**
 * Executes full database reset and seeds initial records.
 *
 * @async
 * @returns {Promise<{ success: boolean }>} Resolves with success status.
 * @throws {Error} Throws if database connection or queries fail; rolls back transaction on error.
 */
async function seedDatabase() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "crypto_alerts_db",
  });

  try {
    console.log("Connected to MySQL. Starting database seed...");

    // Clear existing records in reverse dependency order to respect FK constraints
    await connection.query("DELETE FROM notification_log").catch(() => {});
    await connection.query("DELETE FROM user_notification_preferences").catch(() => {});
    await connection.query("DELETE FROM alert_events").catch(() => {});
    await connection.query("DELETE FROM user_watchlist").catch(() => {});
    await connection.query("DELETE FROM asset_ohlcv").catch(() => {});
    await connection.query("DELETE FROM price_alerts");
    await connection.query("DELETE FROM assets");
    await connection.query("DELETE FROM exchanges");
    await connection.query("DELETE FROM users");

    // Reset AUTO_INCREMENT counters for clean IDs (1, 2, 3...)
    await connection.query("ALTER TABLE notification_log AUTO_INCREMENT = 1").catch(() => {});
    await connection.query("ALTER TABLE user_notification_preferences AUTO_INCREMENT = 1").catch(() => {});
    await connection.query("ALTER TABLE alert_events AUTO_INCREMENT = 1").catch(() => {});
    await connection.query("ALTER TABLE user_watchlist AUTO_INCREMENT = 1").catch(() => {});
    await connection.query("ALTER TABLE asset_ohlcv AUTO_INCREMENT = 1").catch(() => {});
    await connection.query("ALTER TABLE price_alerts AUTO_INCREMENT = 1");
    await connection.query("ALTER TABLE assets AUTO_INCREMENT = 1");
    await connection.query("ALTER TABLE exchanges AUTO_INCREMENT = 1");
    await connection.query("ALTER TABLE users AUTO_INCREMENT = 1");

    // Start transaction for clean atomic seed operations
    await connection.beginTransaction();

    // 1. Seed Users with secure password hash ('password123')
    const authService = require("./services/authService");
    const { hash: seedHash, salt: seedSalt } = await authService.hashPassword("password123");

    const usersSql = `
      INSERT INTO users (username, email, password_hash, password_salt, role, must_change_password) VALUES 
      ('leekwan', 'leekwan@example.com', ?, ?, 'ADMIN', TRUE),
      ('trader_sg', 'trader.sg@example.com', ?, ?, 'TRADER', TRUE)
    `;
    await connection.query(usersSql, [seedHash, seedSalt, seedHash, seedSalt]);
    console.log("Seeded users table with authentication credentials.");

    // 2. Seed Exchanges (OKX prioritized for Singapore, Binance as secondary, Local fallback)
    const exchangesSql = `
      INSERT INTO exchanges (ccxt_id, display_name, is_active, priority_order) VALUES 
      ('okx', 'OKX Singapore', TRUE, 1),
      ('binance', 'Binance Global', TRUE, 2),
      ('local_mock', 'Offline D1 Snapshot', TRUE, 3)
    `;
    await connection.query(exchangesSql);
    console.log("Seeded exchanges table.");

    // 3. Seed Crypto Assets with previous close and 24h change
    const assetsSql = `
      INSERT INTO assets (symbol, name, last_d1_close, prev_d1_close, change_24h_pct) VALUES 
      ('BTC/USDT', 'Bitcoin', 88500.00000000, 86000.00000000, 2.9070),
      ('ETH/USDT', 'Ethereum', 3120.50000000, 3200.00000000, -2.4844),
      ('SOL/USDT', 'Solana', 185.25000000, 175.00000000, 5.8571)
    `;
    await connection.query(assetsSql);
    console.log("Seeded assets table.");

    // 3b. Seed User Watchlist relationships with custom ordering, pinning, and portfolio holdings (Phase 8+ 3.4)
    const watchlistSql = `
      INSERT INTO user_watchlist (user_id, asset_id, sort_order, is_pinned, holding_qty, avg_cost) VALUES
      (1, 1, 1, TRUE, 0.45000000, 82000.00000000),   -- leekwan: BTC pinned, holding 0.45 BTC @ $82,000
      (1, 2, 2, FALSE, 4.25000000, 2950.00000000),  -- leekwan: ETH holding 4.25 ETH @ $2,950
      (1, 3, 3, FALSE, NULL, NULL),                 -- leekwan: SOL watchlist only (no holdings)
      (2, 1, 1, FALSE, 0.10000000, 85000.00000000),  -- trader_sg: BTC
      (2, 2, 2, TRUE, NULL, NULL)                   -- trader_sg: ETH pinned
    `;
    await connection.query(watchlistSql).catch((err) => {
      console.warn("Notice: user_watchlist table not present yet or seed skipped:", err.message);
    });
    console.log("Seeded user_watchlist table.");

    // 4. Seed Price Alerts (including advanced condition types: Static, 24h %, Trailing Stop)
    // References: user_id (1=leekwan, 2=trader_sg), asset_id (1=BTC, 2=ETH, 3=SOL), exchange_id (1=OKX, 2=Binance)
    const alertsSql = `
      INSERT INTO price_alerts (user_id, asset_id, exchange_id, target_price, reference_baseline, peak_price, condition_type, condition_metric, is_triggered, notification_channel, recipient_target) VALUES 
      (1, 1, 1, 80000.00000000, 88500.00000000, 88500.00000000, 'ABOVE', 'PRICE', FALSE, 'TELEGRAM', ?),
      (1, 1, 1, 5.00000000, 88500.00000000, NULL, 'PCT_CHANGE_24H_ABOVE', 'PCT_CHANGE_24H', FALSE, 'EMAIL', 'leekwan@example.com'),
      (1, 2, 1, 5.00000000, 3120.50000000, 3250.00000000, 'TRAILING_STOP', 'TRAILING_STOP', FALSE, 'DISCORD', ?),
      (1, 3, 2, 150.00000000, 185.25000000, 185.25000000, 'ABOVE', 'PRICE', TRUE, 'IN_APP', 'Dashboard'),
      (2, 1, 1, 85000.00000000, 88500.00000000, 88500.00000000, 'BELOW', 'PRICE', FALSE, 'EMAIL', 'trader.sg@example.com')
    `;
    const cryptoService = require("./services/cryptoService");
    const encTg = cryptoService.encrypt("@leekwan_tg");
    const encDiscord = cryptoService.encrypt("https://discord.com/api/webhooks/mock/cico");
    await connection.query(alertsSql, [encTg, encDiscord]);
    console.log("Seeded price_alerts table with encrypted targets.");

    // 4b. Seed Initial Audit Trail Events for Alert 1..4 (CREATED, TRIGGERED, NOTIFIED)
    const alertEventsSql = `
      INSERT INTO alert_events (alert_id, event_type, price_at_event, metric_value, message) VALUES
      (1, 'CREATED', 88500.00000000, 80000.00000000, 'Alert initialized above $80,000'),
      (2, 'CREATED', 88500.00000000, 5.00000000, 'Alert initialized 24h gain >= +5%'),
      (3, 'CREATED', 3120.50000000, 5.00000000, 'Trailing stop initialized 5% drop from peak'),
      (4, 'CREATED', 150.00000000, 150.00000000, 'Alert initialized above $150'),
      (4, 'TRIGGERED', 185.25000000, 150.00000000, 'Price crossed above target $150'),
      (4, 'NOTIFIED', 185.25000000, 150.00000000, 'In-App notification delivered to dashboard')
    `;
    await connection.query(alertEventsSql).catch((err) => {
      console.warn("Notice: alert_events seed skipped:", err.message);
    });
    console.log("Seeded alert_events audit trail.");

    // 4c. Seed Initial User Notification Preferences & Sample Delivery Logs
    const notifPrefSql = `
      INSERT INTO user_notification_preferences (user_id, default_channel, telegram_target, discord_target, email_target, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone) VALUES
      (1, 'TELEGRAM', ?, ?, 'leekwan@example.com', FALSE, '22:00:00', '07:00:00', 'Asia/Singapore'),
      (2, 'EMAIL', NULL, NULL, 'trader.sg@example.com', TRUE, '23:00:00', '08:00:00', 'Asia/Singapore')
    `;
    await connection.query(notifPrefSql, [encTg, encDiscord]).catch((err) => {
      console.warn("Notice: user_notification_preferences seed skipped:", err.message);
    });
    console.log("Seeded user_notification_preferences table.");

    const notifLogSql = `
      INSERT INTO notification_log (alert_id, user_id, channel, recipient_target, status, attempt_count, max_attempts, message_payload, sent_at) VALUES
      (4, 1, 'IN_APP', 'Dashboard', 'SENT', 1, 3, 'SOL/USDT Alert #4 crossed $150', NOW())
    `;
    await connection.query(notifLogSql).catch((err) => {
      console.warn("Notice: notification_log seed skipped:", err.message);
    });
    console.log("Seeded notification_log table.");

    // 5. Seed Baseline Historical OHLCV Candles for all timeframes (1d, 4h, 1h, 1w)
    const candleRows = [];
    const basePrices = {
      1: 88500, // BTC/USDT
      2: 3120,  // ETH/USDT
      3: 185,   // SOL/USDT
    };

    const now = new Date();

    // 5a. Seed 250 Daily ('1d') candles (to satisfy 200-Day SMA requirement)
    const totalDaysToSeed = 250;
    for (let dayOffset = totalDaysToSeed - 1; dayOffset >= 0; dayOffset--) {
      const d = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);

      for (const assetId of [1, 2, 3]) {
        const base = basePrices[assetId];
        const wave = Math.sin((totalDaysToSeed - dayOffset) * 0.15) * (base * 0.08);
        const open = base + wave;
        const high = open * 1.025;
        const low = open * 0.978;
        const close = dayOffset === 0 ? base : (open + high + low) / 3;
        const volume = (base * 12.5).toFixed(2);

        const candleDateTime = dateStr + " 00:00:00";
        candleRows.push([assetId, 1, "1d", candleDateTime, open.toFixed(4), high.toFixed(4), low.toFixed(4), close.toFixed(4), volume]);
        candleRows.push([assetId, 2, "1d", candleDateTime, (open * 1.0008).toFixed(4), (high * 1.001).toFixed(4), (low * 0.9995).toFixed(4), (close * 1.0005).toFixed(4), (volume * 1.3).toFixed(2)]);
      }
    }

    // 5b. Seed 4-hour ('4h') candles (last 30 days = 180 bars)
    const total4hBars = 180;
    for (let bar = total4hBars - 1; bar >= 0; bar--) {
      const d = new Date(now.getTime() - bar * 4 * 60 * 60 * 1000);
      const candleDateTime = d.toISOString().slice(0, 19).replace("T", " ");

      for (const assetId of [1, 2, 3]) {
        const base = basePrices[assetId];
        const wave = Math.sin((total4hBars - bar) * 0.1) * (base * 0.04);
        const open = base + wave;
        const high = open * 1.015;
        const low = open * 0.985;
        const close = bar === 0 ? base : (open + high + low) / 3;
        const volume = (base * 2.1).toFixed(2);

        candleRows.push([assetId, 1, "4h", candleDateTime, open.toFixed(4), high.toFixed(4), low.toFixed(4), close.toFixed(4), volume]);
        candleRows.push([assetId, 2, "4h", candleDateTime, (open * 1.0005).toFixed(4), (high * 1.0008).toFixed(4), (low * 0.9992).toFixed(4), (close * 1.0002).toFixed(4), (volume * 1.2).toFixed(2)]);
      }
    }

    // 5c. Seed 1-hour ('1h') candles (last 7 days = 168 bars)
    const total1hBars = 168;
    for (let bar = total1hBars - 1; bar >= 0; bar--) {
      const d = new Date(now.getTime() - bar * 60 * 60 * 1000);
      const candleDateTime = d.toISOString().slice(0, 19).replace("T", " ");

      for (const assetId of [1, 2, 3]) {
        const base = basePrices[assetId];
        const wave = Math.sin((total1hBars - bar) * 0.08) * (base * 0.02);
        const open = base + wave;
        const high = open * 1.008;
        const low = open * 0.992;
        const close = bar === 0 ? base : (open + high + low) / 3;
        const volume = (base * 0.55).toFixed(2);

        candleRows.push([assetId, 1, "1h", candleDateTime, open.toFixed(4), high.toFixed(4), low.toFixed(4), close.toFixed(4), volume]);
        candleRows.push([assetId, 2, "1h", candleDateTime, (open * 1.0002).toFixed(4), (high * 1.0004).toFixed(4), (low * 0.9997).toFixed(4), (close * 1.0001).toFixed(4), (volume * 1.15).toFixed(2)]);
      }
    }

    // 5d. Seed 1-week ('1w') candles (208 weeks = ~4 years for 200W SMA calculation)
    // Standardize to Monday 00:00:00 UTC to align with ISO weeks and exchange standards
    const total1wBars = 208;
    // Find the Monday of current week
    const currentMonday = new Date(now.getTime());
    const dayOfWeek = currentMonday.getUTCDay(); // 0 is Sunday, 1 is Monday...
    const diffToMonday = (dayOfWeek + 6) % 7;
    currentMonday.setUTCDate(currentMonday.getUTCDate() - diffToMonday);
    currentMonday.setUTCHours(0, 0, 0, 0);

    for (let bar = total1wBars - 1; bar >= 0; bar--) {
      const d = new Date(currentMonday.getTime() - bar * 7 * 24 * 60 * 60 * 1000);
      const candleDateTime = d.toISOString().slice(0, 10) + " 00:00:00";

      for (const assetId of [1, 2, 3]) {
        const base = basePrices[assetId];
        // Long-term macro growth curve with market cycle waves
        const macroFactor = 0.45 + (0.55 * (total1wBars - bar) / total1wBars);
        const wave = Math.sin((total1wBars - bar) * 0.12) * (base * 0.15);
        const open = (base * macroFactor) + wave;
        const high = open * 1.05;
        const low = open * 0.95;
        const close = bar === 0 ? base : (open + high + low) / 3;
        const volume = (base * 85.0).toFixed(2);

        candleRows.push([assetId, 1, "1w", candleDateTime, open.toFixed(4), high.toFixed(4), low.toFixed(4), close.toFixed(4), volume]);
        candleRows.push([assetId, 2, "1w", candleDateTime, (open * 1.001).toFixed(4), (high * 1.002).toFixed(4), (low * 0.998).toFixed(4), (close * 1.001).toFixed(4), (volume * 1.25).toFixed(2)]);
      }
    }

    const ohlcvSql = `
      INSERT INTO asset_ohlcv (asset_id, exchange_id, timeframe, candle_time, open_price, high_price, low_price, close_price, volume)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        open_price = VALUES(open_price),
        high_price = VALUES(high_price),
        low_price = VALUES(low_price),
        close_price = VALUES(close_price),
        volume = VALUES(volume),
        updated_at = NOW()
    `;
    await connection.query(ohlcvSql, [candleRows]).catch((err) => {
      console.warn("Notice: asset_ohlcv table not present yet or seed skipped:", err.message);
    });
    console.log("Seeded baseline asset_ohlcv candles.");

    await connection.commit();
    console.log("Database seeding completed successfully.");
    return { success: true };
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error("Error seeding database:", err);
    throw err;
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  seedDatabase().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seedDatabase };

