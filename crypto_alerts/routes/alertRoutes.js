/**
 * @file Alert and Market Dashboard Routes
 * @description Express routing module managing CRUD operations for price alerts,
 * filtering criteria (user, status), pre-population for edits, price refreshes, and database resets.
 * @module routes/alertRoutes
 */

const express = require("express");
const path = require("path");
const router = express.Router();
const pool = require("../config/db");
const priceService = require("../services/priceService");
const seedModule = require("../seed");
const chartConfig = require("../config/chartConfig");
const schedulerService = require("../services/schedulerService");
const authService = require("../services/authService");
const cryptoService = require("../services/cryptoService");
const notificationService = require("../services/notificationService");
const sseService = require("../services/sseService");
const tokenService = require("../services/tokenService");
const analysisService = require("../services/analysisService");
const { requireAuth, requireRole, requireAdmin, requireScope, optionalAuth, sanitizeRedirectUrl } = require("../middleware/authMiddleware");

/**
 * Route: GET /login
 * @description Renders login form.
 */
router.get("/login", (req, res) => {
  const safeRedirect = sanitizeRedirectUrl(req.query.redirect || "/");
  res.render("login", {
    error: req.query.error || null,
    registered: req.query.registered || null,
    redirectUrl: safeRedirect,
  });
});

/**
 * Route: POST /login
 * @description Authenticates user with username/email and password, sets JWT cookie.
 */
