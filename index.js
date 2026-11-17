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

const dbConnection = mysql2.createPool(dbConfig);

// list the food entries
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

// create food entry form
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

// insert food entry
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

// edit the food entry
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

// update the food entry
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
// delete the food entry
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

