const mysql2 = require("mysql2/promise");
const dotenv = require("dotenv");

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
};

// 20 realistic food entries with meal categories, serving size, and tag names
const dummyFoodEntries = [
  {
    foodName: "Scrambled Eggs with Spinach",
    dateTime: "2026-11-01 08:00:00",
    calories: 220,
    servingSize: 2,
    unit: "large eggs",
    mealName: "Breakfast",
    tags: ["Vegetarian", "Low Carb"],
  },
  {
    foodName: "Steel-Cut Oatmeal with Berries",
    dateTime: "2026-11-01 08:45:00",
    calories: 280,
    servingSize: 1,
    unit: "bowl",
    mealName: "Breakfast",
    tags: ["Vegan", "Vegetarian", "Low Fat"],
  },
  {
    foodName: "Greek Yogurt with Chia Seeds",
    dateTime: "2026-11-02 10:15:00",
    calories: 170,
    servingSize: 200,
    unit: "grams",
    mealName: "Snack",
    tags: ["Vegetarian", "Gluten-Free"],
  },
  {
    foodName: "Grilled Chicken Breast with Quinoa",
    dateTime: "2026-11-02 12:30:00",
    calories: 450,
    servingSize: 250,
    unit: "grams",
    mealName: "Lunch",
    tags: ["Gluten-Free", "Low Carb", "Low Fat"],
  },
  {
    foodName: "Avocado Toast on Sourdough",
    dateTime: "2026-11-03 09:00:00",
    calories: 320,
    servingSize: 2,
    unit: "slices",
    mealName: "Breakfast",
    tags: ["Vegan", "Vegetarian"],
  },
  {
    foodName: "Pan-Seared Salmon Fillet with Asparagus",
    dateTime: "2026-11-03 19:15:00",
    calories: 520,
    servingSize: 200,
    unit: "grams",
    mealName: "Dinner",
    tags: ["Gluten-Free", "Low Carb"],
  },
  {
    foodName: "Steamed Edamame",
    dateTime: "2026-11-04 15:30:00",
    calories: 120,
    servingSize: 1,
    unit: "cup",
    mealName: "Snack",
    tags: ["Vegan", "Vegetarian", "Gluten-Free"],
  },
  {
    foodName: "Brown Rice with Tofu & Mixed Vegetables",
    dateTime: "2026-11-04 13:00:00",
    calories: 410,
    servingSize: 1,
    unit: "plate",
    mealName: "Lunch",
    tags: ["Vegan", "Vegetarian", "Gluten-Free"],
  },
  {
    foodName: "Protein Whey Shake",
    dateTime: "2026-11-05 17:00:00",
    calories: 160,
    servingSize: 1,
    unit: "scoop",
    mealName: "Snack",
    tags: ["Vegetarian", "Low Carb", "Low Fat"],
  },
  {
    foodName: "Ribeye Steak with Roasted Broccoli",
    dateTime: "2026-11-05 20:00:00",
    calories: 680,
    servingSize: 300,
    unit: "grams",
    mealName: "Dinner",
    tags: ["Gluten-Free", "Low Carb"],
  },
  {
    foodName: "Fruit Salad (Apple, Banana, Kiwi)",
    dateTime: "2026-11-06 11:00:00",
    calories: 140,
    servingSize: 1,
    unit: "bowl",
    mealName: "Snack",
    tags: ["Vegan", "Vegetarian", "Low Fat", "Gluten-Free"],
  },
  {
    foodName: "Caesar Salad with Grilled Chicken",
    dateTime: "2026-11-06 12:45:00",
    calories: 380,
    servingSize: 1,
    unit: "bowl",
    mealName: "Lunch",
    tags: ["Low Carb"],
  },
  {
    foodName: "Lentil Soup",
    dateTime: "2026-11-07 18:30:00",
    calories: 290,
    servingSize: 350,
    unit: "ml",
    mealName: "Dinner",
    tags: ["Vegan", "Vegetarian", "Gluten-Free", "Low Fat"],
  },
  {
    foodName: "Whole Wheat Pancakes with Honey",
    dateTime: "2026-11-08 09:30:00",
    calories: 390,
    servingSize: 3,
    unit: "pieces",
    mealName: "Breakfast",
    tags: ["Vegetarian"],
  },
  {
    foodName: "Almonds & Walnuts Mix",
    dateTime: "2026-11-08 16:00:00",
    calories: 210,
    servingSize: 40,
    unit: "grams",
    mealName: "Snack",
    tags: ["Vegan", "Vegetarian", "Gluten-Free", "Low Carb"],
  },
  {
    foodName: "Turkey & Cheddar Wrap",
    dateTime: "2026-11-09 13:15:00",
    calories: 430,
    servingSize: 1,
    unit: "wrap",
    mealName: "Lunch",
    tags: [],
  },
  {
    foodName: "Spaghetti Bolognese",
    dateTime: "2026-11-09 19:45:00",
    calories: 590,
    servingSize: 1,
    unit: "plate",
    mealName: "Dinner",
    tags: [],
  },
  {
    foodName: "Boiled Sweet Potatoes",
    dateTime: "2026-11-10 12:00:00",
    calories: 190,
    servingSize: 200,
    unit: "grams",
    mealName: "Lunch",
    tags: ["Vegan", "Vegetarian", "Gluten-Free", "Low Fat"],
  },
  {
    foodName: "Mushroom Omelette",
    dateTime: "2026-11-10 08:15:00",
    calories: 260,
    servingSize: 2,
    unit: "eggs",
    mealName: "Breakfast",
    tags: ["Vegetarian", "Low Carb", "Gluten-Free"],
  },
  {
    foodName: "Baked White Fish with Lemon and Herb",
    dateTime: "2026-11-11 19:30:00",
    calories: 340,
    servingSize: 220,
    unit: "grams",
    mealName: "Dinner",
    tags: ["Gluten-Free", "Low Carb", "Low Fat"],
  },
];