router.post("/login", async (req, res, next) => {
  try {
    const { username, password, redirect: redirectParam } = req.body;
    const safeRedirect = sanitizeRedirectUrl(redirectParam || "/");

    if (!username || !password) {
      return res.status(400).render("login", {
        error: "Username and password are required.",
        registered: null,
        redirectUrl: safeRedirect,
      });
    }

    const [rows] = await pool.query(
      "SELECT id, username, email, password_hash, password_salt, role FROM users WHERE username = ? OR email = ?",
      [username.trim(), username.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).render("login", {
        error: "Invalid username or password.",
        registered: null,
        redirectUrl: safeRedirect,
      });
    }

    const user = rows[0];
    const isValid = await authService.verifyPassword(password, user.password_hash, user.password_salt);
    if (!isValid) {
      return res.status(401).render("login", {
        error: "Invalid username or password.",
        registered: null,
        redirectUrl: safeRedirect,
      });
    }

    // Generate JWT token
    const rawRole = user.role || (user.username === "leekwan" ? "ADMIN" : "TRADER");
    const role = String(rawRole).toUpperCase();
    const token = authService.generateToken({
      id: user.id,
      username: user.username,
      email: user.email,
      role: role,
    });

    // Set secure HTTP-Only cookie
    res.setHeader("Set-Cookie", `jwt_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);

    res.redirect(safeRedirect);
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /register
 * @description Renders user registration page.
 */
router.get("/register", (req, res) => {
  res.render("register", { error: req.query.error || null });
});

/**
 * Route: POST /register
 * @description Creates a new user with hashed password and logs them in.
 */
router.post("/register", async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password || password.length < 6) {
      return res.status(400).render("register", {
        error: "All fields are required. Password must be at least 6 characters.",
      });
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    // Check duplicate
    const [existing] = await pool.query(
      "SELECT id FROM users WHERE username = ? OR email = ?",
      [cleanUsername, cleanEmail]
    );
    if (existing.length > 0) {
      return res.status(409).render("register", {
        error: "Username or email is already registered.",
      });
    }

    const { hash, salt } = await authService.hashPassword(password);
    const [result] = await pool.query(
      "INSERT INTO users (username, email, password_hash, password_salt, role) VALUES (?, ?, ?, ?, 'TRADER')",
      [cleanUsername, cleanEmail, hash, salt]
    );

    const token = authService.generateToken({
      id: result.insertId,
      username: cleanUsername,
      email: cleanEmail,
      role: "TRADER",
    });

    res.setHeader("Set-Cookie", `jwt_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /logout
 * @description Clears JWT session cookie.
 */
router.all("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "jwt_token=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  res.redirect("/login");
});

/**
 * Route: GET /profile
 * @description Returns authenticated user's profile details.
 */
router.get("/profile", requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT id, username, email, created_at FROM users WHERE id = ?", [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /profile
 * @description Updates authenticated user's username, email, and optionally password.
 */
router.post("/profile", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { username, email, new_password, current_password } = req.body;

    if (!username || !email) {
      return res.status(400).json({ error: "Username and email are required" });
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    // Check duplicate username/email by another user
    const [duplicates] = await pool.query(
      "SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?",
      [cleanUsername, cleanEmail, userId]
    );
    if (duplicates.length > 0) {
      return res.status(409).json({ error: "Username or email is already taken by another account" });
    }

    // If changing password, verify current password first
    if (new_password) {
      if (new_password.length < 6) {
        return res.status(400).json({ error: "New password must be at least 6 characters" });
      }
      if (!current_password) {
        return res.status(400).json({ error: "Current password is required to set a new password" });
      }

      const [userRows] = await pool.query("SELECT password_hash, password_salt FROM users WHERE id = ?", [userId]);
      const currentValid = await authService.verifyPassword(current_password, userRows[0].password_hash, userRows[0].password_salt);
      if (!currentValid) {
        return res.status(401).json({ error: "Current password does not match" });
      }

      const { hash: newHash, salt: newSalt } = await authService.hashPassword(new_password);
      await pool.query(
        "UPDATE users SET username = ?, email = ?, password_hash = ?, password_salt = ? WHERE id = ?",
        [cleanUsername, cleanEmail, newHash, newSalt, userId]
      );
    } else {
      await pool.query(
        "UPDATE users SET username = ?, email = ? WHERE id = ?",
        [cleanUsername, cleanEmail, userId]
      );
    }

    // Refresh JWT session cookie with updated username and email
    const updatedToken = authService.generateToken({
      id: userId,
      username: cleanUsername,
      email: cleanEmail,
    });
    res.setHeader("Set-Cookie", `jwt_token=${updatedToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);

    res.json({
      success: true,
      message: "Profile updated successfully!",
      user: { id: userId, username: cleanUsername, email: cleanEmail },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /
 * @description Loads the main Split-View dashboard with optional multi-criteria filters:
 * - Scoped automatically to authenticated req.user.id for strict privacy isolation.
 * - `status`: Filter by status ('active' -> is_triggered=0, 'triggered' -> is_triggered=1, 'all' -> all).
 * - `edit_id`: Pre-populates the left-column form with existing alert details for modification.
 * @route GET /
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const currentUserId = req.user.id;
    const isAdmin = req.user.role === "ADMIN";
    const selectedStatus = req.query.status || "all";

    // 2. Validate and fetch single record for edit if edit_id parameter is present in query (scoped to user, or admin edit)
    let editAlert = null;
    if (req.query.edit_id !== undefined) {
      const editId = parseInt(req.query.edit_id, 10);
      if (isNaN(editId) || editId <= 0) {
        return res.status(400).send("Invalid Alert ID");
      }
      const editSql = isAdmin 
        ? "SELECT * FROM price_alerts WHERE id = ?" 
        : "SELECT * FROM price_alerts WHERE id = ? AND user_id = ?";
      const editParams = isAdmin ? [editId] : [editId, currentUserId];
      const [editRows] = await pool.query(editSql, editParams);
      if (editRows.length === 0) {
        return res.status(404).send("Alert not found");
      }
      editAlert = editRows[0];
    }

    // 1. Fetch dropdown options & reference data
    // Admin sees all users; non-admin (Trader) only sees themselves for strict privacy isolation
    const [users] = isAdmin
      ? await pool.query("SELECT id, username, email FROM users ORDER BY username ASC")
      : await pool.query("SELECT id, username, email FROM users WHERE id = ?", [currentUserId]);

    const [assets] = await pool.query(
      `SELECT 
         a.id, 
         a.symbol, 
         a.name, 
         a.last_d1_close, 
         a.prev_d1_close, 
         a.change_24h_pct, 
         a.last_updated,
         uw.sort_order,
         uw.is_pinned,
         uw.holding_qty,
         uw.avg_cost
       FROM user_watchlist uw
       JOIN assets a ON uw.asset_id = a.id
       WHERE uw.user_id = ?
       ORDER BY uw.is_pinned DESC, uw.sort_order ASC, a.symbol ASC`,
      [currentUserId]
    );

    // Compute Portfolio Metrics (Holdings, Total Value, Cost Basis, Unrealised P/L)
    let totalPortfolioValue = 0;
    let totalCostBasis = 0;
    let hasPortfolioHoldings = false;

    const enrichedAssets = assets.map((asset) => {
      const currentPrice = parseFloat(asset.last_d1_close) || 0;
      const holdingQty = asset.holding_qty !== null && asset.holding_qty !== undefined ? parseFloat(asset.holding_qty) : null;
      const avgCost = asset.avg_cost !== null && asset.avg_cost !== undefined ? parseFloat(asset.avg_cost) : null;

      let positionValue = null;
      let costBasis = null;
      let unrealisedPl = null;
      let unrealisedPlPct = null;

      if (holdingQty !== null && !isNaN(holdingQty) && holdingQty > 0) {
        hasPortfolioHoldings = true;
        positionValue = holdingQty * currentPrice;
        totalPortfolioValue += positionValue;

        if (avgCost !== null && !isNaN(avgCost) && avgCost > 0) {
          costBasis = holdingQty * avgCost;
          totalCostBasis += costBasis;
          unrealisedPl = positionValue - costBasis;
          unrealisedPlPct = ((positionValue - costBasis) / costBasis) * 100;
        }
      }

      return {
        ...asset,
        is_pinned: Boolean(asset.is_pinned),
        sort_order: parseInt(asset.sort_order, 10) || 0,
        holding_qty: holdingQty,
        avg_cost: avgCost,
        position_value: positionValue,
        cost_basis: costBasis,
        unrealised_pl: unrealisedPl,
        unrealised_pl_pct: unrealisedPlPct,
      };
    });

    const portfolioSummary = hasPortfolioHoldings
      ? {
          totalValue: totalPortfolioValue,
          totalCost: totalCostBasis,
          totalPl: totalPortfolioValue - totalCostBasis,
          totalPlPct: totalCostBasis > 0 ? ((totalPortfolioValue - totalCostBasis) / totalCostBasis) * 100 : 0,
          hasHoldings: true,
        }
      : {
          totalValue: 0,
          totalCost: 0,
          totalPl: 0,
          totalPlPct: 0,
          hasHoldings: false,
        };

    const [exchanges] = await pool.query("SELECT id, ccxt_id, display_name FROM exchanges WHERE is_active = TRUE ORDER BY priority_order ASC");

    // 3. Build dynamic SQL query for alerts
    // Admin user can filter by any user or view "All" (unfiltered); Trader is strictly scoped to own userId
    let filterUserId = currentUserId;
    if (isAdmin) {
      if (req.query.user_id !== undefined && req.query.user_id !== "") {
        const parsedUid = parseInt(req.query.user_id, 10);
        filterUserId = !isNaN(parsedUid) && parsedUid > 0 ? parsedUid : null;
      } else if (req.query.user_id === "") {
        filterUserId = null; // Filter by User (All) explicitly chosen
      }
    }

    let querySql = `
      SELECT 
        pa.id,
        pa.user_id,
        u.username,
        pa.asset_id,
        a.symbol AS asset_symbol,
        a.name AS asset_name,
        a.last_d1_close,
        a.change_24h_pct,
        pa.exchange_id,
        e.display_name AS exchange_name,
        pa.target_price,
        pa.reference_baseline,
        pa.peak_price,
        pa.condition_type,
        pa.condition_metric,
        pa.is_triggered,
        pa.notification_channel,
        pa.recipient_target,
        pa.triggered_at,
        pa.created_at
      FROM price_alerts pa
      JOIN users u ON pa.user_id = u.id
      JOIN assets a ON pa.asset_id = a.id
      JOIN exchanges e ON pa.exchange_id = e.id
      WHERE 1=1
    `;
    const queryParams = [];

    if (filterUserId !== null) {
      querySql += " AND pa.user_id = ?";
      queryParams.push(filterUserId);
    }

    // Filter Criterion: alert trigger status
    if (selectedStatus === "active") {
      querySql += " AND pa.is_triggered = FALSE";
    } else if (selectedStatus === "triggered") {
      querySql += " AND pa.is_triggered = TRUE";
    }

    querySql += " ORDER BY pa.created_at DESC";

    const [alerts] = await pool.query(querySql, queryParams);

    // Fetch recent alert audit trail events for timeline (Phase 8+ 3.2 - Solves C1 / C9 visibility)
    let recentEvents = [];
    try {
      let eventSql = `
        SELECT 
           ae.id,
           ae.alert_id,
           ae.event_type,
           ae.price_at_event,
           ae.metric_value,
           ae.message,
           ae.created_at,
           a.symbol AS asset_symbol,
           pa.condition_type
         FROM alert_events ae
         JOIN price_alerts pa ON ae.alert_id = pa.id
         JOIN assets a ON pa.asset_id = a.id
         WHERE 1=1
      `;
      const eventParams = [];
      if (filterUserId !== null) {
        eventSql += " AND pa.user_id = ?";
        eventParams.push(filterUserId);
      }
      eventSql += " ORDER BY ae.created_at DESC LIMIT 20";

      const [eventRows] = await pool.query(eventSql, eventParams);
      recentEvents = eventRows || [];
    } catch {
      // Non-blocking fallback if table pending migration
    }

    // Decrypt and mask recipient targets for UI display
    const maskedAlerts = (alerts || []).map((alt) => ({
      ...alt,
      recipient_target: cryptoService.maskTarget(alt.recipient_target),
    }));

    // Render index view
    res.render("index", {
      pageTitle: "Crypto Daily Alerts (CICO / D1)",
      currentUser: req.user,
      users,
      assets: enrichedAssets,
      portfolioSummary,
      exchanges,
      alerts: maskedAlerts,
      recentEvents,
      editAlert,
      selectedUserId: filterUserId !== null ? filterUserId : "",
      selectedStatus,
      chartSupportedTimeframes: chartConfig.getSupportedTimeframes(),
      chartDefaultDays: chartConfig.getDefaultTimeframeDays(),
      swalMessage: req.query.msg || null,
      assetAdded: req.query.asset_added || null,
      assetDeleted: req.query.asset_deleted || null,
    });
  } catch (err) {
    console.error("Error loading dashboard:", err);
    next(err);
  }
});

/**
 * Route: POST /alerts
 * @description Validates input and creates a new price alert record wrapped inside an atomic transaction,
 * scoped strictly to authenticated req.user.id.
 * @route POST /alerts
 */
router.post("/alerts", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const assetId = parseInt(req.body.asset_id, 10);
    const exchangeId = parseInt(req.body.exchange_id, 10);
    const targetPrice = parseFloat(req.body.target_price);
    const conditionType = (req.body.condition_type || "").trim().toUpperCase();
    const notificationChannel = (req.body.notification_channel || "IN_APP").trim().toUpperCase();
    const recipientTarget = (req.body.recipient_target || "").trim();

    // Input validation
    if (isNaN(userId) || userId <= 0) return res.status(400).send("Invalid User ID");
    if (isNaN(assetId) || assetId <= 0) return res.status(400).send("Invalid Asset ID");
    if (isNaN(exchangeId) || exchangeId <= 0) return res.status(400).send("Invalid Exchange ID");
    if (isNaN(targetPrice) || targetPrice <= 0) return res.status(400).send("Target price must be greater than 0");

    const validConditions = [
      "ABOVE",
      "BELOW",
      "PCT_CHANGE_24H_ABOVE",
      "PCT_CHANGE_24H_BELOW",
      "TRAILING_STOP",
      "RSI_ABOVE",
      "RSI_BELOW",
      "SMA_GOLDEN_CROSS",
      "SMA_DEATH_CROSS",
      "VOLUME_SPIKE",
    ];
    if (!validConditions.includes(conditionType)) {
      return res.status(400).send("Invalid condition type");
    }

    // Determine condition metric (PRICE, PCT_CHANGE_24H, TRAILING_STOP, RSI_14, SMA_CROSS, VOLUME_SPIKE)
    let conditionMetric = "PRICE";
    if (conditionType.startsWith("PCT_CHANGE_24H")) {
      conditionMetric = "PCT_CHANGE_24H";
    } else if (conditionType === "TRAILING_STOP") {
      conditionMetric = "TRAILING_STOP";
    } else if (conditionType.startsWith("RSI_")) {
      conditionMetric = "RSI_14";
    } else if (conditionType.startsWith("SMA_")) {
      conditionMetric = "SMA_CROSS";
    } else if (conditionType === "VOLUME_SPIKE") {
      conditionMetric = "VOLUME_SPIKE";
    }

    // Query asset to get baseline current price
    const [assetRows] = await pool.query("SELECT last_d1_close FROM assets WHERE id = ?", [assetId]);
    const baselinePrice = assetRows.length > 0 ? parseFloat(assetRows[0].last_d1_close) : null;
    const initialPeakPrice = conditionMetric === "TRAILING_STOP" ? baselinePrice : null;

    const validChannels = ["IN_APP", "EMAIL", "TELEGRAM", "DISCORD"];
    const channelToSave = validChannels.includes(notificationChannel) ? notificationChannel : "IN_APP";

    // Encrypt sensitive notification target at rest (Phase 8+ 3.3)
    const encryptedTarget = recipientTarget ? cryptoService.encrypt(recipientTarget) : null;

    // Insert alert into database using transaction
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const insertSql = `
        INSERT INTO price_alerts (user_id, asset_id, exchange_id, target_price, reference_baseline, peak_price, condition_type, condition_metric, is_triggered, notification_channel, recipient_target)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)
      `;
      const [insertResult] = await connection.query(insertSql, [
        userId,
        assetId,
        exchangeId,
        targetPrice,
        baselinePrice,
        initialPeakPrice,
        conditionType,
        conditionMetric,
        channelToSave,
        encryptedTarget,
      ]);
      const newAlertId = insertResult.insertId;

      // Audit Trail Logging: Record CREATED event (Phase 8+ 3.2)
      await connection.query(
        "INSERT INTO alert_events (alert_id, event_type, price_at_event, metric_value, message) VALUES (?, 'CREATED', ?, ?, ?)",
        [
          newAlertId,
          baselinePrice || null,
          targetPrice,
          `Alert created (${conditionType} target $${targetPrice})`,
        ]
      ).catch((e) => console.warn("Notice: CREATED event log skipped:", e.message));

      await connection.commit();

      if (req.xhr || req.headers.accept?.includes("application/json") || req.is("application/json")) {
        return res.status(201).json({
          success: true,
          message: "Alert created successfully.",
          alertId: newAlertId,
          alert: {
            id: newAlertId,
            user_id: userId,
            asset_id: assetId,
            exchange_id: exchangeId,
            target_price: targetPrice,
            condition_type: conditionType,
            condition_metric: conditionMetric,
            notification_channel: channelToSave,
            is_triggered: false,
          },
        });
      }
    } catch (txErr) {
      await connection.rollback();
      throw txErr;
    } finally {
      connection.release();
    }

    res.redirect("/?msg=saved");
  } catch (err) {
    console.error("Error creating alert:", err);
    next(err);
  }
});

/**
 * Route: POST /alerts/:id/update
 * @description Updates an existing price alert's parameters, scoped strictly to req.user.id (IDOR protection).
 * @route POST /alerts/:id/update
 */
router.post("/alerts/:id/update", requireAuth, async (req, res, next) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    if (isNaN(alertId) || alertId <= 0) {
      return res.status(400).send("Invalid Alert ID");
    }

    const userId = req.user.id;
    const assetId = parseInt(req.body.asset_id, 10);
    const exchangeId = parseInt(req.body.exchange_id, 10);
    const targetPrice = parseFloat(req.body.target_price);
    const conditionType = (req.body.condition_type || "").trim().toUpperCase();
    const notificationChannel = (req.body.notification_channel || "IN_APP").trim().toUpperCase();
    const recipientTarget = (req.body.recipient_target || "").trim();

    // Input validation
    if (isNaN(userId) || userId <= 0) return res.status(400).send("Invalid User ID");
    if (isNaN(assetId) || assetId <= 0) return res.status(400).send("Invalid Asset ID");
    if (isNaN(exchangeId) || exchangeId <= 0) return res.status(400).send("Invalid Exchange ID");
    if (isNaN(targetPrice) || targetPrice <= 0) return res.status(400).send("Target price must be greater than 0");

    const validConditions = [
      "ABOVE",
      "BELOW",
      "PCT_CHANGE_24H_ABOVE",
      "PCT_CHANGE_24H_BELOW",
      "TRAILING_STOP",
      "RSI_ABOVE",
      "RSI_BELOW",
      "SMA_GOLDEN_CROSS",
      "SMA_DEATH_CROSS",
      "VOLUME_SPIKE",
    ];
    if (!validConditions.includes(conditionType)) {
      return res.status(400).send("Invalid condition type");
    }

    let conditionMetric = "PRICE";
    if (conditionType.startsWith("PCT_CHANGE_24H")) {
      conditionMetric = "PCT_CHANGE_24H";
    } else if (conditionType === "TRAILING_STOP") {
      conditionMetric = "TRAILING_STOP";
    } else if (conditionType.startsWith("RSI_")) {
      conditionMetric = "RSI_14";
    } else if (conditionType.startsWith("SMA_")) {
      conditionMetric = "SMA_CROSS";
    } else if (conditionType === "VOLUME_SPIKE") {
      conditionMetric = "VOLUME_SPIKE";
    }

    // Query asset baseline price if updating
    const [assetRows] = await pool.query("SELECT last_d1_close FROM assets WHERE id = ?", [assetId]);
    const baselinePrice = assetRows.length > 0 ? parseFloat(assetRows[0].last_d1_close) : null;
    const initialPeakPrice = conditionMetric === "TRAILING_STOP" ? baselinePrice : null;

    const validChannels = ["IN_APP", "EMAIL", "TELEGRAM", "DISCORD"];
    const channelToSave = validChannels.includes(notificationChannel) ? notificationChannel : "IN_APP";

    // Encrypt updated recipient target at rest
    const encryptedTarget = recipientTarget ? cryptoService.encrypt(recipientTarget) : null;

    const updateSql = `
      UPDATE price_alerts
      SET asset_id = ?, exchange_id = ?, target_price = ?, reference_baseline = ?, peak_price = ?, condition_type = ?,
          condition_metric = ?, notification_channel = ?, recipient_target = ?, is_triggered = FALSE, triggered_at = NULL
      WHERE id = ? AND user_id = ?
    `;
    const [result] = await pool.query(updateSql, [
      assetId,
      exchangeId,
      targetPrice,
      baselinePrice,
      initialPeakPrice,
      conditionType,
      conditionMetric,
      channelToSave,
      encryptedTarget,
      alertId,
      userId,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).send("Alert not found or unauthorized");
    }

    // Audit Trail Logging: Record RE-ARMED event on alert modification (Phase 8+ 3.2)
    await pool.query(
      "INSERT INTO alert_events (alert_id, event_type, price_at_event, metric_value, message) VALUES (?, 'RE-ARMED', ?, ?, ?)",
      [
        alertId,
        baselinePrice || null,
        targetPrice,
        `Alert updated and re-armed (${conditionType} target $${targetPrice})`,
      ]
    ).catch((e) => console.warn("Notice: RE-ARMED event log skipped:", e.message));

    if (req.xhr || req.headers.accept?.includes("application/json") || req.is("application/json")) {
      return res.status(200).json({
        success: true,
        message: "Alert updated and re-armed successfully.",
        alertId,
      });
    }

    res.redirect("/?msg=updated");
  } catch (err) {
    console.error("Error updating alert:", err);
    next(err);
  }
});

/**
 * Route: POST /alerts/:id/delete
 * @description Deletes an existing price alert record by ID, scoped strictly to req.user.id (IDOR protection).
 * @route POST /alerts/:id/delete
 */
router.post("/alerts/:id/delete", requireAuth, async (req, res, next) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    if (isNaN(alertId) || alertId <= 0) {
      return res.status(400).send("Invalid Alert ID");
    }

    const userId = req.user.id;
    const deleteSql = "DELETE FROM price_alerts WHERE id = ? AND user_id = ?";
    const [result] = await pool.query(deleteSql, [alertId, userId]);

    if (result.affectedRows === 0) {
      if (req.xhr || req.headers.accept?.includes("application/json") || req.is("application/json")) {
        return res.status(404).json({ error: "Alert not found or unauthorized" });
      }
      return res.status(404).send("Alert not found or unauthorized");
    }

    if (req.xhr || req.headers.accept?.includes("application/json") || req.is("application/json")) {
      return res.status(200).json({
        success: true,
        message: "Alert deleted successfully.",
        alertId,
      });
    }

    res.redirect("/");
  } catch (err) {
    console.error("Error deleting alert:", err);
    next(err);
  }
});

/**
 * Route: GET /api/alerts/:id/events
 * @description Retrieves full audit event timeline for a specific alert, scoped to authenticated user.
 * @route GET /api/alerts/:id/events
 */
router.get("/api/alerts/:id/events", requireAuth, async (req, res, next) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    if (isNaN(alertId) || alertId <= 0) {
      return res.status(400).json({ error: "Invalid Alert ID" });
    }

    // Verify alert ownership (IDOR check)
    const [alertRows] = await pool.query(
      "SELECT id, asset_id, condition_type, target_price FROM price_alerts WHERE id = ? AND user_id = ?",
      [alertId, req.user.id]
    );
    if (alertRows.length === 0) {
      return res.status(404).json({ error: "Alert not found or unauthorized" });
    }

    const [events] = await pool.query(
      "SELECT id, alert_id, event_type, price_at_event, metric_value, message, created_at FROM alert_events WHERE alert_id = ? ORDER BY created_at DESC",
      [alertId]
    );

    res.json({
      success: true,
      alert: alertRows[0],
      count: events.length,
      events,
    });
  } catch (err) {
    next(err);
  }
});

// ========================================================
// NOTIFICATION RELIABILITY & PREFERENCES (Phase 8+ 3.3)
// ========================================================

/**
 * Route: GET /api/notifications/preferences
 * @description Retrieves the authenticated user's notification preferences, default channel, quiet hours,
 * and masked/decrypted target handles.
 * @route GET /api/notifications/preferences
 */
router.get("/api/notifications/preferences", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      "SELECT * FROM user_notification_preferences WHERE user_id = ?",
      [userId]
    );

    let pref = rows[0];
    if (!pref) {
      // Return defaults if not initialized
      pref = {
        user_id: userId,
        default_channel: "IN_APP",
        telegram_target: "",
        discord_target: "",
        email_target: req.user.email || "",
        quiet_hours_enabled: false,
        quiet_hours_start: "22:00:00",
        quiet_hours_end: "07:00:00",
        timezone: "Asia/Singapore",
      };
    }

    res.json({
      success: true,
      preferences: {
        userId: pref.user_id,
        defaultChannel: pref.default_channel,
        telegramTarget: cryptoService.decrypt(pref.telegram_target) || "",
        telegramMasked: cryptoService.maskTarget(pref.telegram_target),
        discordTarget: cryptoService.decrypt(pref.discord_target) || "",
        discordMasked: cryptoService.maskTarget(pref.discord_target),
        emailTarget: pref.email_target || req.user.email || "",
        emailMasked: cryptoService.maskTarget(pref.email_target || req.user.email),
        quietHoursEnabled: Boolean(pref.quiet_hours_enabled),
        quietHoursStart: (pref.quiet_hours_start || "22:00:00").slice(0, 5),
        quietHoursEnd: (pref.quiet_hours_end || "07:00:00").slice(0, 5),
        timezone: pref.timezone || "Asia/Singapore",
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /api/notifications/preferences
 * @description Updates the authenticated user's notification preferences with target encryption at rest.
 * @route POST /api/notifications/preferences
 */
router.post("/api/notifications/preferences", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      default_channel = "IN_APP",
      telegram_target = "",
      discord_target = "",
      email_target = "",
      quiet_hours_enabled = false,
      quiet_hours_start = "22:00",
      quiet_hours_end = "07:00",
      timezone = "Asia/Singapore",
    } = req.body;

    const validChannels = ["IN_APP", "EMAIL", "TELEGRAM", "DISCORD"];
    const channelToSave = validChannels.includes(String(default_channel).toUpperCase())
      ? String(default_channel).toUpperCase()
      : "IN_APP";

    // Encrypt sensitive targets at rest
    const encTelegram = telegram_target ? cryptoService.encrypt(telegram_target.trim()) : null;
    const encDiscord = discord_target ? cryptoService.encrypt(discord_target.trim()) : null;
    const cleanEmail = email_target ? email_target.trim().toLowerCase() : null;

    const cleanStart = quiet_hours_start.length === 5 ? `${quiet_hours_start}:00` : quiet_hours_start;
    const cleanEnd = quiet_hours_end.length === 5 ? `${quiet_hours_end}:00` : quiet_hours_end;

    const upsertSql = `
      INSERT INTO user_notification_preferences
        (user_id, default_channel, telegram_target, discord_target, email_target, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        default_channel = VALUES(default_channel),
        telegram_target = VALUES(telegram_target),
        discord_target = VALUES(discord_target),
        email_target = VALUES(email_target),
        quiet_hours_enabled = VALUES(quiet_hours_enabled),
        quiet_hours_start = VALUES(quiet_hours_start),
        quiet_hours_end = VALUES(quiet_hours_end),
        timezone = VALUES(timezone),
        updated_at = NOW()
    `;

    await pool.query(upsertSql, [
      userId,
      channelToSave,
      encTelegram,
      encDiscord,
      cleanEmail,
      Boolean(quiet_hours_enabled),
      cleanStart,
      cleanEnd,
      timezone,
    ]);

    res.json({
      success: true,
      message: "Notification preferences updated successfully.",
      preferences: {
        defaultChannel: channelToSave,
        telegramMasked: cryptoService.maskTarget(encTelegram),
        discordMasked: cryptoService.maskTarget(encDiscord),
        emailMasked: cryptoService.maskTarget(cleanEmail),
        quietHoursEnabled: Boolean(quiet_hours_enabled),
        quietHoursStart: cleanStart.slice(0, 5),
        quietHoursEnd: cleanEnd.slice(0, 5),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /api/notifications/test
 * @description "Send Test Notification" endpoint allowing traders to verify their Telegram, Discord,
 * or Email configuration immediately on-demand.
 * @route POST /api/notifications/test
 */
router.post("/api/notifications/test", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { channel, target: customTarget } = req.body;
    const selectedChannel = (channel || "IN_APP").toUpperCase();

    // Fetch user preferences for default target fallback
    const [prefRows] = await pool.query(
      "SELECT * FROM user_notification_preferences WHERE user_id = ?",
      [userId]
    );
    const pref = prefRows[0] || {};

    let target = customTarget;
    if (!target) {
      if (selectedChannel === "TELEGRAM") target = cryptoService.decrypt(pref.telegram_target);
      else if (selectedChannel === "DISCORD") target = cryptoService.decrypt(pref.discord_target);
      else if (selectedChannel === "EMAIL") target = pref.email_target || req.user.email;
      else target = "Dashboard";
    }

    if (!target && selectedChannel !== "IN_APP") {
      return res.status(400).json({
        error: `Please provide a target ${selectedChannel} destination or configure it in preferences.`,
      });
    }

    const testAlert = {
      id: 9999,
      user_id: userId,
      username: req.user.username,
      asset_symbol: "BTC/USDT",
      asset_name: "Bitcoin",
      exchange_name: "System Diagnostic",
      condition_type: "TEST_NOTIFICATION",
      target_price: 99999.0,
      last_d1_close: 95400.0,
      change_24h_pct: 4.85,
      notification_channel: selectedChannel,
      recipient_target: target,
    };

    const result = await notificationService.dispatchAlertNotification(testAlert);

    if (result.success) {
      res.json({
        success: true,
        message: `Test notification sent successfully via ${selectedChannel} to ${cryptoService.maskTarget(target)}.`,
        channel: selectedChannel,
        target: cryptoService.maskTarget(target),
        simulated: Boolean(result.simulated),
      });
    } else {
      res.status(502).json({
        error: `Test notification failed to dispatch via ${selectedChannel}: ${result.error || "Delivery error"}`,
        channel: selectedChannel,
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /api/notifications/logs
 * @description Retrieves notification delivery audit log history with retry status for the authenticated trader.
 * @route GET /api/notifications/logs
 */
router.get("/api/notifications/logs", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const [logs] = await pool.query(
      `SELECT nl.id, nl.alert_id, nl.channel, nl.recipient_target, nl.status, nl.attempt_count, 
              nl.max_attempts, nl.next_retry_at, nl.last_error, nl.message_payload, nl.sent_at, nl.created_at
       FROM notification_log nl
       WHERE nl.user_id = ?
       ORDER BY nl.created_at DESC
       LIMIT 30`,
      [userId]
    );

    const maskedLogs = (logs || []).map((l) => ({
      ...l,
      recipient_target: cryptoService.maskTarget(l.recipient_target),
    }));

    res.json({ success: true, count: maskedLogs.length, logs: maskedLogs });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /refresh
 * @description Triggers a batch price refresh across all active assets via CCXT/fallback
 * and automatically evaluates price alert trigger states. Supports AJAX/JSON for progress popups.
 * Restricted to administrators (ADMIN role only).
 * @route POST /refresh
 */
router.post("/refresh", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await priceService.refreshAllPrices();

    // If client requested JSON (AJAX progress popup)
    if (req.xhr || req.headers.accept?.includes("application/json") || req.is("application/json") || req.query.format === "json") {
      return res.status(200).json({
        success: true,
        message: "Market data and multi-timeframe candles refreshed successfully.",
        result,
      });
    }

    res.redirect("/");
  } catch (err) {
    console.error("Error refreshing prices:", err);
    if (req.xhr || req.headers.accept?.includes("application/json") || req.is("application/json") || req.query.format === "json") {
      return res.status(500).json({
        success: false,
        error: "Failed to refresh market data: " + err.message,
      });
    }
    next(err);
  }
});

/**
 * Route: POST /reset-db
 * @description Truncates/clears all records across all tables and re-seeds baseline data in an atomic transaction.
 * Security Hardening:
 * - Requires authentication (`requireAuth`)
 * - Requires admin privileges (`requireAdmin`)
 * - Disabled in production environments (`NODE_ENV === 'production'`)
 * @route POST /reset-db
 */
router.post("/reset-db", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") {
      if (req.xhr || req.headers.accept?.includes("application/json") || req.path.startsWith("/api/")) {
        return res.status(403).json({
          error: "Forbidden",
          message: "Database reset is strictly prohibited in production.",
        });
      }
      return res.status(403).send("Database reset is strictly prohibited in production.");
    }

    await seedModule.seedDatabase();
    res.redirect("/");
  } catch (err) {
    console.error("Error resetting database:", err);
    next(err);
  }
});

/**
 * Sanitizes a string for CSV export to prevent Formula / CSV Injection.
 * Escapes quotes and prepends a single quote if the value begins with =, +, -, @, or tab/return.
 *
 * @param {any} val
 * @returns {string}
 */
function sanitizeCsvCell(val) {
  if (val === null || val === undefined) return "";
  let str = String(val);
  // Neutralize CSV formula injection characters
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  // Double quote any existing quotes and wrap in quotes if containing comma or newline
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Route: GET /api/alerts.csv
 * @description Exports the authenticated user's price alerts as a sanitized RFC 4180 CSV file.
 * Requires 'read:alerts' scope for API tokens.
 * @route GET /api/alerts.csv
 */
router.get("/api/alerts.csv", requireAuth, requireScope("read:alerts"), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const statusFilter = req.query.status || "all";

    let sql = `
      SELECT pa.id, a.symbol AS asset_symbol, a.name AS asset_name, ex.display_name AS exchange_name,
             pa.condition_type, pa.condition_metric, pa.target_price, pa.reference_baseline, pa.peak_price,
             pa.is_triggered, pa.triggered_at, pa.notification_channel, pa.recipient_target, pa.created_at
      FROM price_alerts pa
      JOIN assets a ON pa.asset_id = a.id
      JOIN exchanges ex ON pa.exchange_id = ex.id
      WHERE pa.user_id = ?
    `;
    const params = [userId];

    if (statusFilter === "active") {
      sql += " AND pa.is_triggered = FALSE";
    } else if (statusFilter === "triggered") {
      sql += " AND pa.is_triggered = TRUE";
    }
    sql += " ORDER BY pa.created_at DESC";

    const [alerts] = await pool.query(sql, params);

    const filename = `crypto_alerts_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const headers = [
      "ID",
      "Asset Symbol",
      "Asset Name",
      "Exchange",
      "Condition Type",
      "Condition Metric",
      "Target Price",
      "Baseline Price",
      "Peak Price",
      "Is Triggered",
      "Triggered At",
      "Channel",
      "Created At",
    ];

    let csvOutput = headers.map(sanitizeCsvCell).join(",") + "\r\n";

    for (const alt of alerts) {
      const row = [
        alt.id,
        alt.asset_symbol,
        alt.asset_name,
        alt.exchange_name,
        alt.condition_type,
        alt.condition_metric || "PRICE",
        alt.target_price,
        alt.reference_baseline || "",
        alt.peak_price || "",
        alt.is_triggered ? "YES" : "NO",
        alt.triggered_at || "",
        alt.notification_channel || "IN_APP",
        alt.created_at || "",
      ];
      csvOutput += row.map(sanitizeCsvCell).join(",") + "\r\n";
    }

    return res.status(200).send(csvOutput);
  } catch (err) {
    console.error("Error exporting alerts.csv:", err);
    next(err);
  }
});

/**
 * Route: GET /api/alerts.json
 * @description Exports price alerts in JSON format.
 * Requires 'read:alerts' scope for API tokens.
 * @route GET /api/alerts.json
 */
router.get("/api/alerts.json", requireAuth, requireScope("read:alerts"), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const statusFilter = req.query.status || "all";

    let sql = `
      SELECT pa.id, a.symbol AS asset_symbol, a.name AS asset_name, ex.display_name AS exchange_name,
             pa.condition_type, pa.condition_metric, pa.target_price, pa.reference_baseline, pa.peak_price,
             pa.is_triggered, pa.triggered_at, pa.notification_channel, pa.recipient_target, pa.created_at
      FROM price_alerts pa
      JOIN assets a ON pa.asset_id = a.id
      JOIN exchanges ex ON pa.exchange_id = ex.id
      WHERE pa.user_id = ?
    `;
    const params = [userId];

    if (statusFilter === "active") {
      sql += " AND pa.is_triggered = FALSE";
    } else if (statusFilter === "triggered") {
      sql += " AND pa.is_triggered = TRUE";
    }
    sql += " ORDER BY pa.created_at DESC";

    const [alerts] = await pool.query(sql, params);

    return res.status(200).json({
      success: true,
      count: alerts.length,
      exportedAt: new Date().toISOString(),
      user: { id: req.user.id, username: req.user.username },
      alerts,
    });
  } catch (err) {
    console.error("Error exporting alerts.json:", err);
    next(err);
  }
});

/**
 * Route: GET /api/tokens
 * @description Lists active Personal Access Tokens for the authenticated user.
 * @route GET /api/tokens
 */
router.get("/api/tokens", requireAuth, async (req, res, next) => {
  try {
    const tokens = await tokenService.listTokens(req.user.id);
    return res.status(200).json({
      success: true,
      tokens,
    });
  } catch (err) {
    console.error("Error listing tokens:", err);
    next(err);
  }
});

/**
 * Route: POST /api/tokens
 * @description Generates a new Personal Access Token for the authenticated user.
 * @route POST /api/tokens
 */
router.post("/api/tokens", requireAuth, async (req, res, next) => {
  try {
    const { name, scopes, expiresInDays } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Token name is required" });
    }

    const created = await tokenService.createToken(req.user.id, name, scopes, expiresInDays);
    return res.status(201).json({
      success: true,
      message: "Personal Access Token created successfully. Store this secret token securely as it will not be shown again!",
      token: created,
    });
  } catch (err) {
    console.error("Error creating token:", err);
    next(err);
  }
});

/**
 * Route: DELETE /api/tokens/:id
 * @description Revokes a Personal Access Token owned by the authenticated user.
 * @route DELETE /api/tokens/:id
 */
router.delete("/api/tokens/:id", requireAuth, async (req, res, next) => {
  try {
    const tokenId = parseInt(req.params.id, 10);
    if (isNaN(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: "Invalid Token ID" });
    }

    const revoked = await tokenService.revokeToken(req.user.id, tokenId);
    if (!revoked) {
      return res.status(404).json({ error: "Token not found or already revoked" });
    }

    return res.status(200).json({
      success: true,
      message: "Token revoked successfully",
    });
  } catch (err) {
    console.error("Error revoking token:", err);
    next(err);
  }
});

