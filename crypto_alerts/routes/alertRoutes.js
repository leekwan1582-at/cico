/**
 * @file Alert and Market Dashboard Routes
 * @description Express routing module managing CRUD operations for price alerts,
 * filtering criteria (user, status), pre-population for edits, price refreshes, and database resets.
 * @module routes/alertRoutes
 */

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const priceService = require("../services/priceService");
const seedModule = require("../seed");

/**
 * Route: GET /
 * @description Loads the main Split-View dashboard with optional multi-criteria filters:
 * - `user_id`: Filter alerts by user ID.
 * - `status`: Filter by status ('active' -> is_triggered=0, 'triggered' -> is_triggered=1, 'all' -> all).
 * - `edit_id`: Pre-populates the left-column form with existing alert details for modification.
 * @route GET /
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
router.get("/", async (req, res, next) => {
  try {
    const selectedUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : "";
    const selectedStatus = req.query.status || "all";

    // 2. Validate and fetch single record for edit if edit_id parameter is present in query
    let editAlert = null;
    if (req.query.edit_id !== undefined) {
      const editId = parseInt(req.query.edit_id, 10);
      if (isNaN(editId) || editId <= 0) {
        return res.status(400).send("Invalid Alert ID");
      }
      const [editRows] = await pool.query("SELECT * FROM price_alerts WHERE id = ?", [editId]);
      if (editRows.length === 0) {
        return res.status(404).send("Alert not found");
      }
      editAlert = editRows[0];
    }

    // 1. Fetch dropdown options & reference data
    const [users] = await pool.query("SELECT id, username, email FROM users ORDER BY id ASC");
    const [assets] = await pool.query("SELECT id, symbol, name, last_d1_close, last_updated FROM assets ORDER BY id ASC");
    const [exchanges] = await pool.query("SELECT id, ccxt_id, display_name FROM exchanges WHERE is_active = TRUE ORDER BY priority_order ASC");

    // 3. Build dynamic SQL query for alerts with 2+ criteria & table joins
    // SELECT #2: Demonstrates multi-table JOINs across price_alerts, assets, exchanges, and users
    let querySql = `
      SELECT 
        pa.id,
        pa.user_id,
        u.username,
        pa.asset_id,
        a.symbol AS asset_symbol,
        a.name AS asset_name,
        a.last_d1_close,
        pa.exchange_id,
        e.display_name AS exchange_name,
        pa.target_price,
        pa.condition_type,
        pa.is_triggered,
        pa.created_at
      FROM price_alerts pa
      JOIN users u ON pa.user_id = u.id
      JOIN assets a ON pa.asset_id = a.id
      JOIN exchanges e ON pa.exchange_id = e.id
      WHERE 1=1
    `;
    const queryParams = [];

    // Filter Criterion 1: user_id
    if (selectedUserId && !isNaN(selectedUserId)) {
      querySql += " AND pa.user_id = ?";
      queryParams.push(selectedUserId);
    }

    // Filter Criterion 2: alert trigger status
    if (selectedStatus === "active") {
      querySql += " AND pa.is_triggered = FALSE";
    } else if (selectedStatus === "triggered") {
      querySql += " AND pa.is_triggered = TRUE";
    }

    querySql += " ORDER BY pa.created_at DESC";

    const [alerts] = await pool.query(querySql, queryParams);

    // Render index view
    res.render("index", {
      pageTitle: "Crypto Daily Alerts (CICO / D1)",
      users,
      assets,
      exchanges,
      alerts,
      editAlert,
      selectedUserId,
      selectedStatus,
    });
  } catch (err) {
    console.error("Error loading dashboard:", err);
    next(err);
  }
});

/**
 * Route: POST /alerts
 * @description Validates input and creates a new price alert record wrapped inside an atomic transaction.
 * @route POST /alerts
 * @param {import('express').Request} req - Express request with body containing user_id, asset_id, exchange_id, target_price, condition_type.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
router.post("/alerts", async (req, res, next) => {
  try {
    const userId = parseInt(req.body.user_id, 10);
    const assetId = parseInt(req.body.asset_id, 10);
    const exchangeId = parseInt(req.body.exchange_id, 10);
    const targetPrice = parseFloat(req.body.target_price);
    const conditionType = (req.body.condition_type || "").trim().toUpperCase();

    // Input validation
    if (isNaN(userId) || userId <= 0) return res.status(400).send("Invalid User ID");
    if (isNaN(assetId) || assetId <= 0) return res.status(400).send("Invalid Asset ID");
    if (isNaN(exchangeId) || exchangeId <= 0) return res.status(400).send("Invalid Exchange ID");
    if (isNaN(targetPrice) || targetPrice <= 0) return res.status(400).send("Target price must be greater than 0");
    if (conditionType !== "ABOVE" && conditionType !== "BELOW") {
      return res.status(400).send("Condition must be ABOVE or BELOW");
    }

    // Insert alert into database using transaction
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const insertSql = `
        INSERT INTO price_alerts (user_id, asset_id, exchange_id, target_price, condition_type, is_triggered)
        VALUES (?, ?, ?, ?, ?, FALSE)
      `;
      await connection.query(insertSql, [userId, assetId, exchangeId, targetPrice, conditionType]);
      await connection.commit();
    } catch (txErr) {
      await connection.rollback();
      throw txErr;
    } finally {
      connection.release();
    }

    res.redirect("/");
  } catch (err) {
    console.error("Error creating alert:", err);
    next(err);
  }
});

/**
 * Route: POST /alerts/:id/update
 * @description Updates an existing price alert's parameters and resets its triggered status to FALSE.
 * @route POST /alerts/:id/update
 * @param {import('express').Request} req - Express request containing alert ID in params and updated fields in body.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
router.post("/alerts/:id/update", async (req, res, next) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    if (isNaN(alertId) || alertId <= 0) {
      return res.status(400).send("Invalid Alert ID");
    }

    const userId = parseInt(req.body.user_id, 10);
    const assetId = parseInt(req.body.asset_id, 10);
    const exchangeId = parseInt(req.body.exchange_id, 10);
    const targetPrice = parseFloat(req.body.target_price);
    const conditionType = (req.body.condition_type || "").trim().toUpperCase();

    // Input validation
    if (isNaN(userId) || userId <= 0) return res.status(400).send("Invalid User ID");
    if (isNaN(assetId) || assetId <= 0) return res.status(400).send("Invalid Asset ID");
    if (isNaN(exchangeId) || exchangeId <= 0) return res.status(400).send("Invalid Exchange ID");
    if (isNaN(targetPrice) || targetPrice <= 0) return res.status(400).send("Target price must be greater than 0");
    if (conditionType !== "ABOVE" && conditionType !== "BELOW") {
      return res.status(400).send("Condition must be ABOVE or BELOW");
    }

    const updateSql = `
      UPDATE price_alerts
      SET user_id = ?, asset_id = ?, exchange_id = ?, target_price = ?, condition_type = ?, is_triggered = FALSE
      WHERE id = ?
    `;
    const [result] = await pool.query(updateSql, [
      userId,
      assetId,
      exchangeId,
      targetPrice,
      conditionType,
      alertId,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).send("Alert not found");
    }

    res.redirect("/");
  } catch (err) {
    console.error("Error updating alert:", err);
    next(err);
  }
});

/**
 * Route: POST /alerts/:id/delete
 * @description Deletes an existing price alert record by ID.
 * @route POST /alerts/:id/delete
 * @param {import('express').Request} req - Express request containing alert ID in params.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
router.post("/alerts/:id/delete", async (req, res, next) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    if (isNaN(alertId) || alertId <= 0) {
      return res.status(400).send("Invalid Alert ID");
    }

    const [result] = await pool.query("DELETE FROM price_alerts WHERE id = ?", [alertId]);
    if (result.affectedRows === 0) {
      return res.status(404).send("Alert not found");
    }

    res.redirect("/");
  } catch (err) {
    console.error("Error deleting alert:", err);
    next(err);
  }
});

/**
 * Route: POST /refresh
 * @description Triggers a batch price refresh across all active assets via CCXT/fallback
 * and automatically evaluates price alert trigger states.
 * @route POST /refresh
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
router.post("/refresh", async (req, res, next) => {
  try {
    await priceService.refreshAllPrices();
    res.redirect("/");
  } catch (err) {
    console.error("Error refreshing prices:", err);
    next(err);
  }
});

/**
 * Route: POST /reset-db
 * @description Truncates/clears all records across all tables and re-seeds baseline data in an atomic transaction.
 * @route POST /reset-db
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
router.post("/reset-db", async (req, res, next) => {
  try {
    await seedModule.seedDatabase();
    res.redirect("/");
  } catch (err) {
    console.error("Error resetting database:", err);
    next(err);
  }
});

module.exports = router;
