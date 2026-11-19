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
    await connection.query("DELETE FROM price_alerts");
    await connection.query("DELETE FROM assets");
    await connection.query("DELETE FROM exchanges");
    await connection.query("DELETE FROM users");

    // Reset AUTO_INCREMENT counters for clean IDs (1, 2, 3...)
    await connection.query("ALTER TABLE price_alerts AUTO_INCREMENT = 1");
    await connection.query("ALTER TABLE assets AUTO_INCREMENT = 1");
    await connection.query("ALTER TABLE exchanges AUTO_INCREMENT = 1");
    await connection.query("ALTER TABLE users AUTO_INCREMENT = 1");

    // Start transaction for clean atomic seed operations
    await connection.beginTransaction();

    // 1. Seed Users
    const usersSql = `
      INSERT INTO users (username, email) VALUES 
      ('leekwan', 'leekwan@example.com'),
      ('trader_sg', 'trader.sg@example.com')
    `;
    await connection.query(usersSql);
    console.log("Seeded users table.");

    // 2. Seed Exchanges (OKX prioritized for Singapore, Binance as secondary, Local fallback)
    const exchangesSql = `
      INSERT INTO exchanges (ccxt_id, display_name, is_active, priority_order) VALUES 
      ('okx', 'OKX Singapore', TRUE, 1),
      ('binance', 'Binance Global', TRUE, 2),
      ('local_mock', 'Offline D1 Snapshot', TRUE, 3)
    `;
    await connection.query(exchangesSql);
    console.log("Seeded exchanges table.");

    // 3. Seed Crypto Assets
    const assetsSql = `
      INSERT INTO assets (symbol, name, last_d1_close) VALUES 
      ('BTC/USDT', 'Bitcoin', 88500.00000000),
      ('ETH/USDT', 'Ethereum', 3120.50000000),
      ('SOL/USDT', 'Solana', 185.25000000)
    `;
    await connection.query(assetsSql);
    console.log("Seeded assets table.");

    // 4. Seed Price Alerts
    // References: user_id (1=leekwan, 2=trader_sg), asset_id (1=BTC, 2=ETH, 3=SOL), exchange_id (1=OKX, 2=Binance)
    const alertsSql = `
      INSERT INTO price_alerts (user_id, asset_id, exchange_id, target_price, condition_type, is_triggered) VALUES 
      (1, 1, 1, 80000.00000000, 'ABOVE', FALSE),
      (1, 1, 1, 120000.00000000, 'ABOVE', FALSE),
      (1, 2, 1, 2500.00000000, 'BELOW', FALSE),
      (1, 3, 2, 150.00000000, 'ABOVE', TRUE),
      (2, 1, 1, 85000.00000000, 'BELOW', FALSE)
    `;
    await connection.query(alertsSql);
    console.log("Seeded price_alerts table.");

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