/**
 * Route: GET /api/openapi.json
 * @description Returns OpenAPI 3.0 specification definition.
 * @route GET /api/openapi.json
 */
router.get("/api/openapi.json", (req, res) => {
  const specPath = path.join(__dirname, "..", "docs", "openapi.json");
  res.sendFile(specPath);
});

/**
 * Route: GET /api/docs
 * @description Renders interactive Swagger UI documentation.
 * @route GET /api/docs
 */
router.get("/api/docs", (req, res) => {
  res.render("swagger");
});

/**
 * Route: GET /api/stream
 * @description Server-Sent Events (SSE) live streaming endpoint.
 * Pushes real-time price updates, alert trigger events, and KPI metrics directly to active dashboards.
 * @route GET /api/stream
 */
router.get("/api/stream", requireAuth, (req, res) => {
  const userId = req.user ? req.user.id : null;
  sseService.addClient(userId, req, res);
});

/**
 * Route: GET /api/assets/:id/chart-data
 * @description Fetches persisted OHLCV daily candlestick data and active price alert annotations
 * for an asset and exchange, formatted for ApexCharts 8.8.1. Requires authentication.
 * @route GET /api/assets/:id/chart-data
 */
router.get("/api/assets/:id/chart-data", requireAuth, async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.id, 10);
    if (isNaN(assetId) || assetId <= 0) {
      return res.status(400).json({ error: "Invalid Asset ID" });
    }

    const exchangeId = req.query.exchange_id ? parseInt(req.query.exchange_id, 10) : 1;
    const timeframe = chartConfig.normalizeTimeframe(req.query.timeframe || "1d");
    const defaultDays = chartConfig.getDefaultTimeframeDays();
    let days = req.query.days ? parseInt(req.query.days, 10) : defaultDays;
    if (isNaN(days) || !chartConfig.isTimeframeSupported(days)) {
      days = defaultDays;
    }
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;

    // 1. Fetch asset details
    const [assetRows] = await pool.query(
      "SELECT id, symbol, name, last_d1_close, last_updated FROM assets WHERE id = ?",
      [assetId]
    );
    if (assetRows.length === 0) {
      return res.status(404).json({ error: "Asset not found" });
    }
    const asset = assetRows[0];

    // 2. Fetch exchange details
    let exchange = { id: exchangeId, display_name: "OKX Singapore", ccxt_id: "okx" };
    try {
      const [exRows] = await pool.query(
        "SELECT id, ccxt_id, display_name FROM exchanges WHERE id = ?",
        [exchangeId]
      );
      if (exRows.length > 0) {
        exchange = exRows[0];
      }
    } catch {
      // Fallback to default
    }

    // 3. Query persisted OHLCV candles filtered by timeframe
    let series = [];
    try {
      // Limit candles based on timeframe: intraday gets more points; 1w gets weekly count
      const candleLimit = timeframe === "1h"
        ? Math.min(days * 24, 500)
        : (timeframe === "4h"
          ? Math.min(days * 6, 500)
          : (timeframe === "1w" ? Math.min(Math.ceil(days / 7), 200) : days));
      const [candleRows] = await pool.query(
        `SELECT candle_time, open_price, high_price, low_price, close_price
         FROM asset_ohlcv
         WHERE asset_id = ? AND exchange_id = ? AND timeframe = ?
         ORDER BY candle_time DESC
         LIMIT ?`,
        [assetId, exchangeId, timeframe, candleLimit]
      );

      if (candleRows && candleRows.length > 0) {
        // Reverse so chronological order (oldest to newest)
        series = candleRows.reverse().map((c) => {
          let timeLabel;
          if (typeof c.candle_time === "string") {
            timeLabel = timeframe === "1h" || timeframe === "4h" ? c.candle_time.slice(0, 16).replace("T", " ") : c.candle_time.slice(0, 10);
          } else {
            const iso = new Date(c.candle_time).toISOString();
            timeLabel = timeframe === "1h" || timeframe === "4h" ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
          }
          return {
            x: timeLabel,
            y: [parseFloat(c.open_price), parseFloat(c.high_price), parseFloat(c.low_price), parseFloat(c.close_price)],
          };
        });
      }
    } catch {
      // If table missing or column pending migration, fallback to simulated candles
    }

    // Fallback: If no persisted candles, generate fallback candles anchored to last_d1_close for the timeframe
    if (series.length === 0) {
      const basePrice = parseFloat(asset.last_d1_close) || 100.0;
      series = priceService.generateFallbackCandles(basePrice, days, timeframe);
    }

    // 4. Fetch active price alerts for this asset and exchange for overlay annotations
    let alertSql = `
      SELECT pa.id, pa.target_price, pa.condition_type, pa.condition_metric, pa.reference_baseline, pa.peak_price, u.username
      FROM price_alerts pa
      JOIN users u ON pa.user_id = u.id
      WHERE pa.asset_id = ? AND pa.exchange_id = ? AND pa.is_triggered = FALSE
    `;
    const alertParams = [assetId, exchangeId];
    if (userId && !isNaN(userId)) {
      alertSql += " AND pa.user_id = ?";
      alertParams.push(userId);
    }

    let annotations = [];
    try {
      const [alertRows] = await pool.query(alertSql, alertParams);
      const currentAssetPrice = parseFloat(asset.last_d1_close) || 0;

      annotations = alertRows.map((a) => {
        const rawTarget = parseFloat(a.target_price);
        let effectivePrice = rawTarget;
        let labelText = `${a.condition_type} $${Number(rawTarget).toLocaleString()}`;

        if (a.condition_type === "TRAILING_STOP") {
          const peak = parseFloat(a.peak_price) || currentAssetPrice || rawTarget;
          effectivePrice = peak * (1 - rawTarget / 100);
          labelText = `TRAILING_STOP -${rawTarget}% ($${Number(effectivePrice.toFixed(2)).toLocaleString()})`;
        } else if (a.condition_type === "PCT_CHANGE_24H_ABOVE") {
          const baseline = parseFloat(a.reference_baseline) || currentAssetPrice;
          effectivePrice = baseline * (1 + rawTarget / 100);
          labelText = `24H +${rawTarget}% ($${Number(effectivePrice.toFixed(2)).toLocaleString()})`;
        } else if (a.condition_type === "PCT_CHANGE_24H_BELOW") {
          const baseline = parseFloat(a.reference_baseline) || currentAssetPrice;
          effectivePrice = baseline * (1 - rawTarget / 100);
          labelText = `24H -${rawTarget}% ($${Number(effectivePrice.toFixed(2)).toLocaleString()})`;
        }

        return {
          id: a.id,
          target_price: effectivePrice,
          raw_target: rawTarget,
          condition_type: a.condition_type,
          label: `${labelText} (${a.username})`,
        };
      });
    } catch {
      // No annotations if query fails
    }

    // 5. Query historical trigger events for candlestick chart markers (Phase 8+ 3.2 - Solves C1 / C9 visibility)
    let triggerEvents = [];
    try {
      const [eventRows] = await pool.query(
        `SELECT ae.id, ae.alert_id, ae.event_type, ae.price_at_event, ae.metric_value, ae.message, ae.created_at, pa.condition_type
         FROM alert_events ae
         JOIN price_alerts pa ON ae.alert_id = pa.id
         WHERE pa.asset_id = ? AND pa.exchange_id = ? AND ae.event_type = 'TRIGGERED'
         ORDER BY ae.created_at ASC`,
        [assetId, exchangeId]
      );
      triggerEvents = (eventRows || []).map((e) => ({
        id: e.id,
        alertId: e.alert_id,
        eventType: e.event_type,
        conditionType: e.condition_type,
        price: parseFloat(e.price_at_event),
        metricValue: parseFloat(e.metric_value),
        timestamp: new Date(e.created_at).getTime(),
        dateStr: new Date(e.created_at).toISOString().slice(0, 10),
        message: e.message,
      }));
    } catch {
      // Non-blocking fallback
    }

    res.json({
      asset,
      exchange,
      series,
      annotations,
      triggerEvents,
      timeframe: {
        currentDays: days,
        defaultDays,
        supported: chartConfig.getSupportedTimeframes(),
      },
    });
  } catch (err) {
    console.error("Error loading chart data:", err);
    next(err);
  }
});

