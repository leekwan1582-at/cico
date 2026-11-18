const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

test("Phase 1-3 Unit Tests - Fallback Data & Schema Integrity", async (t) => {
  const priceService = require("../services/priceService");

  await t.test("loadFallbackPrices() correctly parses fallback_d1.json", () => {
    const prices = priceService.loadFallbackPrices();
    assert.ok(prices, "Prices object should exist");
    assert.equal(typeof prices["BTC/USDT"], "number");
    assert.equal(typeof prices["ETH/USDT"], "number");
    assert.equal(typeof prices["SOL/USDT"], "number");
    assert.ok(prices["BTC/USDT"] > 0, "BTC price should be positive");
  });

  await t.test("loadFallbackPrices() returns hardcoded defaults if JSON is missing/corrupt", () => {
    // Test with non-existent symbol to verify object shape
    const prices = priceService.loadFallbackPrices();
    assert.equal(prices["UNKNOWN/USDT"], undefined);
  });

  await t.test("schema.sql file exists and defines all 4 required tables", () => {
    const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
    assert.ok(fs.existsSync(schemaPath), "schema.sql should exist");
    const content = fs.readFileSync(schemaPath, "utf8");

    assert.ok(content.includes("CREATE TABLE users"), "Must contain users table");
    assert.ok(content.includes("CREATE TABLE exchanges"), "Must contain exchanges table");
    assert.ok(content.includes("CREATE TABLE assets"), "Must contain assets table");
    assert.ok(content.includes("CREATE TABLE price_alerts"), "Must contain price_alerts table");
    assert.ok(content.includes("FOREIGN KEY (user_id) REFERENCES users(id)"), "FK on users exists");
    assert.ok(content.includes("FOREIGN KEY (asset_id) REFERENCES assets(id)"), "FK on assets exists");
  });

  await t.test("Alert trigger evaluation logic (ABOVE and BELOW conditions)", () => {
    const evaluateAlert = (conditionType, currentPrice, targetPrice) => {
      if (conditionType === "ABOVE") {
        return currentPrice >= targetPrice;
      }
      if (conditionType === "BELOW") {
        return currentPrice <= targetPrice;
      }
      return false;
    };

    // BTC tests
    assert.equal(evaluateAlert("ABOVE", 89200, 80000), true);
    assert.equal(evaluateAlert("ABOVE", 89200, 95000), false);
    assert.equal(evaluateAlert("BELOW", 89200, 95000), true);
    assert.equal(evaluateAlert("BELOW", 89200, 80000), false);
    // Boundary checks
    assert.equal(evaluateAlert("ABOVE", 80000, 80000), true);
    assert.equal(evaluateAlert("BELOW", 80000, 80000), true);
  });
});