async function seed() {
  const connection = await mysql2.createConnection(dbConfig);
  console.log("Connected to database:", dbConfig.database);

  try {
    // 1. Fetch meals lookup map (name -> id)
    const [mealsRows] = await connection.execute("SELECT id, name FROM meals");
    const mealMap = new Map();
    for (let meal of mealsRows) {
      mealMap.set(meal.name.toLowerCase(), meal.id);
    }

    // 2. Fetch tags lookup map (name -> id)
    const [tagsRows] = await connection.execute("SELECT id, name FROM tags");
    const tagMap = new Map();
    for (let tag of tagsRows) {
      tagMap.set(tag.name.toLowerCase(), tag.id);
    }

    console.log("Found meals:", mealsRows.map((m) => m.name));
    console.log("Found tags:", tagsRows.map((t) => t.name));

    // 3. Begin transaction to insert 20 food entries and their tag relationships
    await connection.beginTransaction();

    let insertedCount = 0;
    for (const entry of dummyFoodEntries) {
      const mealId = mealMap.get(entry.mealName.toLowerCase()) || 1; // default to 1 (N/A) if not found

      const insertSql = `
        INSERT INTO food_entries (dateTime, foodName, calories, meal_id, servingSize, unit)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      const [result] = await connection.execute(insertSql, [
        entry.dateTime,
        entry.foodName,
        entry.calories,
        mealId,
        entry.servingSize,
        entry.unit,
      ]);

      const foodEntryId = result.insertId;

      // Link tags in food_entries_tags
      if (entry.tags && entry.tags.length > 0) {
        for (const tagName of entry.tags) {
          const tagId = tagMap.get(tagName.toLowerCase());
          if (tagId) {
            await connection.execute(
              "INSERT INTO food_entries_tags (food_entry_id, tag_id) VALUES (?, ?)",
              [foodEntryId, tagId]
            );
          }
        }
      }

      insertedCount++;
    }

    await connection.commit();
    console.log(`Successfully seeded ${insertedCount} food entries with meal & tag associations!`);
  } catch (error) {
    await connection.rollback();
    console.error("Seeding failed, rolled back:", error);
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
}

seed();