/**
 * Route: GET /health (and alias GET /status)
 * @description System health monitor reporting database connectivity, active exchange ping latencies,
 * background cron scheduler status, last sync timestamp, and total active vs. triggered alert metrics.
 * @route GET /health
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 */
async function handleHealthCheck(req, res) {
  const startTime = Date.now();
  const healthReport = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      status: "unknown",
      latencyMs: null,
    },
    exchanges: [],
    alerts: {
      total: 0,
      active: 0,
      triggered: 0,
    },
    scheduler: schedulerService.getSchedulerStatus(),
    responseTimeMs: 0,
  };

  // 1. Probe Database Connection & Latency
  try {
    const dbStart = Date.now();
    await pool.query("SELECT 1 AS ping");
    healthReport.database.status = "connected";
    healthReport.database.latencyMs = Date.now() - dbStart;
  } catch (dbErr) {
    healthReport.status = "degraded";
    healthReport.database.status = "disconnected";
    healthReport.database.error = dbErr.message;
  }

  // 2. Query Alert Metrics & Last Asset Update Timestamp (Scoped per user if authenticated)
  try {
    const currentUserId = req.user?.id || null;
    let alertQuery = `
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN is_triggered = FALSE THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN is_triggered = TRUE THEN 1 ELSE 0 END) AS triggered
      FROM price_alerts
    `;
    const queryParams = [];

    if (currentUserId) {
      alertQuery += " WHERE user_id = ?";
      queryParams.push(currentUserId);
      healthReport.alerts.scope = "user";
      healthReport.alerts.userId = currentUserId;
    } else {
      healthReport.alerts.scope = "global";
    }

    const [alertStats] = await pool.query(alertQuery, queryParams);
    if (alertStats && alertStats.length > 0) {
      healthReport.alerts.total = parseInt(alertStats[0].total, 10) || 0;
      healthReport.alerts.active = parseInt(alertStats[0].active, 10) || 0;
      healthReport.alerts.triggered = parseInt(alertStats[0].triggered, 10) || 0;
    }

    const [latestAsset] = await pool.query(`
      SELECT MAX(last_updated) AS last_sync FROM assets
    `);
    healthReport.lastMarketDataSync = latestAsset[0]?.last_sync || healthReport.scheduler.lastSyncTime || null;
  } catch {
    // If table query fails, fallback
  }

  // 3. Probe Active Exchanges
  try {
    const [exchanges] = await pool.query(
      "SELECT id, ccxt_id, display_name FROM exchanges WHERE is_active = TRUE ORDER BY priority_order ASC"
    );
    for (const ex of exchanges) {
      healthReport.exchanges.push({
        id: ex.id,
        ccxtId: ex.ccxt_id,
        name: ex.display_name,
        type: ex.ccxt_id === "local_mock" ? "offline_fallback" : "live_market",
      });
    }
  } catch {
    // Leave exchanges array empty
  }

  healthReport.responseTimeMs = Date.now() - startTime;
  const httpStatus = healthReport.database.status === "connected" ? 200 : 503;
  return res.status(httpStatus).json(healthReport);
}

