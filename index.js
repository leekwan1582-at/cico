/**
 * @file CICO Food Entry Tracking Application
 * @description Main application server for CICO (Calories In, Calories Out).
 * Manages full CRUD operations for food entries with meal categories, serving units, and multi-tag associations.
 * @module index
 */

const express = require("express");
const mysql2 = require("mysql2/promise");
const ejs = require("ejs");
const dotenv = require("dotenv");

dotenv.config();

const expressLayouts = require("express-ejs-layouts");

const app = express();
const port = 3000;

app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", "./views");
app.set("layout", "layout");
app.locals.pageTitle = "Food Entries";
app.use(expressLayouts);

// MariaDB connection configuration
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  dateStrings: true,
  port: process.env.DB_PORT,
};

/**
 * MariaDB/MySQL connection pool for CICO.
 * @type {import('mysql2/promise').Pool}
 */
const dbConnection = mysql2.createPool(dbConfig);

/**
 * Route: GET /
 * @description Lists food entries matching optional search keyword, with associated meals and aggregated tags.
 * @route GET /
 * @param {import('express').Request} req - Express request object with optional query parameter `search`.
 * @param {import('express').Response} res - Express response object rendering index view.
 * @param {import('express').NextFunction} next - Express next middleware.
 */
app.get("/", async function (req, res, next) {
  try {
    const searchTerm = (req.query.search || "").trim();
    // Escape SQL LIKE wildcard characters (% and _)
    const escapedSearchTerm = searchTerm.replace(/[%_]/g, "\\$&");
    const sql = `SELECT food_entries.id, dateTime, foodName, calories,
      servingSize, unit, meals.name as 'meal',
      group_concat(tags.name) as 'selected_tags' FROM food_entries
      LEFT JOIN meals ON food_entries.meal_id = meals.id
      LEFT JOIN food_entries_tags ON food_entries_tags.food_entry_id = food_entries.id
      LEFT JOIN tags ON food_entries_tags.tag_id = tags.id
      WHERE food_entries.foodName LIKE ?
      GROUP BY food_entries.id, dateTime, foodName, calories, servingSize, unit, meal`;

    const [rows] = await dbConnection.execute(sql, [`%${escapedSearchTerm}%`]);

    res.render("index", {
      pageTitle: "Food Entries",
      foodEntries: rows,
      searchTerm: searchTerm,
    });
  } catch (e) {
    console.error(e);
    next(e);
  }
});

/**
 * Route: GET /food-entry/create
 * @description Renders the create food entry form with meals and available tags for selection.
 * @route GET /food-entry/create
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response rendering create-food-entry view.
 * @param {import('express').NextFunction} next - Express next middleware.
 */
app.get("/food-entry/create", async function (req, res, next) {
  try {
    const [meals] = await dbConnection.execute("SELECT * FROM meals");
    const [tags] = await dbConnection.execute("SELECT * FROM tags");
    res.render("create-food-entry", { pageTitle: "Add Food Entry", meals, tags });
  } catch (e) {
    console.error(e);
    next(e);
  }
});

/**
 * Route: POST /food-entry/create
 * @description Creates a new food entry and inserts associated tag relationships inside an atomic transaction.
 * @route POST /food-entry/create
 * @param {import('express').Request} req - Express request body containing food entry details and selected tags.
 * @param {import('express').Response} res - Express response object (redirects to /).
 * @param {import('express').NextFunction} next - Express next middleware.
 */
app.post("/food-entry/create", async function (req, res, next) {
  const connection = await dbConnection.getConnection();
  try {
    await connection.beginTransaction();
    const { dateTime, foodName, calories, servingSize, meal, unit } = req.body;
    const caloriesNum = calories ? parseInt(calories, 10) || 0 : 0;
    const servingSizeNum = servingSize ? parseInt(servingSize, 10) || 1 : 1;

    const sql = `INSERT INTO food_entries (dateTime, foodName, calories, meal_id,
        servingSize, unit) VALUES(?, ?, ?, ?, ?, ?);`;

    const values = [
      dateTime,
      foodName,
      caloriesNum,
      meal || "1",
      servingSizeNum,
      unit,
    ];

    const [results] = await connection.execute(sql, values);
    const newFoodEntryID = results.insertId;

    const rawTags = req.body.tags || req.body["tags[]"] || [];
    const tagsArray = Array.isArray(rawTags) ? rawTags : [rawTags];
    const tags = [...new Set(tagsArray)].filter(Boolean);
    for (let t of tags) {
      const sql = `INSERT INTO food_entries_tags (food_entry_id, tag_id) VALUE (?, ?)`;
      await connection.execute(sql, [newFoodEntryID, t]);
    }
    await connection.commit();
    res.redirect("/");
  } catch (e) {
    await connection.rollback();
    console.error(e);
    next(e);
  } finally {
    connection.release();
  }
});

/**
 * Route: GET /food-entry/:id/edit
 * @description Loads an existing food entry and renders the edit form populated with current values and related tags.
 * @route GET /food-entry/:id/edit
 * @param {import('express').Request} req - Express request with food entry ID in params.
 * @param {import('express').Response} res - Express response rendering edit-food-entry view.
 * @param {import('express').NextFunction} next - Express next middleware.
 */
