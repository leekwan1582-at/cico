const test = require("node:test");
const assert = require("node:assert/strict");

test("Phase 1-3 Integration Tests - Database Config & Price Service Flow", async (t) => {
  const pool = require("../config/db");
  const priceService = require("../services/priceService");

  // Keep references to real methods
  const originalQuery = pool.query;

  let queryLog = [];

  // Mock pool queries to test service flow deterministically without live DB server requirement
  const mockDatabase = {
    async query(sql, params) {
      queryLog.push({ sql, params });

      // 1. SELECT exchanges
      if (sql.includes("FROM exchanges WHERE is_active = TRUE")) {
        return [
          [
            { id: 1, ccxt_id: "okx", display_name: "OKX Singapore" },
            { id: 2, ccxt_id: "binance", display_name: "Binance Global" },
            { id: 3, ccxt_id: "local_mock", display_name: "Offline D1 Snapshot" },
          ],
        ];
      }

      // 2. SELECT assets
      if (sql.includes("SELECT id, symbol FROM assets")) {
        return [
          [
            { id: 1, symbol: "BTC/USDT" },
            { id: 2, symbol: "ETH/USDT" },
            { id: 3, symbol: "SOL/USDT" },
          ],
        ];
      }

      // 3. UPDATE assets
      if (sql.includes("UPDATE assets SET last_d1_close")) {
        return [{ affectedRows: 1 }];
      }

      // 4. UPDATE price_alerts
      if (sql.includes("UPDATE price_alerts pa")) {
        return [{ affectedRows: 2 }];
      }

      // 5. COUNT triggered
      if (sql.includes("COUNT(*) AS count FROM price_alerts")) {
        return [[{ count: 3 }]];
      }

      return [[]];
    },
  };

  t.beforeEach(() => {
    queryLog = [];
    pool.query = mockDatabase.query.bind(mockDatabase);
  });

  t.after(() => {
    pool.query = originalQuery;
  });

  await t.test("config/db exports a valid pool object with query and execute methods", () => {
    assert.ok(pool, "Pool should exist");
    assert.equal(typeof pool.query, "function");
    assert.equal(typeof pool.execute, "function");
    assert.equal(typeof pool.getConnection, "function");
  });

  await t.test("priceService.refreshAllPrices() executes full workflow and updates assets & alerts", async () => {
    // When CCXT live calls fail or are mocked, it should fall back to snapshot
    const result = await priceService.refreshAllPrices();

    assert.ok(result, "Result payload should be returned");
    assert.ok(result.sourceUsed, "Source used should be identified");
    assert.equal(Array.isArray(result.updatedAssets), true);
    assert.equal(result.updatedAssets.length, 3);
    assert.equal(result.triggeredCount, 3);

    // Verify SQL operations were executed in the expected order
    const selectExchanges = queryLog.find((q) => q.sql.includes("FROM exchanges"));
    assert.ok(selectExchanges, "Must query active exchanges");

    const selectAssets = queryLog.find((q) => q.sql.includes("SELECT id, symbol FROM assets"));
    assert.ok(selectAssets, "Must query tracked assets");

    const updateAssets = queryLog.filter((q) => q.sql.includes("UPDATE assets SET last_d1_close"));
    assert.equal(updateAssets.length, 3, "Must update 3 assets");

    const updateTriggers = queryLog.find((q) => q.sql.includes("UPDATE price_alerts pa"));
    assert.ok(updateTriggers, "Must update alert triggers using SQL JOIN / CASE");

    const countTriggers = queryLog.find((q) => q.sql.includes("COUNT(*) AS count FROM price_alerts"));
    assert.ok(countTriggers, "Must count triggered alerts");
  });
});