router.get("/health", optionalAuth, handleHealthCheck);
router.get("/status", optionalAuth, handleHealthCheck);

/**
 * Route: GET /api/admin/health/detail
 * @description Provides in-depth system diagnostic metrics including host telemetry, memory footprint,
 * active database connection statistics, table row counts, and background scheduler inspection.
 * Requires ADMIN role.
 * @route GET /api/admin/health/detail
 */
router.get("/api/admin/health/detail", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const startTime = Date.now();
    const [dbVersion] = await pool.query("SELECT VERSION() AS version, @@port AS port, DATABASE() AS current_db");
    const [tableCounts] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) AS users_count,
        (SELECT COUNT(*) FROM exchanges) AS exchanges_count,
        (SELECT COUNT(*) FROM assets) AS assets_count,
        (SELECT COUNT(*) FROM price_alerts) AS alerts_count,
        (SELECT COUNT(*) FROM asset_ohlcv) AS ohlcv_count,
        (SELECT COUNT(*) FROM user_watchlist) AS watchlist_count
    `);

    const memoryUsage = process.memoryUsage();
    const systemDetail = {
      status: "ok",
      timestamp: new Date().toISOString(),
      adminUser: req.user.username,
      host: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        pid: process.pid,
      },
      memory: {
        rssMb: Number((memoryUsage.rss / 1024 / 1024).toFixed(2)),
        heapTotalMb: Number((memoryUsage.heapTotal / 1024 / 1024).toFixed(2)),
        heapUsedMb: Number((memoryUsage.heapUsed / 1024 / 1024).toFixed(2)),
        externalMb: Number((memoryUsage.external / 1024 / 1024).toFixed(2)),
      },
      database: {
        serverVersion: dbVersion[0]?.version || "unknown",
        port: dbVersion[0]?.port || 3306,
        currentDatabase: dbVersion[0]?.current_db || "crypto_alerts_db",
        tableRowCounts: tableCounts[0] || {},
      },
      scheduler: schedulerService.getSchedulerStatus(),
      responseTimeMs: Date.now() - startTime,
    };

    res.json(systemDetail);
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /assets
 * @description Retrieves all assets on the authenticated user's watchlist,
 * including current D1 prices and the user's associated alert count.
 * Requires authentication.
 * @route GET /assets
 */
router.get("/assets", requireAuth, async (req, res, next) => {
  try {
    const currentUserId = req.user.id;
    const [assets] = await pool.query(
      `
      SELECT 
        a.id,
        a.symbol,
        a.name,
        a.last_d1_close,
        a.last_updated,
        uw.sort_order,
        uw.is_pinned,
        uw.holding_qty,
        uw.avg_cost,
        COUNT(pa.id) AS alert_count
      FROM user_watchlist uw
      JOIN assets a ON uw.asset_id = a.id
      LEFT JOIN price_alerts pa ON a.id = pa.asset_id AND pa.user_id = ?
      WHERE uw.user_id = ?
      GROUP BY a.id, uw.sort_order, uw.is_pinned, uw.holding_qty, uw.avg_cost
      ORDER BY uw.is_pinned DESC, uw.sort_order ASC, a.symbol ASC
    `,
      [currentUserId, currentUserId]
    );

    // Support JSON response if requested via AJAX/Accept header
    if (req.xhr || req.headers.accept?.includes("application/json") || req.query.format === "json") {
      return res.json({ success: true, count: assets.length, assets });
    }

    // Default: redirect back to dashboard with watchlist modal parameter or render
    res.redirect("/?view_watchlist=1");
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /assets
 * @description Adds a cryptocurrency pair to the authenticated user's watchlist.
 * If the asset is new to the system, registers it in master `assets` table with baseline OHLCV candles.
 * Then links the asset into `user_watchlist(user_id, asset_id)` for the authenticated user.
 * Requires authentication.
 * @route POST /assets
 */
router.post("/assets", requireAuth, async (req, res, next) => {
  let connection;
  try {
    const currentUserId = req.user.id;
    const { symbol, name } = req.body;
    if (!symbol || !name || typeof symbol !== "string" || typeof name !== "string") {
      return res.status(400).send("Asset symbol and name are required.");
    }

    const normalizedSymbol = symbol.trim().toUpperCase();
    const cleanName = name.trim();

    // Validate symbol pattern and length
    if (!/^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/.test(normalizedSymbol)) {
      return res.status(400).send("Invalid pair format. Must be BASE/QUOTE (e.g. BTC/USDT).");
    }

    // Validate name length and safe characters
    if (cleanName.length > 50 || /[<>"'&]/.test(cleanName)) {
      return res.status(400).send("Asset name must be 50 characters or less and cannot contain special HTML characters.");
    }

    // 1. Validate pair format and exchange viability (uses cached markets - C6)
    const validation = await priceService.validateAssetSymbol(normalizedSymbol);
    if (!validation.valid) {
      return res.status(400).send(`Invalid trading pair: ${validation.reason || "Symbol not recognized on exchanges"}`);
    }

    // 2. Pre-check if asset exists and prefetch candles OUTSIDE of transaction (C4 fix)
    // Resolve starting price (fallback map or default 1.0)
    const fallbackPrices = priceService.loadFallbackPrices();
    let initialPrice = fallbackPrices[normalizedSymbol] || 1.0;

    const [existing] = await pool.query("SELECT id, last_d1_close FROM assets WHERE symbol = ?", [normalizedSymbol]);
    let assetId = existing.length > 0 ? existing[0].id : null;
    let prefetchedCandles = null;

    if (!assetId) {
      // New asset: Prefetch 180-day candles from CCXT *before* opening the DB transaction!
      const [exchanges] = await pool.query("SELECT id, ccxt_id FROM exchanges WHERE is_active = TRUE");
      prefetchedCandles = await priceService.prefetchInitialCandles(normalizedSymbol, initialPrice, exchanges);
    } else {
      initialPrice = existing[0].last_d1_close || initialPrice;
    }

    // 3. Open short, atomic transaction purely for DB writes (no network I/O!)
    connection = await pool.getConnection();
    await connection.beginTransaction();

    if (!assetId) {
      const [insertResult] = await connection.query(
        "INSERT INTO assets (symbol, name, last_d1_close, last_updated) VALUES (?, ?, ?, NOW())",
        [normalizedSymbol, cleanName, initialPrice]
      );
      assetId = insertResult.insertId;

      // Fast database-only insertion using prefetched candles
      await priceService.seedInitialAssetOHLCV(assetId, normalizedSymbol, initialPrice, connection, prefetchedCandles);
    }

    // 4. Check if pair is already on the current user's watchlist
    const [watchlistRow] = await connection.query(
      "SELECT id FROM user_watchlist WHERE user_id = ? AND asset_id = ?",
      [currentUserId, assetId]
    );
    if (watchlistRow.length > 0) {
      await connection.rollback();
      return res.status(409).send(`Asset with symbol ${normalizedSymbol} is already on your watchlist.`);
    }

    // 5. Link asset to user_watchlist
    await connection.query(
      "INSERT INTO user_watchlist (user_id, asset_id) VALUES (?, ?)",
      [currentUserId, assetId]
    );

    await connection.commit();

    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(201).json({
        success: true,
        message: `Asset ${normalizedSymbol} added to your watchlist.`,
        asset: { id: assetId, symbol: normalizedSymbol, name: cleanName, last_d1_close: initialPrice },
      });
    }

    res.redirect("/?asset_added=" + encodeURIComponent(normalizedSymbol));
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * Route: POST /assets/:id/delete
 * @description Removes an asset from the authenticated user's watchlist (user_watchlist).
 * Also cleans up only the authenticated user's price alerts on this asset.
 * Master asset record and other users' alerts/watchlists are preserved intact (S3 hardening).
 * Requires authentication.
 * @route POST /assets/:id/delete
 */
router.post("/assets/:id/delete", requireAuth, async (req, res, next) => {
  let connection;
  try {
    const currentUserId = req.user.id;
    const assetId = parseInt(req.params.id, 10);
    if (isNaN(assetId) || assetId <= 0) {
      return res.status(400).send("Invalid Asset ID.");
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [assetRows] = await connection.query("SELECT symbol FROM assets WHERE id = ?", [assetId]);
    if (assetRows.length === 0) {
      await connection.rollback();
      return res.status(404).send("Asset not found.");
    }
    const assetSymbol = assetRows[0].symbol;

    // Check if asset is on the user's watchlist
    const [watchlistRows] = await connection.query(
      "SELECT id FROM user_watchlist WHERE user_id = ? AND asset_id = ?",
      [currentUserId, assetId]
    );
    if (watchlistRows.length === 0) {
      await connection.rollback();
      return res.status(404).send("Asset not found on your watchlist.");
    }

    // Remove from user_watchlist
    await connection.query(
      "DELETE FROM user_watchlist WHERE user_id = ? AND asset_id = ?",
      [currentUserId, assetId]
    );

    // Delete ONLY the authenticated user's price alerts on this asset
    await connection.query(
      "DELETE FROM price_alerts WHERE user_id = ? AND asset_id = ?",
      [currentUserId, assetId]
    );

    await connection.commit();

    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.json({
        success: true,
        message: `Asset ${assetSymbol} removed from your watchlist.`,
      });
    }

    res.redirect("/?asset_deleted=" + encodeURIComponent(assetSymbol));
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * Route: POST /api/watchlist/reorder
 * @description Updates custom sort order and pinning for assets in authenticated user's watchlist.
 * @route POST /api/watchlist/reorder
 */
router.post("/api/watchlist/reorder", requireAuth, async (req, res, next) => {
  try {
    const currentUserId = req.user.id;
    const { items } = req.body; // Array of { assetId: number, sortOrder: number, isPinned: boolean }

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "Invalid items format. Array required." });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const item of items) {
        const assetId = parseInt(item.assetId, 10);
        const sortOrder = parseInt(item.sortOrder, 10) || 0;
        const isPinned = Boolean(item.isPinned);

        if (!isNaN(assetId)) {
          await connection.query(
            "UPDATE user_watchlist SET sort_order = ?, is_pinned = ? WHERE user_id = ? AND asset_id = ?",
            [sortOrder, isPinned, currentUserId, assetId]
          );
        }
      }
      await connection.commit();
      res.json({ success: true, message: "Watchlist order updated successfully." });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /api/watchlist/:id/portfolio
 * @description Updates holdings (holding_qty, avg_cost) for a specific asset on the user's watchlist.
 * @route POST /api/watchlist/:id/portfolio
 */
router.post("/api/watchlist/:id/portfolio", requireAuth, async (req, res, next) => {
  try {
    const currentUserId = req.user.id;
    const assetId = parseInt(req.params.id, 10);
    if (isNaN(assetId) || assetId <= 0) {
      return res.status(400).json({ error: "Invalid Asset ID." });
    }

    const { holding_qty, avg_cost } = req.body;

    const parsedQty = holding_qty === "" || holding_qty === null || holding_qty === undefined 
      ? null 
      : parseFloat(holding_qty);
    const parsedCost = avg_cost === "" || avg_cost === null || avg_cost === undefined 
      ? null 
      : parseFloat(avg_cost);

    if (parsedQty !== null && (isNaN(parsedQty) || parsedQty < 0)) {
      return res.status(400).json({ error: "Holding quantity must be 0 or positive." });
    }
    if (parsedCost !== null && (isNaN(parsedCost) || parsedCost < 0)) {
      return res.status(400).json({ error: "Average cost must be 0 or positive." });
    }

    const [updateResult] = await pool.query(
      "UPDATE user_watchlist SET holding_qty = ?, avg_cost = ? WHERE user_id = ? AND asset_id = ?",
      [parsedQty, parsedCost, currentUserId, assetId]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: "Asset not found on your watchlist." });
    }

    res.json({
      success: true,
      message: "Portfolio holdings updated successfully.",
      holdings: { assetId, holdingQty: parsedQty, avgCost: parsedCost },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /api/markets/catalog
 * @description Provides the searchable Screener / Pair Lookup Catalog,
 * indicating which pairs are present on the current user's active watchlist.
 * @route GET /api/markets/catalog
 */
router.get("/api/markets/catalog", optionalAuth, async (req, res, next) => {
  try {
    const rawCatalog = priceService.getCatalogPairs();
    const searchQuery = (req.query.q || "").trim().toLowerCase();
    const currentUserId = req.user?.id || null;

    // Query active assets on current user's watchlist (or all active if unauthenticated)
    let activeSymbols = new Set();
    if (currentUserId) {
      const [watchlistAssets] = await pool.query(
        `SELECT a.symbol 
         FROM user_watchlist uw 
         JOIN assets a ON uw.asset_id = a.id 
         WHERE uw.user_id = ?`,
        [currentUserId]
      );
      activeSymbols = new Set(watchlistAssets.map((a) => a.symbol.toUpperCase()));
    } else {
      const [existingAssets] = await pool.query("SELECT symbol FROM assets");
      activeSymbols = new Set(existingAssets.map((a) => a.symbol.toUpperCase()));
    }

    let catalog = rawCatalog.map((item) => {
      const isWatchlist = activeSymbols.has(item.symbol.toUpperCase());
      return {
        ...item,
        is_on_watchlist: isWatchlist,
      };
    });

    if (searchQuery) {
      catalog = catalog.filter((item) => {
        return (
          item.symbol.toLowerCase().includes(searchQuery) ||
          item.name.toLowerCase().includes(searchQuery) ||
          item.base.toLowerCase().includes(searchQuery) ||
          item.category.toLowerCase().includes(searchQuery)
        );
      });
    }

    res.json({
      success: true,
      count: catalog.length,
      catalog,
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// ADMIN-ONLY RBAC MANAGEMENT ENDPOINTS (Phase 8+ 3.1)
// ==========================================

/**
 * Route: GET /api/admin/exchanges
 * @description Retrieves all configured exchanges with operational status. Requires ADMIN role.
 * @route GET /api/admin/exchanges
 */
router.get("/api/admin/exchanges", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const [exchanges] = await pool.query(
      "SELECT id, ccxt_id, display_name, is_active, priority_order FROM exchanges ORDER BY priority_order ASC, id ASC"
    );
    res.json({ success: true, count: exchanges.length, exchanges });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: POST /api/admin/exchanges
 * @description Registers or activates a new exchange in the system. Requires ADMIN role.
 * @route POST /api/admin/exchanges
 */
router.post("/api/admin/exchanges", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const { ccxt_id, display_name, is_active = true, priority_order = 10 } = req.body;
    if (!ccxt_id || !display_name) {
      return res.status(400).json({ error: "ccxt_id and display_name are required." });
    }

    const cleanCcxtId = String(ccxt_id).trim().toLowerCase();
    const cleanDisplayName = String(display_name).trim();

    const [existing] = await pool.query("SELECT id FROM exchanges WHERE ccxt_id = ?", [cleanCcxtId]);
    if (existing.length > 0) {
      return res.status(409).json({ error: `Exchange '${cleanCcxtId}' is already registered.` });
    }

    const [insertResult] = await pool.query(
      "INSERT INTO exchanges (ccxt_id, display_name, is_active, priority_order) VALUES (?, ?, ?, ?)",
      [cleanCcxtId, cleanDisplayName, Boolean(is_active), parseInt(priority_order, 10) || 10]
    );

    res.status(201).json({
      success: true,
      message: `Exchange '${cleanDisplayName}' registered successfully.`,
      exchange: {
        id: insertResult.insertId,
        ccxt_id: cleanCcxtId,
        display_name: cleanDisplayName,
        is_active: Boolean(is_active),
        priority_order: parseInt(priority_order, 10) || 10,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: PUT /api/admin/exchanges/:id
 * @description Updates an exchange's display name, active state, or priority order. Requires ADMIN role.
 * @route PUT /api/admin/exchanges/:id
 */
router.put("/api/admin/exchanges/:id", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const exchangeId = parseInt(req.params.id, 10);
    if (isNaN(exchangeId) || exchangeId <= 0) {
      return res.status(400).json({ error: "Invalid Exchange ID." });
    }

    const { display_name, is_active, priority_order } = req.body;
    const [existing] = await pool.query("SELECT id, ccxt_id, display_name, is_active, priority_order FROM exchanges WHERE id = ?", [exchangeId]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "Exchange not found." });
    }

    const current = existing[0];
    const newName = display_name !== undefined ? String(display_name).trim() : current.display_name;
    const newActive = is_active !== undefined ? Boolean(is_active) : current.is_active;
    const newPriority = priority_order !== undefined ? parseInt(priority_order, 10) : current.priority_order;

    await pool.query(
      "UPDATE exchanges SET display_name = ?, is_active = ?, priority_order = ? WHERE id = ?",
      [newName, newActive, newPriority, exchangeId]
    );

    res.json({
      success: true,
      message: "Exchange updated successfully.",
      exchange: { id: exchangeId, ccxt_id: current.ccxt_id, display_name: newName, is_active: newActive, priority_order: newPriority },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /api/admin/assets
 * @description Retrieves the master asset registry with global watch counts and alert metrics. Requires ADMIN role.
 * @route GET /api/admin/assets
 */
router.get("/api/admin/assets", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const [assets] = await pool.query(`
      SELECT 
        a.id,
        a.symbol,
        a.name,
        a.last_d1_close,
        a.prev_d1_close,
        a.change_24h_pct,
        a.last_updated,
        COUNT(DISTINCT uw.user_id) AS total_watchers,
        COUNT(DISTINCT pa.id) AS total_alerts
      FROM assets a
      LEFT JOIN user_watchlist uw ON a.id = uw.asset_id
      LEFT JOIN price_alerts pa ON a.id = pa.asset_id
      GROUP BY a.id
      ORDER BY a.symbol ASC
    `);

    res.json({ success: true, count: assets.length, assets });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: DELETE /api/admin/assets/:id
 * @description Master asset deletion: Deletes an asset entirely from the system (cascading to OHLCV, watchlists, alerts).
 * Only administrators can modify or remove the shared master asset table. Requires ADMIN role.
 * @route DELETE /api/admin/assets/:id
 */
router.delete("/api/admin/assets/:id", requireAuth, requireRole("ADMIN"), async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.id, 10);
    if (isNaN(assetId) || assetId <= 0) {
      return res.status(400).json({ error: "Invalid Asset ID." });
    }

    const [existing] = await pool.query("SELECT id, symbol FROM assets WHERE id = ?", [assetId]);
    if (existing.length === 0) {
      return res.status(404).json({ error: "Asset not found in master catalog." });
    }

    const symbol = existing[0].symbol;
    await pool.query("DELETE FROM assets WHERE id = ?", [assetId]);

    res.json({
      success: true,
      message: `Asset ${symbol} (ID: ${assetId}) permanently removed from master asset registry.`,
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// Coin Deep Analysis & 200W SMA Report Routes
// ==========================================

/**
 * Route: POST /api/assets/:id/analysis
 * @description Triggers a full deep analysis for the asset, computing technicals, sentiment,
 * 200W SMA macro buy signals, composite scoring, and persists to asset_analysis_reports.
 * Supports Bearer PAT or Session JWT.
 */
router.get("/api/assets/:id/analysis", requireAuth, requireScope("read:alerts"), async (req, res, next) => {
  // Alias GET to perform or return latest
  try {
    const assetId = parseInt(req.params.id, 10);
    if (isNaN(assetId) || assetId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid Asset ID." });
    }
    const report = await analysisService.performCoinAnalysis({
      assetId,
      exchangeId: req.query.exchange_id ? parseInt(req.query.exchange_id, 10) : 1,
      userId: req.user.id
    });
    res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

router.post("/api/assets/:id/analysis", requireAuth, requireScope("read:alerts"), async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.id, 10);
    if (isNaN(assetId) || assetId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid Asset ID." });
    }
    const exchangeId = req.body && req.body.exchange_id ? parseInt(req.body.exchange_id, 10) : 1;
    const report = await analysisService.performCoinAnalysis({
      assetId,
      exchangeId: isNaN(exchangeId) || exchangeId <= 0 ? 1 : exchangeId,
      userId: req.user.id
    });
    res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /api/assets/:id/analysis/latest
 * @description Retrieves the latest generated report for an asset.
 */
router.get("/api/assets/:id/analysis/latest", requireAuth, requireScope("read:alerts"), async (req, res, next) => {
  try {
    const assetId = parseInt(req.params.id, 10);
    if (isNaN(assetId) || assetId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid Asset ID." });
    }

    let report = await analysisService.getLatestReport(assetId);
    if (!report) {
      // If no cached report exists yet, generate one on-demand
      report = await analysisService.performCoinAnalysis({
        assetId,
        exchangeId: 1,
        userId: req.user.id
      });
    }

    res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /api/reports/:id.json
 * @description Exports structured JSON for a specific analysis report by report ID.
 */
router.get("/api/reports/:id.json", requireAuth, requireScope("read:alerts"), async (req, res, next) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (isNaN(reportId) || reportId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid Report ID." });
    }

    const [rows] = await pool.query(
      `SELECT r.*, a.symbol, a.name, a.last_d1_close
       FROM asset_analysis_reports r
       JOIN assets a ON r.asset_id = a.id
       WHERE r.id = ?`,
      [reportId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, error: "Analysis report not found." });
    }

    const r = rows[0];
    let metrics = {};
    try {
      metrics = JSON.parse(r.metrics_json);
    } catch {
      metrics = {};
    }

    res.json({
      success: true,
      report: {
        id: r.id,
        assetId: r.asset_id,
        symbol: r.symbol,
        name: r.name,
        currentPrice: Number(r.last_d1_close),
        overallScore: r.overall_score,
        overallSignal: r.overall_signal,
        technicalScore: r.technical_score,
        sentimentScore: r.sentiment_score,
        riskLevel: r.risk_level,
        supportPrice: r.support_price !== null ? Number(r.support_price) : null,
        resistancePrice: r.resistance_price !== null ? Number(r.resistance_price) : null,
        summaryText: r.summary_text,
        metrics,
        buyOption: metrics.buyOption || null,
        createdAt: r.created_at
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Route: GET /reports/:id/print
 * @description Printable clean HTML view styled for browser print / Save as PDF.
 */
router.get("/reports/:id/print", optionalAuth, async (req, res, next) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (isNaN(reportId) || reportId <= 0) {
      return res.status(400).send("Invalid Report ID.");
    }

    const [rows] = await pool.query(
      `SELECT r.*, a.symbol, a.name, a.last_d1_close, u.username
       FROM asset_analysis_reports r
       JOIN assets a ON r.asset_id = a.id
       JOIN users u ON r.user_id = u.id
       WHERE r.id = ?`,
      [reportId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).send("Analysis report not found.");
    }

    const report = rows[0];
    let metrics = {};
    try {
      metrics = JSON.parse(report.metrics_json);
    } catch {
      metrics = {};
    }

    res.render("report_print", {
      report: {
        id: report.id,
        assetId: report.asset_id,
        symbol: report.symbol,
        name: report.name,
        currentPrice: Number(report.last_d1_close),
        overallScore: report.overall_score,
        overallSignal: report.overall_signal,
        technicalScore: report.technical_score,
        sentimentScore: report.sentiment_score,
        riskLevel: report.risk_level,
        supportPrice: report.support_price !== null ? Number(report.support_price) : null,
        resistancePrice: report.resistance_price !== null ? Number(report.resistance_price) : null,
        summaryText: report.summary_text,
        metrics,
        buyOption: metrics.buyOption || null,
        createdAt: report.created_at,
        generatedBy: report.username
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
