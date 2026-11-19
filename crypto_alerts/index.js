/**
 * @file Crypto Daily Alerts Application Entry Point
 * @description Configures Express application, middleware (static files, URL-encoded forms),
 * EJS view engine, routes, 404 guard, and global error handling.
 * @module index
 */

const express = require("express");
const path = require("path");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const alertRoutes = require("./routes/alertRoutes");

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Middleware for parsing form inputs and static assets
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Configure View Engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Mount Alerts Routes
app.use("/", alertRoutes);

// 404 Catch-All Middleware for unmapped routes
app.use((req, res) => {
  res.status(404).send("Page Not Found");
});

// Global Error Handling Middleware (prevents server crashes/hangs)
app.use((err, req, res, next) => {
  console.error("Internal Server Error:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).send("Internal Server Error");
});

// Start server if executed directly
if (require.main === module) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Crypto Alerts server listening at http://0.0.0.0:${port}`);
  });
}

module.exports = app;