app.get("/food-entry/:id/edit", async function (req, res, next) {
  try {
    const foodRecordID = parseInt(req.params.id, 10);
    if (isNaN(foodRecordID) || foodRecordID <= 0) {
      return res.status(400).send("Invalid ID");
    }

    const [foodEntries] = await dbConnection.execute(
      `
      SELECT * FROM food_entries WHERE id = ?`,
      [foodRecordID],
    );
    const foodEntry = foodEntries[0];
    if (!foodEntry) {
      return res.status(404).send("Food entry not found");
    }

    const [foodEntryTags] = await dbConnection.execute(
      `SELECT * FROM
      food_entries_tags WHERE food_entry_id = ?`,
      [foodRecordID],
    );

    const [meals] = await dbConnection.execute("SELECT * FROM meals");

    const [tags] = await dbConnection.execute("SELECT * FROM tags");
    res.render("edit-food-entry", {
      pageTitle: "Edit Food Entry",
      foodEntry,
      meals: meals,
      tags: tags,
      relatedTags: foodEntryTags.map((t) => t.tag_id),
    });
  } catch (e) {
    console.error(e);
    next(e);
  }
});

/**
 * Route: POST /food-entry/:id/edit
 * @description Updates an existing food entry and refreshes its tag associations inside an atomic transaction.
 * @route POST /food-entry/:id/edit
 * @param {import('express').Request} req - Express request with food entry ID in params and updated fields in body.
 * @param {import('express').Response} res - Express response object (redirects to /).
 * @param {import('express').NextFunction} next - Express next middleware.
 */
app.post("/food-entry/:id/edit", async function (req, res, next) {
  const foodEntryID = parseInt(req.params.id, 10);
  if (isNaN(foodEntryID) || foodEntryID <= 0) {
    return res.status(400).send("Invalid ID");
  }

  const connection = await dbConnection.getConnection();
  try {
    await connection.beginTransaction();
    const caloriesNum = req.body.calories ? parseInt(req.body.calories, 10) || 0 : 0;
    const servingSizeNum = req.body.servingSize ? parseInt(req.body.servingSize, 10) || 1 : 1;

    const sql = `UPDATE food_entries SET dateTime=?,
        foodName=?,
        calories=?,
        meal_id=?,
        servingSize=?,
        unit=?
        WHERE id =?;`;
    const bindings = [
      req.body.dateTime,
      req.body.foodName,
      caloriesNum,
      req.body.meal || "1",
      servingSizeNum,
      req.body.unit,
      foodEntryID,
    ];

    // delete all existing tags from the food record
    await connection.execute(
      `DELETE FROM food_entries_tags WHERE
        food_entry_id = ?`,
      [foodEntryID],
    );

    // re-add all the relationships
    const rawTags = req.body.tags || req.body["tags[]"] || [];
    const tagsArray = Array.isArray(rawTags) ? rawTags : [rawTags];
    const tags = [...new Set(tagsArray)].filter(Boolean);
    for (let t of tags) {
      const sql = `INSERT INTO food_entries_tags (food_entry_id, tag_id)
            VALUE (?, ?)`;
      await connection.execute(sql, [foodEntryID, t]);
    }

    const results = await connection.execute(sql, bindings);
    await connection.commit();
    res.redirect("/");
  } catch (e) {
    console.error(e);
    await connection.rollback();
    next(e);
  } finally {
    await connection.release();
  }
});
/**
 * Route: GET /food-entry/:id/delete
 * @description Loads a food entry and renders the delete confirmation page.
 * @route GET /food-entry/:id/delete
 * @param {import('express').Request} req - Express request with entry ID in params.
 * @param {import('express').Response} res - Express response rendering delete-food-entry view.
 * @param {import('express').NextFunction} next - Express next middleware.
 */
app.get("/food-entry/:id/delete", async (req, res, next) => {
  try {
    const foodRecordID = parseInt(req.params.id, 10);
    if (isNaN(foodRecordID) || foodRecordID <= 0) {
      return res.status(400).send("Invalid ID");
    }

    const [rows] = await dbConnection.execute(
      "SELECT * FROM food_entries WHERE id = ?",
      [foodRecordID],
    );
    const foodEntry = rows[0];
    if (!foodEntry) {
      return res.status(404).send("Food entry not found");
    }

    res.render("delete-food-entry", {
      pageTitle: "Delete Food Entry",
      foodEntry,
    });
  } catch (e) {
    console.error(e);
    next(e);
  }
});

/**
 * Route: POST /food-entry/:id/delete
 * @description Deletes a food entry record from the database.
 * @route POST /food-entry/:id/delete
 * @param {import('express').Request} req - Express request with entry ID in params.
 * @param {import('express').Response} res - Express response object (redirects to /).
 * @param {import('express').NextFunction} next - Express next middleware.
 */
app.post("/food-entry/:id/delete", async (req, res, next) => {
  try {
    const foodRecordID = parseInt(req.params.id, 10);
    if (isNaN(foodRecordID) || foodRecordID <= 0) {
      return res.status(400).send("Invalid ID");
    }

    await dbConnection.execute("DELETE FROM food_entries WHERE id = ?", [
      foodRecordID,
    ]);

    res.redirect("/");
  } catch (e) {
    console.error(e);
    next(e);
  }
});

// 404 catch-all handler for unmapped routes
app.use((req, res, next) => {
  res.status(404).send("Page Not Found");
});

// global error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).send("Internal Server Error");
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = { app, dbConnection };

