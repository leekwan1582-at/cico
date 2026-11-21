/**
 * @file Real Database Integration Tests (MySQL / MariaDB)
 * @description Verifies real schema migrations, atomic seeding, real SQL queries,
 * and multi-condition price alert trigger evaluations directly against a live database instance.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");

test("Real Database Integration Tests - Schema, Seed & Multi-Condition Triggers", async (t) => {
  // Check if a real MariaDB/MySQL instance is running locally
  let connection;
  try {
    connection = await mysql.createConnection({
      user: process.env.USER || "leekwan",
      socketPath: "/tmp/mysqld.sock",
    });
  } catch {
    try {
      connection = await mysql.createConnection({
        host: process.env.TEST_DB_HOST || "127.0.0.1",
        port: parseInt(process.env.TEST_DB_PORT || "3307", 10),
        user: "root",
      });
    } catch (err) {
      console.warn("Notice: Real DB connection skipped (service unavailable in runner):", err.message);
      return;
    }
  }

  t.after(async () => {
    if (connection) {
      await connection.end();
    }
  });

  const testDbName = "crypto_alerts_real_test_db";

  await t.test("Real DB: Setup database and execute baseline schema DDL", async () => {
    await connection.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await connection.query(`CREATE DATABASE ${testDbName}`);
    await connection.query(`USE ${testDbName}`);

    const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
    const rawSql = fs.readFileSync(schemaPath, "utf8");

    // Filter out initial CREATE DATABASE / USE to target testDbName
    const statements = rawSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.toUpperCase().startsWith("CREATE DATABASE") && !s.toUpperCase().startsWith("USE"));

    for (const sql of statements) {
      await connection.query(sql);
    }

    const [tables] = await connection.query("SHOW TABLES");
    const tableNames = tables.map((r) => Object.values(r)[0]);
    assert.ok(tableNames.includes("users"));
    assert.ok(tableNames.includes("exchanges"));
    assert.ok(tableNames.includes("assets"));
    assert.ok(tableNames.includes("price_alerts"));
    assert.ok(tableNames.includes("asset_ohlcv"));
    assert.ok(tableNames.includes("user_watchlist"));
    assert.ok(tableNames.includes("alert_events"));
    assert.ok(tableNames.includes("user_notification_preferences"));
    assert.ok(tableNames.includes("notification_log"));
  });

  await t.test("Real DB: Seed users, assets, and advanced alert conditions", async () => {
    const authService = require("../services/authService");
    const { hash, salt } = await authService.hashPassword("secret123");

    // Insert Users
    await connection.query(
      `INSERT INTO users (id, username, email, password_hash, password_salt, role, must_change_password) VALUES
       (1, 'trader_a', 'a@test.com', ?, ?, 'ADMIN', FALSE),
       (2, 'trader_b', 'b@test.com', ?, ?, 'TRADER', FALSE)`,
      [hash, salt, hash, salt]
    );

    // Insert Exchanges
    await connection.query(
      `INSERT INTO exchanges (id, ccxt_id, display_name, is_active, priority_order) VALUES
       (1, 'okx', 'OKX Singapore', TRUE, 1),
       (2, 'binance', 'Binance Global', TRUE, 2)`
    );

    // Insert Assets
    await connection.query(
      `INSERT INTO assets (id, symbol, name, last_d1_close, prev_d1_close, change_24h_pct) VALUES
       (1, 'BTC/USDT', 'Bitcoin', 90000.0, 85000.0, 5.8824),
       (2, 'ETH/USDT', 'Ethereum', 3000.0, 3200.0, -6.2500)`
    );

    // Insert Watchlists (Trader A has BTC, Trader B has ETH)
    await connection.query(
      `INSERT INTO user_watchlist (user_id, asset_id) VALUES
       (1, 1),
       (2, 2)`
    );

    // Insert Alerts for all condition types
    await connection.query(
      `INSERT INTO price_alerts (id, user_id, asset_id, exchange_id, target_price, peak_price, condition_type, condition_metric, is_triggered) VALUES
       (1, 1, 1, 1, 88000.0, 90000.0, 'ABOVE', 'PRICE', FALSE),
       (2, 1, 1, 1, 5.0, NULL, 'PCT_CHANGE_24H_ABOVE', 'PCT_CHANGE_24H', FALSE),
       (3, 2, 2, 2, 5.0, 3500.0, 'TRAILING_STOP', 'TRAILING_STOP', FALSE)`
    );

    const [alertRows] = await connection.query("SELECT COUNT(*) AS count FROM price_alerts");
    assert.equal(alertRows[0].count, 3);
  });

  await t.test("Real DB: Execute one-way trigger evaluation engine query", async () => {
    // Run the engine's real UPDATE query with exchange OHLCV left join
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

    const [updateResult] = await connection.query(triggerQuery);
    // BTC is 90000 >= 88000 (ABOVE triggers), 24h gain is 5.88% >= 5% (PCT_CHANGE_24H_ABOVE triggers),
    // ETH peak is 3500 dropping to 3000 (14.28% drawdown >= 5% target -> TRAILING_STOP triggers)
    assert.equal(updateResult.affectedRows, 3, "All 3 eligible alerts must trigger");

    const [triggeredRows] = await connection.query("SELECT id, is_triggered, triggered_at FROM price_alerts");
    for (const row of triggeredRows) {
      assert.equal(row.is_triggered, 1);
      assert.ok(row.triggered_at, "triggered_at timestamp must be set");
    }
  });

  await t.test("Real DB: Verify One-Way Transition (prices drop, triggered status preserved)", async () => {
    // Drop BTC price below target
    await connection.query("UPDATE assets SET last_d1_close = 75000.0, change_24h_pct = -10.0 WHERE id = 1");

    // Re-run trigger query - triggered_at and is_triggered must remain untouched!
    const triggerQuery = `
      UPDATE price_alerts pa
      JOIN assets a ON pa.asset_id = a.id
      SET 
        pa.is_triggered = TRUE,
        pa.triggered_at = COALESCE(pa.triggered_at, NOW())
      WHERE pa.is_triggered = FALSE
    `;
    const [result] = await connection.query(triggerQuery);
    assert.equal(result.affectedRows, 0, "No new rows should be updated; triggered alerts must not re-arm or toggle");

    const [stillTriggered] = await connection.query("SELECT is_triggered FROM price_alerts WHERE id = 1");
    assert.equal(stillTriggered[0].is_triggered, 1, "Alert 1 must still be triggered");
  });

  await t.test("Real DB: Strict IDOR isolation on alert deletion and watchlist cascade", async () => {
    // Trader B attempts to delete Trader A's alert (id: 1)
    const [unauthorizedDelete] = await connection.query(
      "DELETE FROM price_alerts WHERE id = ? AND user_id = ?",
      [1, 2] // Attempting to delete alert 1 as user 2
    );
    assert.equal(unauthorizedDelete.affectedRows, 0, "Trader B must NOT be able to delete Trader A's alert");

    // Trader A deletes their own alert (id: 1)
    const [authorizedDelete] = await connection.query(
      "DELETE FROM price_alerts WHERE id = ? AND user_id = ?",
      [1, 1]
    );
    assert.equal(authorizedDelete.affectedRows, 1, "Trader A can delete their own alert");
  });

  await t.test("Real DB: Verify users.role ENUM('ADMIN', 'TRADER') integrity constraint", async () => {
    // 1. Verify schema definition
    const [columns] = await connection.query(`
      SELECT column_type, column_default 
      FROM information_schema.columns 
      WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role'
    `);
    assert.ok(columns[0]);
    assert.equal(columns[0].column_type, "enum('ADMIN','TRADER')");
    assert.ok(columns[0].column_default.includes("TRADER"));

    // 2. Inserting valid roles succeeds
    const authService = require("../services/authService");
    const { hash, salt } = await authService.hashPassword("testpass");
    await connection.query(
      `INSERT INTO users (username, email, password_hash, password_salt, role) VALUES 
       ('admin_user', 'admin@enum.test', ?, ?, 'ADMIN'),
       ('trader_user', 'trader@enum.test', ?, ?, 'TRADER')`,
      [hash, salt, hash, salt]
    );

    // 3. Inserting invalid role fails with constraint error
    await assert.rejects(
      async () => {
        await connection.query(
          "INSERT INTO users (username, email, password_hash, password_salt, role) VALUES ('hacker', 'hacker@enum.test', ?, ?, 'SUPERUSER')",
          [hash, salt]
        );
      },
      /Data truncated for column 'role'|Cannot add or update a child row|check constraint/i,
      "MariaDB must reject invalid ENUM values outside 'ADMIN' and 'TRADER'"
    );
  });

  await t.test("Real DB: alert_events audit trail records CREATED and TRIGGERED events with cascade delete", async () => {
    // Alert 2 still exists in the database (Alert 1 was deleted in previous test)
    await connection.query(
      `INSERT INTO alert_events (alert_id, event_type, price_at_event, metric_value, message) VALUES
       (2, 'CREATED', 90000.0, 88000.0, 'Alert created'),
       (2, 'TRIGGERED', 90500.0, 88000.0, 'Target exceeded'),
       (2, 'NOTIFIED', 90500.0, 88000.0, 'Dispatched to TELEGRAM')`
    );

    const [events] = await connection.query("SELECT * FROM alert_events WHERE alert_id = 2");
    assert.equal(events.length, 3);
    assert.equal(events[0].event_type, "CREATED");
    assert.equal(events[1].event_type, "TRIGGERED");
    assert.equal(events[2].event_type, "NOTIFIED");

    // 2. Cascade check: Deleting alert #2 automatically purges all its audit events!
    await connection.query("DELETE FROM price_alerts WHERE id = 2");
    const [purgedEvents] = await connection.query("SELECT * FROM alert_events WHERE alert_id = 2");
    assert.equal(purgedEvents.length, 0, "FK CASCADE: alert_events must be automatically purged when parent alert is deleted");
  });

  await t.test("Real DB: user_notification_preferences & notification_log persistence and cascade", async () => {
    // 1. Insert preferences for user 1 (trader_a)
    const cryptoService = require("../services/cryptoService");
    const encTg = cryptoService.encrypt("@trader_a_bot");
    await connection.query(
      `INSERT INTO user_notification_preferences (user_id, default_channel, telegram_target, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
       VALUES (1, 'TELEGRAM', ?, TRUE, '22:00:00', '07:00:00')`,
      [encTg]
    );

    const [prefs] = await connection.query("SELECT * FROM user_notification_preferences WHERE user_id = 1");
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0].default_channel, "TELEGRAM");
    assert.equal(cryptoService.decrypt(prefs[0].telegram_target), "@trader_a_bot");

    // 2. Insert notification_log entry
    await connection.query(
      `INSERT INTO notification_log (user_id, channel, recipient_target, status, attempt_count, max_attempts, message_payload)
       VALUES (1, 'TELEGRAM', ?, 'SENT', 1, 3, 'Test payload')`,
      [encTg]
    );

    const [logs] = await connection.query("SELECT * FROM notification_log WHERE user_id = 1");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, "SENT");

    // 3. Cascade check: Deleting user 1 deletes preferences and logs
    await connection.query("DELETE FROM users WHERE id = 1");
    const [emptyPrefs] = await connection.query("SELECT * FROM user_notification_preferences WHERE user_id = 1");
    assert.equal(emptyPrefs.length, 0);
    const [emptyLogs] = await connection.query("SELECT * FROM notification_log WHERE user_id = 1");
    assert.equal(emptyLogs.length, 0);
  });

  await t.test("Real DB: user_watchlist sort_order, is_pinned and portfolio holdings (Phase 8+ 3.4)", async () => {
    // Insert user 99 for clean test
    await connection.query("INSERT INTO users (id, username, email, password_hash, password_salt, role) VALUES (99, 'portfolio_tester', 'port@test.com', 'h', 's', 'TRADER')");
    
    // Add assets to user 99's watchlist with ordering, pinning, and holdings
    await connection.query(`
      INSERT INTO user_watchlist (user_id, asset_id, sort_order, is_pinned, holding_qty, avg_cost) VALUES
      (99, 1, 2, FALSE, 0.50000000, 70000.00000000),
      (99, 2, 1, TRUE, 5.00000000, 2800.00000000)
    `);

    // Verify ordering: Pinned asset (ETH/USDT, sort 1) appears before unpinned BTC
    const [ordered] = await connection.query(`
      SELECT uw.asset_id, uw.sort_order, uw.is_pinned, uw.holding_qty, uw.avg_cost, a.symbol
      FROM user_watchlist uw
      JOIN assets a ON uw.asset_id = a.id
      WHERE uw.user_id = 99
      ORDER BY uw.is_pinned DESC, uw.sort_order ASC
    `);

    assert.equal(ordered.length, 2);
    assert.equal(ordered[0].symbol, "ETH/USDT");
    assert.equal(Boolean(ordered[0].is_pinned), true);
    assert.equal(parseFloat(ordered[0].holding_qty), 5.0);
    assert.equal(parseFloat(ordered[0].avg_cost), 2800.0);

    assert.equal(ordered[1].symbol, "BTC/USDT");
    assert.equal(Boolean(ordered[1].is_pinned), false);
    assert.equal(parseFloat(ordered[1].holding_qty), 0.5);

    // Update holdings
    await connection.query("UPDATE user_watchlist SET holding_qty = 1.25, avg_cost = 72000 WHERE user_id = 99 AND asset_id = 1");
    const [updated] = await connection.query("SELECT holding_qty, avg_cost FROM user_watchlist WHERE user_id = 99 AND asset_id = 1");
    assert.equal(parseFloat(updated[0].holding_qty), 1.25);
    assert.equal(parseFloat(updated[0].avg_cost), 72000.0);
  });
});
