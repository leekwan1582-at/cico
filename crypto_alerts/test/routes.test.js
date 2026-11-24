const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { encrypt, decrypt } = require("../services/cryptoService");

test("Phase 4 Integration Tests - Express CRUD Routes & Error Guards", async (t) => {
  const pool = require("../config/db");
  const priceService = require("../services/priceService");
  const authService = require("../services/authService");
  const app = require("../index");

  const originalPoolQuery = pool.query;
  const originalGetConnection = pool.getConnection;
  const originalRefresh = priceService.refreshAllPrices;

  let queryLog = [];
  let server;
  let baseUrl;

  let createdAssets = new Set(["EXISTING/USDT"]);
  let userWatchlists = new Map([
    [1, new Set([1])], // leekwan has asset 1 (BTC/USDT)
    [2, new Set([1])], // trader_sg also has asset 1 (BTC/USDT)
  ]);

  // Pre-generate test authentication cookies (Admin and Trader)
  const authUser = { id: 1, username: "leekwan", email: "leekwan@example.com", role: "ADMIN" };
  const authToken = authService.generateToken(authUser);
  const authHeaders = {
    Cookie: `jwt_token=${authToken}`,
  };

  const traderUser = { id: 2, username: "trader_sg", email: "trader@example.com", role: "TRADER" };
  const traderToken = authService.generateToken(traderUser);
  const traderHeaders = {
    Cookie: `jwt_token=${traderToken}`,
  };

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
      if (sql.includes("FROM users WHERE (username = ? OR email = ?) AND id != ?")) {
        return [[]]; // No duplicate
      }
      if (sql.includes("FROM users WHERE username = ? OR email = ?")) {
        const u = params && params[0];
        if (u === "leekwan") {
          return [[{
            id: 1,
            username: "leekwan",
            email: "leekwan@example.com",
            password_hash: "75c89040b67d232beb2433dda91fe53fc99fa84b49f13294be1bd263e0b7c0e042f920b95ad4c2a214251f2bdd8997acef67096462a6082c41d5d3a01d1f4ed2",
            password_salt: "cd2b87a224925d88668641b86d6d33fe",
            role: "ADMIN",
          }]];
        }
        return [[]];
      }
      if (sql.includes("INSERT INTO users")) {
        return [{ insertId: 99 }];
      }
      if (sql.includes("FROM users WHERE id = ?")) {
        const uid = params && params[0];
        if (uid == 1) {
          return [[{ id: 1, username: "leekwan", email: "leekwan@example.com", created_at: "2026-11-18 10:00:00" }]];
        }
        return [[]];
      }
      if (sql.includes("UPDATE users SET")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM users")) {
        return [
          [
            { id: 1, username: "leekwan", email: "leekwan@example.com" },
            { id: 2, username: "trader_sg", email: "trader.sg@example.com" },
          ],
        ];
      }

      // SELECT user_watchlist membership check
      if (sql.includes("FROM user_watchlist WHERE user_id = ? AND asset_id = ?")) {
        const uid = params && params[0];
        const aid = params && params[1];
        if (userWatchlists.has(uid) && userWatchlists.get(uid).has(aid)) {
          return [[{ id: 1 }]];
        }
        return [[]];
      }

      // SELECT user_watchlist for active symbols
      if (sql.includes("FROM user_watchlist uw") && sql.includes("JOIN assets a")) {
        const uid = params && params[0];
        const list = userWatchlists.get(uid) || new Set();
        const rows = [];
        if (list.has(1)) rows.push({ id: 1, symbol: "BTC/USDT", name: "Bitcoin", last_d1_close: 89000, last_updated: "2026-11-18 12:00:00", alert_count: 1 });
        if (list.has(2)) rows.push({ id: 2, symbol: "ETH/USDT", name: "Ethereum", last_d1_close: 3100, last_updated: "2026-11-18 12:00:00", alert_count: 0 });
        if (list.has(3)) rows.push({ id: 3, symbol: "XRP/USDT", name: "Ripple", last_d1_close: 1.0, last_updated: "2026-11-18 12:00:00", alert_count: 0 });
        return [rows];
      }

      // INSERT user_watchlist
      if (sql.includes("INSERT INTO user_watchlist")) {
        const uid = params && params[0];
        const aid = params && params[1];
        if (!userWatchlists.has(uid)) userWatchlists.set(uid, new Set());
        userWatchlists.get(uid).add(aid);
        return [{ insertId: 10 }];
      }

      // DELETE user_watchlist
      if (sql.includes("DELETE FROM user_watchlist WHERE user_id = ? AND asset_id = ?")) {
        const uid = params && params[0];
        const aid = params && params[1];
        if (userWatchlists.has(uid)) userWatchlists.get(uid).delete(aid);
        return [{ affectedRows: 1 }];
      }

      // SELECT assets (list or single)
      if (sql.includes("FROM assets a") || sql.includes("FROM assets ORDER BY id ASC") || sql.includes("FROM assets ORDER BY a.symbol ASC")) {
        return [
          [
            { id: 1, symbol: "BTC/USDT", name: "Bitcoin", last_d1_close: 89000, last_updated: "2026-11-18 12:00:00", alert_count: 1 },
            { id: 2, symbol: "ETH/USDT", name: "Ethereum", last_d1_close: 3100, last_updated: "2026-11-18 12:00:00", alert_count: 0 },
          ],
        ];
      }
      if (sql.includes("FROM assets WHERE symbol = ?")) {
        const sym = params && params[0];
        if (createdAssets.has(sym)) {
          return [[{ id: 3, symbol: sym, last_d1_close: 1.0 }]];
        }
        return [[]];
      }
      if (sql.includes("FROM assets WHERE id = ?")) {
        const id = params && params[0];
        if (id == 1) {
          return [[{ id: 1, symbol: "BTC/USDT", name: "Bitcoin", last_d1_close: 89000, last_updated: "2026-11-18 12:00:00" }]];
        }
        return [[]];
      }

      // INSERT asset
      if (sql.includes("INSERT INTO assets")) {
        if (params && params[0]) {
          createdAssets.add(params[0]);
        }
        return [{ insertId: 3 }];
      }

      // DELETE asset
      if (sql.includes("DELETE FROM assets WHERE id = ?")) {
        return [{ affectedRows: 1 }];
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
      if (sql.includes("FROM exchanges WHERE id = ?")) {
        return [[{ id: 1, ccxt_id: "okx", display_name: "OKX Singapore" }]];
      }

      // SELECT asset_ohlcv historical candles
      if (sql.includes("FROM asset_ohlcv")) {
        return [
          [
            { candle_time: "2026-11-17", open_price: 88000, high_price: 89500, low_price: 87500, close_price: 89000 },
            { candle_time: "2026-11-18", open_price: 89000, high_price: 90200, low_price: 88800, close_price: 89800 },
          ],
        ];
      }

      // SELECT single alert for ownership / editing
      if (sql.includes("FROM price_alerts WHERE id = ? AND user_id = ?")) {
        const id = params && params[0];
        const uid = params && params[1];
        if (id == 1 && uid == 1) {
          return [[{ id: 1, user_id: 1, asset_id: 1, condition_type: "ABOVE", target_price: 80000 }]];
        }
        return [[]]; // IDOR blocked
      }
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

      // SELECT user_notification_preferences
      if (sql.includes("FROM user_notification_preferences")) {
        const uid = params && params[0];
        if (uid == 1) {
          return [
            [
              {
                user_id: 1,
                default_channel: "TELEGRAM",
                telegram_target: encrypt("@test_chat"),
                discord_target: "",
                email_target: "leekwan@example.com",
                quiet_hours_enabled: 0,
                quiet_hours_start: "22:00:00",
                quiet_hours_end: "07:00:00",
                timezone: "Asia/Singapore",
              },
            ],
          ];
        }
        return [[]];
      }
      if (sql.includes("INSERT INTO user_notification_preferences")) {
        return [{ insertId: 1 }];
      }

      // SELECT notification_log
      if (sql.includes("FROM notification_log")) {
        return [
          [
            {
              id: 501,
              alert_id: 1,
              user_id: 1,
              channel: "TELEGRAM",
              recipient_target: encrypt("@test_chat"),
              status: "SENT",
              attempt_count: 1,
              max_attempts: 3,
              next_retry_at: null,
              last_error: null,
              message_payload: "Test Alert",
              sent_at: "2026-11-20 12:00:00",
              created_at: "2026-11-20 12:00:00",
            },
          ],
        ];
      }
      if (sql.includes("INSERT INTO notification_log")) {
        return [{ insertId: 501 }];
      }

      // SELECT alert_events
      if (sql.includes("FROM alert_events")) {
        return [
          [
            { id: 101, alert_id: 1, event_type: "CREATED", price_at_event: 88500, metric_value: 80000, message: "Alert created", created_at: "2026-11-18 10:00:00" },
            { id: 102, alert_id: 1, event_type: "TRIGGERED", price_at_event: 89000, metric_value: 80000, message: "Crossed target", created_at: "2026-11-18 12:00:00" },
          ],
        ];
      }

      // UPDATE user_watchlist
      if (sql.includes("UPDATE user_watchlist")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("INSERT INTO alert_events")) {
        return [{ insertId: 101 }];
      }

      // SELECT asset_analysis_reports
      if (sql.includes("FROM asset_analysis_reports") && sql.includes("WHERE r.id = ?")) {
        return [
          [
            {
              id: 1,
              asset_id: 1,
              user_id: 1,
              username: "leekwan",
              symbol: "BTC/USDT",
              name: "Bitcoin",
              last_d1_close: 89000,
              overall_score: 85,
              overall_signal: "STRONG_BUY",
              technical_score: 80,
              sentiment_score: 65,
              risk_level: "LOW",
              support_price: 84000,
              resistance_price: 94000,
              summary_text: "Strong bullish setup. 200W SMA Generational Value floor intact.",
              metrics_json: JSON.stringify({
                asset: { id: 1, symbol: "BTC/USDT", currentPrice: 89000 },
                technicals: { rsi14: 45, sma50: 82000, sma200: 68000 },
                sma200wEval: { sma200w: 60000, distancePct: 48.33, isAtOrBelow200w: false, isApproaching200w: false },
                sentiment: { fearAndGreed: { value: 65, classification: "Greed" } },
                buyOption: {
                  eligible: true,
                  badge: "💎 Generational Value Buy (<= 200W SMA)",
                  targetEntry: 60000,
                  suggestedTakeProfit: 95000,
                  suggestedStopLoss: 55000,
                  rationale: "Historical macro accumulation point."
                }
              }),
              created_at: "2026-11-22 10:00:00"
            }
          ]
        ];
      }
      if (sql.includes("FROM asset_analysis_reports") && sql.includes("WHERE r.asset_id = ?")) {
        return [
          [
            {
              id: 1,
              asset_id: 1,
              symbol: "BTC/USDT",
              name: "Bitcoin",
              last_d1_close: 89000,
              overall_score: 85,
              overall_signal: "STRONG_BUY",
              technical_score: 80,
              sentiment_score: 65,
              risk_level: "LOW",
              support_price: 84000,
              resistance_price: 94000,
              summary_text: "Strong bullish setup.",
              metrics_json: JSON.stringify({
                buyOption: { eligible: true, badge: "💎 Generational Value Buy" }
              }),
              created_at: "2026-11-22 10:00:00"
            }
          ]
        ];
      }
      if (sql.includes("INSERT INTO asset_analysis_reports")) {
        return [{ insertId: 1 }];
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
        return [{ affectedRows: 1 }];
      }

      // DELETE alert
      if (sql.includes("DELETE FROM price_alerts WHERE user_id = ? AND asset_id = ?")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("DELETE FROM price_alerts WHERE id = ?")) {
        return [{ affectedRows: 1 }];
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

  await t.test("GET / without auth redirects to /login", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location").includes("/login"));
  });

  await t.test("GET /login renders login page and handles query parameters", async () => {
    const res = await fetch(`${baseUrl}/login`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("Sign In"));
  });

  await t.test("POST /login authenticates valid user credentials and sets secure cookie", async () => {
    const formBody = new URLSearchParams({
      username: "leekwan",
      password: "password123",
      redirect: "/",
    });
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.ok(res.headers.get("set-cookie").includes("jwt_token="));
  });

  await t.test("POST /login rejects invalid credentials", async () => {
    const formBody = new URLSearchParams({
      username: "leekwan",
      password: "wrongpassword",
    });
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.ok(text.includes("Invalid username or password"));
  });

  await t.test("GET /register renders registration form", async () => {
    const res = await fetch(`${baseUrl}/register`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("Create Account") || text.includes("Register"));
  });

  await t.test("POST /register creates a new user account and sets session cookie", async () => {
    const formBody = new URLSearchParams({
      username: "newtrader",
      email: "newtrader@example.com",
      password: "password123",
    });
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.ok(res.headers.get("set-cookie").includes("jwt_token="));
  });

  await t.test("POST /register rejects duplicate username or email", async () => {
    const formBody = new URLSearchParams({
      username: "leekwan",
      email: "duplicate@example.com",
      password: "password123",
    });
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });

    assert.equal(res.status, 409);
    const text = await res.text();
    assert.ok(text.includes("already registered"));
  });

  await t.test("GET / loads dashboard and executes multi-table JOIN query when authenticated", async () => {
    const res = await fetch(`${baseUrl}/`, { headers: authHeaders });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("Crypto Daily Alerts"));

    const alertQuery = queryLog.find((q) => q.sql.includes("FROM price_alerts pa") && q.sql.includes("JOIN assets a"));
    assert.ok(alertQuery, "Must execute JOIN query across assets, users, and exchanges");
  });

  await t.test("GET /?status=active applies trigger filters scoped to authenticated user", async () => {
    const res = await fetch(`${baseUrl}/?status=active`, { headers: authHeaders });
    assert.equal(res.status, 200);

    const alertQuery = queryLog.find((q) => q.sql.includes("pa.user_id = ?") && q.sql.includes("pa.is_triggered = FALSE"));
    assert.ok(alertQuery, "Must filter with authenticated user_id and active status");
    assert.equal(alertQuery.params[0], 1);
  });

  await t.test("GET /?edit_id=1 pre-populates edit form", async () => {
    const res = await fetch(`${baseUrl}/?edit_id=1`, { headers: authHeaders });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("Edit Price Alert") && body.includes("alert #1"));
  });

  await t.test("GET /?edit_id=9999 returns 404 if alert does not exist", async () => {
    const res = await fetch(`${baseUrl}/?edit_id=9999`, { headers: authHeaders });
    assert.equal(res.status, 404);
    assert.ok((await res.text()).includes("Alert not found"));
  });

  await t.test("GET /?edit_id=not-a-number returns 400 Bad Request", async () => {
    const res = await fetch(`${baseUrl}/?edit_id=not-a-number`, { headers: authHeaders });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes("Invalid Alert ID"));
  });

  await t.test("POST /alerts validates input and creates new alert record", async () => {
    const formBody = new URLSearchParams({
      asset_id: "2",
      exchange_id: "1",
      target_price: "3500.50",
      condition_type: "above",
      notification_channel: "telegram",
      recipient_target: "@my_channel",
    });

    const res = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/?msg=saved");

    const insertQuery = queryLog.find((q) => q.sql.includes("INSERT INTO price_alerts"));
    assert.ok(insertQuery);
    assert.equal(insertQuery.params[0], 1);
    assert.equal(insertQuery.params[1], 2);
    assert.equal(insertQuery.params[2], 1);
    assert.equal(insertQuery.params[3], 3500.5);
    assert.equal(insertQuery.params[6], "ABOVE");
    assert.equal(insertQuery.params[7], "PRICE");
    assert.equal(insertQuery.params[8], "TELEGRAM");
    assert.equal(decrypt(insertQuery.params[9]), "@my_channel");
  });

  await t.test("POST /alerts supports PCT_CHANGE_24H_ABOVE and TRAILING_STOP condition types", async () => {
    // 24h Percentage Alert
    const pctBody = new URLSearchParams({
      asset_id: "1",
      exchange_id: "1",
      target_price: "5.0",
      condition_type: "PCT_CHANGE_24H_ABOVE",
      notification_channel: "IN_APP",
    });
    const res1 = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: pctBody.toString(),
      redirect: "manual",
    });
    assert.equal(res1.status, 302);

    const pctQuery = queryLog.find((q) => q.params && q.params.includes("PCT_CHANGE_24H_ABOVE"));
    assert.ok(pctQuery);
    assert.equal(pctQuery.params[7], "PCT_CHANGE_24H");

    // Trailing Stop Alert
    const tsBody = new URLSearchParams({
      asset_id: "1",
      exchange_id: "1",
      target_price: "6.5",
      condition_type: "TRAILING_STOP",
      notification_channel: "IN_APP",
    });
    const res2 = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: tsBody.toString(),
      redirect: "manual",
    });
    assert.equal(res2.status, 302);

    const tsQuery = queryLog.find((q) => q.params && q.params.includes("TRAILING_STOP"));
    assert.ok(tsQuery);
    assert.equal(tsQuery.params[7], "TRAILING_STOP");
  });

  await t.test("POST /alerts returns 400 on invalid target price or condition", async () => {
    const badPrice = new URLSearchParams({
      asset_id: "1",
      exchange_id: "1",
      target_price: "-100",
      condition_type: "ABOVE",
    });
    const res1 = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: badPrice.toString(),
    });
    assert.equal(res1.status, 400);

    const badCondition = new URLSearchParams({
      asset_id: "1",
      exchange_id: "1",
      target_price: "5000",
      condition_type: "INVALID_COND",
    });
    const res2 = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: badCondition.toString(),
    });
    assert.equal(res2.status, 400);
  });

  await t.test("POST /alerts/:id/update updates alert and resets is_triggered to FALSE", async () => {
    const formBody = new URLSearchParams({
      asset_id: "1",
      exchange_id: "1",
      target_price: "92000",
      condition_type: "BELOW",
      notification_channel: "EMAIL",
      recipient_target: "trader@example.com",
    });

    const res = await fetch(`${baseUrl}/alerts/1/update`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/?msg=updated");

    const updateQuery = queryLog.find((q) => q.sql.includes("UPDATE price_alerts"));
    assert.ok(updateQuery);
    assert.equal(updateQuery.params[0], 1);
    assert.equal(updateQuery.params[1], 1);
    assert.equal(updateQuery.params[2], 92000);
    assert.equal(updateQuery.params[5], "BELOW");
    assert.equal(updateQuery.params[6], "PRICE");
    assert.equal(updateQuery.params[7], "EMAIL");
    assert.equal(decrypt(updateQuery.params[8]), "trader@example.com");
    assert.equal(updateQuery.params[9], 1);
  });

  await t.test("POST /alerts/:id/delete deletes alert record scoped to authenticated user", async () => {
    const res = await fetch(`${baseUrl}/alerts/1/delete`, {
      method: "POST",
      headers: authHeaders,
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");

    const deleteQuery = queryLog.find((q) => q.sql.includes("DELETE FROM price_alerts WHERE id = ? AND user_id = ?"));
    assert.ok(deleteQuery);
    assert.deepEqual(deleteQuery.params, [1, 1]);
  });

  await t.test("IDOR Security: POST /alerts/:id/delete and /update protect alerts of other traders", async () => {
    // Trader 2 (id: 2) attempts to delete Trader 1's alert (id: 1)
    const delRes = await fetch(`${baseUrl}/alerts/1/delete`, {
      method: "POST",
      headers: traderHeaders, // Logged in as trader_sg (id: 2)
      redirect: "manual",
    });
    assert.equal(delRes.status, 302);

    // The query executed MUST pass user_id = 2, so it cannot delete id = 1 belonging to user 1
    const deleteQueries = queryLog.filter((q) => q.sql.includes("DELETE FROM price_alerts WHERE id = ? AND user_id = ?"));
    const lastDelete = deleteQueries[deleteQueries.length - 1];
    assert.ok(lastDelete);
    assert.deepEqual(lastDelete.params, [1, 2], "IDOR check: query must bind req.user.id (2), preventing cross-user deletion");

    // Trader 2 attempts to update Trader 1's alert (id: 1)
    const formBody = new URLSearchParams({
      asset_id: "1",
      exchange_id: "1",
      target_price: "99999",
      condition_type: "ABOVE",
    });
    const updateRes = await fetch(`${baseUrl}/alerts/1/update`, {
      method: "POST",
      headers: { ...traderHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });
    assert.equal(updateRes.status, 302);

    const updateQueries = queryLog.filter((q) => q.sql.includes("UPDATE price_alerts") && q.sql.includes("WHERE id = ? AND user_id = ?"));
    const lastUpdate = updateQueries[updateQueries.length - 1];
    assert.ok(lastUpdate);
    assert.equal(lastUpdate.params[lastUpdate.params.length - 2], 1, "Target alert ID");
    assert.equal(lastUpdate.params[lastUpdate.params.length - 1], 2, "IDOR check: must bind authenticated user_id (2)");
  });

  await t.test("POST /refresh triggers priceService.refreshAllPrices and redirects for admin", async () => {
    let refreshCalled = false;
    priceService.refreshAllPrices = async () => {
      refreshCalled = true;
      return { sourceUsed: "Mock Source", updatedAssets: [], triggeredCount: 0 };
    };

    const res = await fetch(`${baseUrl}/refresh`, {
      method: "POST",
      headers: authHeaders,
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(refreshCalled, true, "refreshAllPrices() should be invoked for admin");
  });

  await t.test("POST /refresh returns 403 Forbidden for non-admin user", async () => {
    const res = await fetch(`${baseUrl}/refresh`, {
      method: "POST",
      headers: traderHeaders,
      redirect: "manual",
    });

    assert.equal(res.status, 403, "Non-admin trader must be forbidden from triggering refresh");
  });

  await t.test("POST /refresh rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/refresh`, {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location").includes("/login"));
  });

  await t.test("POST /reset-db triggers seedDatabase() for admin user", async () => {
    const seedModule = require("../seed");
    let seedCalled = false;
    const originalSeed = seedModule.seedDatabase;
    seedModule.seedDatabase = async () => {
      seedCalled = true;
      return { success: true };
    };

    const res = await fetch(`${baseUrl}/reset-db`, {
      method: "POST",
      headers: authHeaders,
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(seedCalled, true, "seedDatabase() should be called");

    // Restore original seed function
    seedModule.seedDatabase = originalSeed;
  });

  await t.test("POST /reset-db rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/reset-db`, {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location").includes("/login"));
  });

  await t.test("POST /reset-db returns 403 Forbidden for non-admin user", async () => {
    const res = await fetch(`${baseUrl}/reset-db`, {
      method: "POST",
      headers: traderHeaders,
      redirect: "manual",
    });
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.ok(text.includes("Administrator privilege required"));
  });

  await t.test("POST /reset-db returns 403 Forbidden when NODE_ENV is production", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await fetch(`${baseUrl}/reset-db`, {
        method: "POST",
        headers: authHeaders,
        redirect: "manual",
      });
      assert.equal(res.status, 403);
      const text = await res.text();
      assert.ok(text.includes("strictly prohibited in production"));
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  await t.test("GET /api/assets/:id/chart-data returns 200 with formatted series and annotations", async () => {
    const res = await fetch(`${baseUrl}/api/assets/1/chart-data?exchange_id=1&days=30`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.asset.id, 1);
    assert.equal(json.asset.symbol, "BTC/USDT");
    assert.equal(json.exchange.id, 1);
    assert.ok(Array.isArray(json.series));
    assert.ok(json.series.length > 0);
    assert.equal(json.series[0].y.length, 4, "Candle must contain [open, high, low, close]");
    assert.ok(Array.isArray(json.annotations));
    assert.ok(json.timeframe);
    assert.equal(json.timeframe.currentDays, 30);
    assert.equal(json.timeframe.defaultDays, 7);
  });

  await t.test("GET /api/assets/:id/chart-data falls back to default 7D when days param is invalid or unsupported", async () => {
    const res = await fetch(`${baseUrl}/api/assets/1/chart-data?exchange_id=1&days=999`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.timeframe.currentDays, 7, "Should fall back to CHART_DEFAULT_TIMEFRAME (7D)");
  });

  await t.test("GET /api/assets/:id/chart-data supports 180D timeframe", async () => {
    const res = await fetch(`${baseUrl}/api/assets/1/chart-data?exchange_id=1&days=180`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.timeframe.currentDays, 180);
  });

  await t.test("GET /api/assets/:id/chart-data supports multi-timeframe candles (1h, 4h, 1d, 1w) (Phase 8+ 3.6)", async () => {
    // 1h timeframe
    const res1h = await fetch(`${baseUrl}/api/assets/1/chart-data?exchange_id=1&days=7&timeframe=1h`, {
      headers: authHeaders,
    });
    assert.equal(res1h.status, 200);
    const json1h = await res1h.json();
    assert.ok(Array.isArray(json1h.series));
    assert.ok(json1h.series.length > 0);

    // 4h timeframe
    const res4h = await fetch(`${baseUrl}/api/assets/1/chart-data?exchange_id=1&days=30&timeframe=4h`, {
      headers: authHeaders,
    });
    assert.equal(res4h.status, 200);
    const json4h = await res4h.json();
    assert.ok(Array.isArray(json4h.series));
    assert.ok(json4h.series.length > 0);

    // 1w timeframe
    const res1w = await fetch(`${baseUrl}/api/assets/1/chart-data?exchange_id=1&days=180&timeframe=1w`, {
      headers: authHeaders,
    });
    assert.equal(res1w.status, 200);
    const json1w = await res1w.json();
    assert.ok(Array.isArray(json1w.series));
    assert.ok(json1w.series.length > 0);
  });

  await t.test("GET /api/assets/:id/chart-data returns 400 on invalid asset ID", async () => {
    const res = await fetch(`${baseUrl}/api/assets/invalid-id/chart-data`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, "Invalid Asset ID");
  });

  await t.test("GET /api/assets/:id/chart-data returns 404 when asset does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/assets/9999/chart-data`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error, "Asset not found");
  });

  await t.test("GET /health and GET /status returns 200 with DB status, latency, and metrics", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.status, "ok");
    assert.equal(json.database.status, "connected");
    assert.ok(typeof json.database.latencyMs === "number");
    assert.ok(json.alerts);
    assert.ok(typeof json.alerts.total === "number");
    assert.ok(json.scheduler);
    assert.equal(json.scheduler.scheduleType, "HOURLY");

    const aliasRes = await fetch(`${baseUrl}/status`);
    assert.equal(aliasRes.status, 200);
  });

  await t.test("GET /assets returns 200 with watchlist pairs in JSON format", async () => {
    const res = await fetch(`${baseUrl}/assets?format=json`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.assets));
    assert.ok(json.assets.length > 0);
  });

  await t.test("GET /assets without auth redirects to /login", async () => {
    const res = await fetch(`${baseUrl}/assets`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location").includes("/login"));
  });

  await t.test("POST /assets creates a new pair with CCXT/offline validation", async () => {
    const res = await fetch(`${baseUrl}/assets`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ symbol: "XRP/USDT", name: "Ripple" }),
    });

    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.asset.symbol, "XRP/USDT");

    // Attempt duplicate - should return 409
    const dupRes = await fetch(`${baseUrl}/assets`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ symbol: "XRP/USDT", name: "Ripple" }),
    });
    assert.equal(dupRes.status, 409);
  });

  await t.test("POST /assets rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ symbol: "DOT/USDT", name: "Polkadot" }),
    });
    assert.equal(res.status, 401);
  });

  await t.test("POST /assets rejects invalid pair format", async () => {
    const res = await fetch(`${baseUrl}/assets`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ symbol: "INVALID_PAIR", name: "Invalid" }),
    });
    assert.equal(res.status, 400);
  });

  await t.test("POST /assets rejects malicious XSS characters in name", async () => {
    const res = await fetch(`${baseUrl}/assets`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ symbol: "DOGE/USDT", name: '<img src=x onerror="alert(1)">' }),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(text.includes("cannot contain special HTML characters"));
  });

  await t.test("POST /assets/:id/delete deletes asset from user watchlist and returns success", async () => {
    // Delete the seeded asset 1 from user 1's watchlist
    const res = await fetch(`${baseUrl}/assets/1/delete`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Accept": "application/json",
      },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(json.message.includes("removed from your watchlist"));

    // Verify S3 privacy isolation: Trader 2 still has asset 1 in their watchlist!
    assert.ok(userWatchlists.get(2).has(1), "Trader 2's watchlist must not be deleted when Trader 1 removes the asset");
  });

  await t.test("POST /assets/:id/delete rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/assets/1/delete`, {
      method: "POST",
      headers: { "Accept": "application/json" },
    });
    assert.equal(res.status, 401);
  });

  await t.test("GET /api/markets/catalog returns catalog with is_on_watchlist flags and supports query search", async () => {
    const res = await fetch(`${baseUrl}/api/markets/catalog`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.catalog));
    assert.ok(json.catalog.length > 0);

    const btc = json.catalog.find((c) => c.symbol === "BTC/USDT");
    assert.ok(btc);
    assert.equal(typeof btc.is_on_watchlist, "boolean");

    // Search query filtering
    const searchRes = await fetch(`${baseUrl}/api/markets/catalog?q=sol`);
    assert.equal(searchRes.status, 200);
    const searchJson = await searchRes.json();
    assert.ok(searchJson.catalog.length > 0);
    assert.ok(searchJson.catalog.every((c) => c.symbol.toLowerCase().includes("sol") || c.name.toLowerCase().includes("sol")));
  });

  await t.test("GET /profile returns authenticated trader details", async () => {
    const res = await fetch(`${baseUrl}/profile`, { headers: authHeaders });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.user.username, "leekwan");
    assert.equal(json.user.email, "leekwan@example.com");
  });

  await t.test("POST /profile updates profile and returns updated JWT cookie", async () => {
    const res = await fetch(`${baseUrl}/profile`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "leekwan_pro",
        email: "leekwan.pro@example.com",
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.user.username, "leekwan_pro");
    assert.ok(res.headers.get("set-cookie").includes("jwt_token="));
  });

  await t.test("404 catch-all returns Page Not Found on non-existent endpoints", async () => {
    const res = await fetch(`${baseUrl}/non-existent-endpoint`);
    assert.equal(res.status, 404);
    assert.ok((await res.text()).includes("Page Not Found"));
  });

  // ==========================================
  // RBAC Tests (Phase 8+ 3.1)
  // ==========================================
  await t.test("RBAC: GET /api/admin/health/detail allows ADMIN and forbids TRADER", async () => {
    // 1. TRADER gets 403 Forbidden
    const traderRes = await fetch(`${baseUrl}/api/admin/health/detail`, { headers: traderHeaders });
    assert.equal(traderRes.status, 403);
    const traderJson = await traderRes.json();
    assert.equal(traderJson.error, "Forbidden");

    // 2. ADMIN gets 200 OK with host and memory details
    const adminRes = await fetch(`${baseUrl}/api/admin/health/detail`, { headers: authHeaders });
    assert.equal(adminRes.status, 200);
    const adminJson = await adminRes.json();
    assert.equal(adminJson.status, "ok");
    assert.equal(adminJson.adminUser, "leekwan");
    assert.ok(adminJson.host);
    assert.ok(adminJson.memory);
    assert.ok(adminJson.database);
  });

  await t.test("RBAC: /api/admin/exchanges endpoints allow ADMIN and forbid TRADER", async () => {
    // 1. TRADER forbidden from listing exchanges
    const traderRes = await fetch(`${baseUrl}/api/admin/exchanges`, { headers: traderHeaders });
    assert.equal(traderRes.status, 403);

    // 2. ADMIN can list exchanges
    const listRes = await fetch(`${baseUrl}/api/admin/exchanges`, { headers: authHeaders });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.success, true);
    assert.ok(Array.isArray(listJson.exchanges));

    // 3. TRADER forbidden from registering new exchange
    const traderPost = await fetch(`${baseUrl}/api/admin/exchanges`, {
      method: "POST",
      headers: { ...traderHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ ccxt_id: "kraken", display_name: "Kraken" }),
    });
    assert.equal(traderPost.status, 403);

    // 4. ADMIN can register new exchange
    const adminPost = await fetch(`${baseUrl}/api/admin/exchanges`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ ccxt_id: "kraken", display_name: "Kraken" }),
    });
    assert.equal(adminPost.status, 201);
    const postJson = await adminPost.json();
    assert.equal(postJson.success, true);
    assert.equal(postJson.exchange.ccxt_id, "kraken");

    // 5. ADMIN can update existing exchange
    const adminPut = await fetch(`${baseUrl}/api/admin/exchanges/1`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "OKX SG Updated", priority_order: 1 }),
    });
    assert.equal(adminPut.status, 200);
    const putJson = await adminPut.json();
    assert.equal(putJson.success, true);
  });

  await t.test("RBAC: Master asset endpoints allow ADMIN and forbid TRADER", async () => {
    // 1. TRADER forbidden from listing master assets overview
    const traderGet = await fetch(`${baseUrl}/api/admin/assets`, { headers: traderHeaders });
    assert.equal(traderGet.status, 403);

    // 2. ADMIN can view master assets with global watcher counts
    const adminGet = await fetch(`${baseUrl}/api/admin/assets`, { headers: authHeaders });
    assert.equal(adminGet.status, 200);
    const getJson = await adminGet.json();
    assert.equal(getJson.success, true);
    assert.ok(Array.isArray(getJson.assets));

    // 3. TRADER forbidden from deleting master shared asset
    const traderDel = await fetch(`${baseUrl}/api/admin/assets/1`, {
      method: "DELETE",
      headers: traderHeaders,
    });
    assert.equal(traderDel.status, 403);

    // 4. ADMIN can delete master asset
    const adminDel = await fetch(`${baseUrl}/api/admin/assets/1`, {
      method: "DELETE",
      headers: authHeaders,
    });
    assert.equal(adminDel.status, 200);
    const delJson = await adminDel.json();
    assert.equal(delJson.success, true);
    assert.ok(delJson.message.includes("permanently removed"));
  });

  // ==========================================
  // Alert Events & Audit Trail Tests (Phase 8+ 3.2)
  // ==========================================
  await t.test("Audit Trail: GET /api/alerts/:id/events returns history for owner and guards IDOR", async () => {
    // 1. Owner (leekwan, id: 1) views alert #1 event timeline
    const ownerRes = await fetch(`${baseUrl}/api/alerts/1/events`, { headers: authHeaders });
    assert.equal(ownerRes.status, 200);
    const ownerJson = await ownerRes.json();
    assert.equal(ownerJson.success, true);
    assert.ok(Array.isArray(ownerJson.events));
    assert.equal(ownerJson.count, 2);
    assert.equal(ownerJson.events[0].event_type, "CREATED");

    // 2. IDOR check: Trader 2 tries to access Trader 1's alert #1 timeline
    const idorRes = await fetch(`${baseUrl}/api/alerts/1/events`, { headers: traderHeaders });
    assert.equal(idorRes.status, 404);
    const idorJson = await idorRes.json();
    assert.equal(idorJson.error, "Alert not found or unauthorized");

    // 3. Unauthenticated request rejected
    const unauthRes = await fetch(`${baseUrl}/api/alerts/1/events`);
    assert.equal(unauthRes.status, 401);
  });

  await t.test("Candlestick Chart: GET /api/assets/:id/chart-data includes triggerEvents point annotations", async () => {
    const res = await fetch(`${baseUrl}/api/assets/1/chart-data?exchange_id=1&days=30`, {
      headers: authHeaders,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.triggerEvents), "Must return triggerEvents array");
    assert.ok(json.triggerEvents.length > 0);
    assert.equal(json.triggerEvents[0].eventType, "CREATED");
  });

  // ==========================================
  // Notification Reliability Layer Tests (Phase 8+ 3.3)
  // ==========================================
  await t.test("Notification Prefs: GET & POST /api/notifications/preferences works and encrypts targets", async () => {
    // 1. GET preferences
    const getRes = await fetch(`${baseUrl}/api/notifications/preferences`, { headers: authHeaders });
    assert.equal(getRes.status, 200);
    const getJson = await getRes.json();
    assert.equal(getJson.success, true);
    assert.equal(getJson.preferences.defaultChannel, "TELEGRAM");
    assert.ok(getJson.preferences.telegramMasked);

    // 2. POST update preferences
    const postRes = await fetch(`${baseUrl}/api/notifications/preferences`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        default_channel: "DISCORD",
        discord_target: "https://discord.com/api/webhooks/999/xyz",
        quiet_hours_enabled: true,
        quiet_hours_start: "23:00",
        quiet_hours_end: "08:00",
      }),
    });
    assert.equal(postRes.status, 200);
    const postJson = await postRes.json();
    assert.equal(postJson.success, true);
    assert.equal(postJson.preferences.defaultChannel, "DISCORD");
    assert.ok(postJson.preferences.discordMasked.includes("https://discord.com/.../"));

    // Verify DB query had encrypted target
    const upsertQuery = queryLog.find((q) => q.sql.includes("INSERT INTO user_notification_preferences"));
    assert.ok(upsertQuery);
    const encDiscordParam = upsertQuery.params[3]; // discord_target param
    assert.ok(encDiscordParam.startsWith("enc:v1:"), "Must encrypt sensitive webhook destination at rest");
  });

  await t.test("Test Notification: POST /api/notifications/test sends immediate test alert", async () => {
    const testRes = await fetch(`${baseUrl}/api/notifications/test`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "IN_APP" }),
    });
    assert.equal(testRes.status, 200);
    const testJson = await testRes.json();
    assert.equal(testJson.success, true);
    assert.equal(testJson.channel, "IN_APP");
  });

  await t.test("Notification Log: GET /api/notifications/logs retrieves history with masked targets", async () => {
    const logRes = await fetch(`${baseUrl}/api/notifications/logs`, { headers: authHeaders });
    assert.equal(logRes.status, 200);
    const logJson = await logRes.json();
    assert.equal(logJson.success, true);
    assert.ok(Array.isArray(logJson.logs));
    assert.ok(logJson.logs.length > 0);
    assert.equal(logJson.logs[0].status, "SENT");
    assert.ok(!logJson.logs[0].recipient_target.startsWith("enc:v1:"), "API output must be masked, not raw ciphertext");
  });

  // ==========================================
  // Watchlist Customization & Portfolio View Tests (Phase 8+ 3.4)
  // ==========================================
  await t.test("Watchlist Customization: POST /api/watchlist/reorder updates custom sort & pin", async () => {
    const res = await fetch(`${baseUrl}/api/watchlist/reorder`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { assetId: 1, sortOrder: 1, isPinned: true },
          { assetId: 2, sortOrder: 2, isPinned: false },
        ],
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    const updateQuery = queryLog.find((q) => q.sql.includes("UPDATE user_watchlist SET sort_order = ?"));
    assert.ok(updateQuery, "Must issue update for user_watchlist sort order and pin state");
  });

  await t.test("Portfolio View: POST /api/watchlist/:id/portfolio saves holdings & validates bounds", async () => {
    // 1. Success update
    const res = await fetch(`${baseUrl}/api/watchlist/1/portfolio`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        holding_qty: 0.75,
        avg_cost: 84000.5,
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.holdings.holdingQty, 0.75);
    assert.equal(json.holdings.avgCost, 84000.5);

    // 2. Negative validation
    const badRes = await fetch(`${baseUrl}/api/watchlist/1/portfolio`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        holding_qty: -5,
      }),
    });
    assert.equal(badRes.status, 400);
  });

  // ==========================================
  // Phase 8+ 3.5: Technical-Indicator Alerts
  // ==========================================
  await t.test("Technical Indicator Alerts: POST /alerts creates RSI_14, SMA_CROSS, and VOLUME_SPIKE alerts", async () => {
    // 1. Create RSI_14 alert (Overbought: RSI_ABOVE 70)
    const rsiRes = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded", redirect: "manual" },
      body: new URLSearchParams({
        user_id: "1",
        asset_id: "1",
        exchange_id: "1",
        condition_type: "RSI_ABOVE",
        target_price: "70",
        notification_channel: "IN_APP",
      }).toString(),
    });
    assert.ok([200, 302, 303].includes(rsiRes.status), "RSI alert creation should redirect or succeed");

    const rsiInsert = queryLog.find((q) => q.sql.includes("INSERT INTO price_alerts") && q.params && q.params.includes("RSI_14"));
    assert.ok(rsiInsert, "Must insert alert with condition_metric = 'RSI_14'");
    assert.ok(rsiInsert.params.includes("RSI_ABOVE"), "Must have condition_type = 'RSI_ABOVE'");

    // 2. Create SMA_CROSS alert (SMA_GOLDEN_CROSS)
    const smaRes = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded", redirect: "manual" },
      body: new URLSearchParams({
        user_id: "1",
        asset_id: "1",
        exchange_id: "1",
        condition_type: "SMA_GOLDEN_CROSS",
        target_price: "1",
        notification_channel: "IN_APP",
      }).toString(),
    });
    assert.ok([200, 302, 303].includes(smaRes.status), "SMA alert creation should redirect or succeed");

    const smaInsert = queryLog.find((q) => q.sql.includes("INSERT INTO price_alerts") && q.params && q.params.includes("SMA_CROSS"));
    assert.ok(smaInsert, "Must insert alert with condition_metric = 'SMA_CROSS'");
    assert.ok(smaInsert.params.includes("SMA_GOLDEN_CROSS"), "Must have condition_type = 'SMA_GOLDEN_CROSS'");

    // 3. Create VOLUME_SPIKE alert (target = 2.5x 20-day average)
    const volRes = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/x-www-form-urlencoded", redirect: "manual" },
      body: new URLSearchParams({
        user_id: "1",
        asset_id: "1",
        exchange_id: "1",
        condition_type: "VOLUME_SPIKE",
        target_price: "2.5",
        notification_channel: "IN_APP",
      }).toString(),
    });
    assert.ok([200, 302, 303].includes(volRes.status), "Volume spike alert creation should redirect or succeed");

    const volInsert = queryLog.find((q) => q.sql.includes("INSERT INTO price_alerts") && q.params && q.params.includes("VOLUME_SPIKE"));
    assert.ok(volInsert, "Must insert alert with condition_metric = 'VOLUME_SPIKE'");
    assert.ok(volInsert.params.includes("VOLUME_SPIKE"), "Must have condition_type = 'VOLUME_SPIKE'");
  });

  await t.test("Real-Time Updates: GET /api/stream establishes SSE connection and requires auth (Phase 8+ 3.7)", async () => {
    // 1. Unauthenticated request should redirect to login or be rejected
    const unauthRes = await fetch(`${baseUrl}/api/stream`, {
      redirect: "manual",
    });
    assert.ok([302, 401, 403].includes(unauthRes.status), "Unauthenticated SSE request must be protected");

    // 2. Authenticated request establishes SSE stream
    const authHeaders = {
      Cookie: `jwt_token=${authToken}`,
    };

    const controller = new AbortController();
    const ssePromise = fetch(`${baseUrl}/api/stream`, {
      headers: authHeaders,
      signal: controller.signal,
    });

    const res = await ssePromise;
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

    // Read initial handshake packet from stream
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    assert.ok(text.includes("event: connected"));
    assert.ok(text.includes("clientId"));

    // Clean up
    controller.abort();
  });

  await t.test("Data Export & REST API: GET /api/alerts.csv and /api/alerts.json (Phase 8+ 3.8)", async () => {
    const authHeaders = {
      Cookie: `jwt_token=${authToken}`,
    };

    // 1. GET /api/alerts.csv
    const csvRes = await fetch(`${baseUrl}/api/alerts.csv`, { headers: authHeaders });
    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.headers.get("content-type")?.includes("text/csv"));
    assert.ok(csvRes.headers.get("content-disposition")?.includes("crypto_alerts_"));
    const csvBody = await csvRes.text();
    assert.ok(csvBody.includes("Asset Symbol"));
    assert.ok(csvBody.includes("Target Price"));

    // 2. GET /api/alerts.json
    const jsonRes = await fetch(`${baseUrl}/api/alerts.json`, { headers: authHeaders });
    assert.equal(jsonRes.status, 200);
    const jsonData = await jsonRes.json();
    assert.equal(jsonData.success, true);
    assert.ok(Array.isArray(jsonData.alerts));

    // 3. GET /api/openapi.json & GET /api/docs
    const openapiRes = await fetch(`${baseUrl}/api/openapi.json`);
    assert.equal(openapiRes.status, 200);
    const spec = await openapiRes.json();
    assert.equal(spec.openapi, "3.0.3");

    const docsRes = await fetch(`${baseUrl}/api/docs`);
    assert.equal(docsRes.status, 200);
    const docsHtml = await docsRes.text();
    assert.ok(docsHtml.includes("SwaggerUIBundle"));

    // 4. GET /api/tokens (list tokens)
    const tokensRes = await fetch(`${baseUrl}/api/tokens`, { headers: authHeaders });
    assert.equal(tokensRes.status, 200);
    const tokensData = await tokensRes.json();
    assert.equal(tokensData.success, true);
    assert.ok(Array.isArray(tokensData.tokens));
  });

  await t.test("Coin Deep Analysis & Reports: POST /api/assets/:id/analysis, GET latest, JSON and print view", async () => {
    const authHeaders = {
      Cookie: `jwt_token=${authToken}`,
    };

    // 1. POST /api/assets/:id/analysis
    const postRes = await fetch(`${baseUrl}/api/assets/1/analysis`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ exchange_id: 1 })
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.success, true);
    assert.ok(postData.report);
    assert.equal(postData.report.assetId, 1);
    assert.ok(typeof postData.report.overallScore === "number");
    assert.ok(postData.report.buyOption);

    // 2. GET /api/assets/:id/analysis/latest
    const latestRes = await fetch(`${baseUrl}/api/assets/1/analysis/latest`, { headers: authHeaders });
    assert.equal(latestRes.status, 200);
    const latestData = await latestRes.json();
    assert.equal(latestData.success, true);
    assert.equal(latestData.report.assetId, 1);

    // 3. GET /api/reports/:id.json
    const jsonRes = await fetch(`${baseUrl}/api/reports/1.json`, { headers: authHeaders });
    assert.equal(jsonRes.status, 200);
    const reportJson = await jsonRes.json();
    assert.equal(reportJson.success, true);
    assert.equal(reportJson.report.id, 1);
    assert.ok(reportJson.report.metrics);

    // 4. GET /reports/:id/print (Printable HTML view)
    const printRes = await fetch(`${baseUrl}/reports/1/print`, { headers: authHeaders });
    assert.equal(printRes.status, 200);
    const printHtml = await printRes.text();
    assert.ok(printHtml.includes("Deep Asset Analysis"));
    assert.ok(printHtml.includes("Print / Save as PDF"));
    assert.ok(printHtml.includes("200-Week SMA"));
  });
});
