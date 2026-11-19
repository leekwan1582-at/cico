/**
 * @file Database Connection Pool Configuration
 * @description Initializes and exports a MySQL2/Promise connection pool for the Crypto Daily Alerts service.
 * Configured with environment variables and connection pool safeguards.
 * @module config/db
 */

const mysql = require("mysql2/promise");
const dotenv = require("dotenv");
const path = require("path");

// Load .env relative to project root
dotenv.config({ path: path.join(__dirname, "..", ".env") });

/**
 * MySQL2 connection pool instance.
 * @type {import('mysql2/promise').Pool}
 */
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "crypto_alerts_db",
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
});

module.exports = pool;
