const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

test("Phase 4 Integration Tests - Express CRUD Routes & Error Guards", async (t) => {
  const pool = require("../config/db");
  const priceService = require("../services/priceService");
  const app = require("../index");

  const originalPoolQuery = pool.query;
  const originalGetConnection = pool.getConnection;
  const originalRefresh = priceService.refreshAllPrices;

  let queryLog = [];
  let server;
  let baseUrl;

  // Mock connection handler for transactions
  const mockConnection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      return mockDatabase.query(sql, params);
    },
  };

  // Mock database handler for all route queries
  const mockDatabase = {
    async getConnection() {
      return mockConnection;
    },
    async query(sql, params) {
      queryLog.push({ sql, params });

      // SELECT users
      if (sql.includes("FROM users")) {
        return [
          [
            { id: 1, username: "leekwan", email: "leekwan@example.com" },
            { id: 2, username: "trader_sg", email: "trader.sg@example.com" },
          ],
        ];
      }

      // SELECT assets
      if (sql.includes("FROM assets ORDER BY id ASC")) {
        return [
          [
            { id: 1, symbol: "BTC/USDT", name: "Bitcoin", last_d1_close: 89000, last_updated: "2026-11-18 12:00:00" },
            { id: 2, symbol: "ETH/USDT", name: "Ethereum", last_d1_close: 3100, last_updated: "2026-11-18 12:00:00" },
          ],
        ];
      }

      // SELECT exchanges
      if (sql.includes("FROM exchanges WHERE is_active = TRUE")) {
        return [
          [
            { id: 1, ccxt_id: "okx", display_name: "OKX Singapore" },
            { id: 2, ccxt_id: "binance", display_name: "Binance Global" },
          ],
        ];
      }

      // SELECT single alert for editing
      if (sql.includes("SELECT * FROM price_alerts WHERE id = ?")) {
        const id = params && params[0];
        if (id == 1) {
          return [
            [
              {
                id: 1,
                user_id: 1,
                asset_id: 1,
                exchange_id: 1,
                target_price: 80000,
                condition_type: "ABOVE",
                is_triggered: 0,
              },
            ],
          ];
        }
        return [[]]; // Record not found
      }

      // SELECT alerts with joins & filters
      if (sql.includes("FROM price_alerts pa") && sql.includes("JOIN users u")) {
        return [
          [
            {
              id: 1,
              user_id: 1,
              username: "leekwan",
              asset_id: 1,
              asset_symbol: "BTC/USDT",
              asset_name: "Bitcoin",
              last_d1_close: 89000,
              exchange_id: 1,
              exchange_name: "OKX Singapore",
              target_price: 80000,
              condition_type: "ABOVE",
              is_triggered: 1,
              created_at: "2026-11-18 10:00:00",
            },
          ],
        ];
      }

      // INSERT alert
      if (sql.includes("INSERT INTO price_alerts")) {
        return [{ insertId: 42 }];
      }

      // UPDATE alert
      if (sql.includes("UPDATE price_alerts")) {
        const id = params && params[params.length - 1];
        if (id == 1) return [{ affectedRows: 1 }];
        return [{ affectedRows: 0 }];
      }

      // DELETE alert
      if (sql.includes("DELETE FROM price_alerts WHERE id = ?")) {
        const id = params && params[0];
        if (id == 1) return [{ affectedRows: 1 }];
        return [{ affectedRows: 0 }];
      }

      return [[]];
    },
  };

  // Start ephemeral server
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.beforeEach(() => {
    queryLog = [];
    pool.query = mockDatabase.query.bind(mockDatabase);
    pool.getConnection = mockDatabase.getConnection.bind(mockDatabase);
  });

  t.after(async () => {
    pool.query = originalPoolQuery;
    pool.getConnection = originalGetConnection;
    priceService.refreshAllPrices = originalRefresh;
    await new Promise((resolve) => server.close(resolve));
  });

  await t.test("GET / loads dashboard and executes multi-table JOIN query", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("Crypto Daily Alerts"));

    const alertQuery = queryLog.find((q) => q.sql.includes("FROM price_alerts pa") && q.sql.includes("JOIN assets a"));
    assert.ok(alertQuery, "Must execute JOIN query across assets, users, and exchanges");
  });

  await t.test("GET /?user_id=1&status=active applies multi-criteria filters correctly", async () => {
    const res = await fetch(`${baseUrl}/?user_id=1&status=active`);
    assert.equal(res.status, 200);

    const alertQuery = queryLog.find((q) => q.sql.includes("pa.user_id = ?") && q.sql.includes("pa.is_triggered = FALSE"));
    assert.ok(alertQuery, "Must filter with user_id and active status");
    assert.equal(alertQuery.params[0], 1);
  });

  await t.test("GET /?edit_id=1 pre-populates edit form", async () => {
    const res = await fetch(`${baseUrl}/?edit_id=1`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("Edit Price Alert") && body.includes("alert #1"));
  });

  await t.test("GET /?edit_id=9999 returns 404 if alert does not exist", async () => {
    const res = await fetch(`${baseUrl}/?edit_id=9999`);
    assert.equal(res.status, 404);
    assert.ok((await res.text()).includes("Alert not found"));
  });

  await t.test("GET /?edit_id=not-a-number returns 400 Bad Request", async () => {
    const res = await fetch(`${baseUrl}/?edit_id=not-a-number`);
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes("Invalid Alert ID"));
  });

  await t.test("POST /alerts validates input and creates new alert record", async () => {
    const formBody = new URLSearchParams({
      user_id: "1",
      asset_id: "2",
      exchange_id: "1",
      target_price: "3500.50",
      condition_type: "above",
    });

    const res = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");

    const insertQuery = queryLog.find((q) => q.sql.includes("INSERT INTO price_alerts"));
    assert.ok(insertQuery);
    assert.deepEqual(insertQuery.params, [1, 2, 1, 3500.5, "ABOVE"]);
  });

  await t.test("POST /alerts returns 400 on invalid target price or condition", async () => {
    const badPrice = new URLSearchParams({
      user_id: "1",
      asset_id: "1",
      exchange_id: "1",
      target_price: "-100",
      condition_type: "ABOVE",
    });
    const res1 = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: badPrice.toString(),
    });
    assert.equal(res1.status, 400);

    const badCondition = new URLSearchParams({
      user_id: "1",
      asset_id: "1",
      exchange_id: "1",
      target_price: "5000",
      condition_type: "INVALID_COND",
    });
    const res2 = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: badCondition.toString(),
    });
    assert.equal(res2.status, 400);
  });

  await t.test("POST /alerts/:id/update updates alert and resets is_triggered to FALSE", async () => {
    const formBody = new URLSearchParams({
      user_id: "1",
      asset_id: "1",
      exchange_id: "1",
      target_price: "92000",
      condition_type: "BELOW",
    });

    const res = await fetch(`${baseUrl}/alerts/1/update`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");

    const updateQuery = queryLog.find((q) => q.sql.includes("UPDATE price_alerts"));
    assert.ok(updateQuery);
    assert.deepEqual(updateQuery.params, [1, 1, 1, 92000, "BELOW", 1]);
  });

  await t.test("POST /alerts/:id/delete deletes alert record", async () => {
    const res = await fetch(`${baseUrl}/alerts/1/delete`, {
      method: "POST",
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");

    const deleteQuery = queryLog.find((q) => q.sql.includes("DELETE FROM price_alerts WHERE id = ?"));
    assert.ok(deleteQuery);
    assert.deepEqual(deleteQuery.params, [1]);
  });

  await t.test("POST /refresh triggers priceService.refreshAllPrices and redirects", async () => {
    let refreshCalled = false;
    priceService.refreshAllPrices = async () => {
      refreshCalled = true;
      return { sourceUsed: "Mock Source", updatedAssets: [], triggeredCount: 0 };
    };

    const res = await fetch(`${baseUrl}/refresh`, {
      method: "POST",
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(refreshCalled, true, "refreshAllPrices() should be invoked");
  });

  await t.test("POST /reset-db triggers seedDatabase() and redirects to /", async () => {
    const seedModule = require("../seed");
    let seedCalled = false;
    const originalSeed = seedModule.seedDatabase;
    seedModule.seedDatabase = async () => {
      seedCalled = true;
      return { success: true };
    };

    const res = await fetch(`${baseUrl}/reset-db`, {
      method: "POST",
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(seedCalled, true, "seedDatabase() should be called");

    // Restore original seed function
    seedModule.seedDatabase = originalSeed;
  });

  await t.test("404 catch-all returns Page Not Found on non-existent endpoints", async () => {
    const res = await fetch(`${baseUrl}/non-existent-endpoint`);
    assert.equal(res.status, 404);
    assert.ok((await res.text()).includes("Page Not Found"));
  });
});
