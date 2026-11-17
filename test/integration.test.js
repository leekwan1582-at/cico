const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

test("Integration Tests - HTTP Routes & Database Mocking", async (t) => {
  let server;
  let baseUrl;
  let executedQueries = [];

  // Mock database connection pool before loading index.js
  const mockDb = {
    async execute(sql, params) {
      executedQueries.push({ sql, params });

      if (sql.includes("FROM food_entries") && sql.includes("WHERE food_entries.foodName LIKE")) {
        return [
          [
            {
              id: 1,
              dateTime: "2026-11-01 08:30:00",
              foodName: "Oatmeal",
              calories: 250,
              servingSize: 1,
              unit: "serving",
              meal: "Breakfast",
              selected_tags: "Vegan,Low Fat",
            },
          ],
        ];
      }

      if (sql.includes("SELECT * FROM meals")) {
        return [
          [
            { id: 1, name: "N/A" },
            { id: 2, name: "Breakfast" },
          ],
        ];
      }

      if (sql.includes("SELECT * FROM tags")) {
        return [
          [
            { id: 1, name: "Vegan" },
            { id: 2, name: "Vegetarian" },
          ],
        ];
      }

      if (sql.includes("SELECT * FROM food_entries WHERE id = ?")) {
        const id = params && params[0];
        if (id == 1) {
          return [
            [
              {
                id: 1,
                dateTime: "2026-11-01 08:30:00",
                foodName: "Oatmeal",
                calories: 250,
                servingSize: 1,
                unit: "serving",
                meal_id: 2,
              },
            ],
          ];
        }
        return [[]];
      }

      if (sql.includes("food_entries_tags WHERE food_entry_id = ?")) {
        return [[{ food_entry_id: 1, tag_id: 1 }]];
      }

      if (sql.includes("DELETE FROM food_entries WHERE id = ?")) {
        return [{ affectedRows: 1 }];
      }

      return [[]];
    },

    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        async execute(sql, params) {
          executedQueries.push({ sql, params });
          if (sql.includes("INSERT INTO food_entries (")) {
            return [{ insertId: 99 }];
          }
          return [[]];
        },
        release() {},
      };
    },
  };

  // Replace dbConnection pool in index.js with mockDb
  const indexModule = require("../index.js");
  const originalExecute = indexModule.dbConnection.execute;
  const originalGetConn = indexModule.dbConnection.getConnection;
  indexModule.dbConnection.execute = mockDb.execute.bind(mockDb);
  indexModule.dbConnection.getConnection = mockDb.getConnection.bind(mockDb);

  // Start the server using a Promise
  await new Promise((resolve) => {
    server = http.createServer(indexModule.app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(async () => {
    indexModule.dbConnection.execute = originalExecute;
    indexModule.dbConnection.getConnection = originalGetConn;
    await new Promise((resolve) => server.close(resolve));
  });

  t.beforeEach(() => {
    executedQueries = [];
  });

  await t.test("GET / renders dashboard with 200 OK", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Food Entries"));
    assert.ok(html.includes("Oatmeal"));
  });

  await t.test("GET / with search query filters with wildcards", async () => {
    const res = await fetch(`${baseUrl}/?search=Rice`);
    assert.equal(res.status, 200);
    const lastSearchQuery = executedQueries.find((q) =>
      q.sql.includes("food_entries.foodName LIKE")
    );
    assert.ok(lastSearchQuery);
    assert.deepEqual(lastSearchQuery.params, ["%Rice%"]);
  });

  await t.test("GET / with search query containing SQL wildcards % and _ escapes them properly", async () => {
    const res = await fetch(`${baseUrl}/?search=100%25_juice`);
    assert.equal(res.status, 200);
    const lastSearchQuery = executedQueries.find((q) =>
      q.sql.includes("food_entries.foodName LIKE")
    );
    assert.ok(lastSearchQuery);
    // 100%_juice escaped becomes 100\%_juice, wrapped in %...%
    assert.deepEqual(lastSearchQuery.params, ["%100\\%\\_juice%"]);
  });

  await t.test("GET /food-entry/create renders create form", async () => {
    const res = await fetch(`${baseUrl}/food-entry/create`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Add Food Entry") || html.includes("Create Food Entry"));
    assert.ok(html.includes("Breakfast"));
  });

  await t.test("POST /food-entry/create inserts entry and redirects to /", async () => {
    const formBody = new URLSearchParams();
    formBody.append("dateTime", "2026-11-01 08:30:00");
    formBody.append("foodName", "Pancakes");
    formBody.append("calories", "350");
    formBody.append("servingSize", "2");
    formBody.append("unit", "serving");
    formBody.append("meal", "2");
    formBody.append("tags[]", "1");
    formBody.append("tags[]", "2");

    const res = await fetch(`${baseUrl}/food-entry/create`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");

    const insertMaster = executedQueries.find((q) =>
      q.sql.includes("INSERT INTO food_entries (")
    );
    assert.ok(insertMaster);
    assert.equal(insertMaster.params[1], "Pancakes");

    const tagInserts = executedQueries.filter((q) =>
      q.sql.includes("INSERT INTO food_entries_tags")
    );
    assert.equal(tagInserts.length, 2);
    assert.deepEqual(tagInserts[0].params, [99, "1"]);
    assert.deepEqual(tagInserts[1].params, [99, "2"]);
  });

  await t.test("GET /food-entry/:id/edit renders edit form with populated fields", async () => {
    const res = await fetch(`${baseUrl}/food-entry/1/edit`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Edit Food Entry"));
    assert.ok(html.includes("Oatmeal"));
  });

  await t.test("POST /food-entry/:id/edit updates food entry and redirects", async () => {
    const formBody = new URLSearchParams();
    formBody.append("dateTime", "2026-11-01 09:00:00");
    formBody.append("foodName", "Oatmeal Updated");
    formBody.append("calories", "280");
    formBody.append("servingSize", "1");
    formBody.append("unit", "serving");
    formBody.append("meal", "2");
    formBody.append("tags[]", "1");

    const res = await fetch(`${baseUrl}/food-entry/1/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");

    const deleteTags = executedQueries.find((q) =>
      q.sql.includes("DELETE FROM food_entries_tags WHERE")
    );
    assert.ok(deleteTags);

    const updateMaster = executedQueries.find((q) =>
      q.sql.includes("UPDATE food_entries SET")
    );
    assert.ok(updateMaster);
    assert.equal(updateMaster.params[1], "Oatmeal Updated");

    const tagInserts = executedQueries.filter((q) =>
      q.sql.includes("INSERT INTO food_entries_tags")
    );
    assert.equal(tagInserts.length, 1);
    assert.deepEqual(tagInserts[0].params, [1, "1"]);
  });

  await t.test("GET /food-entry/:id/delete renders delete confirmation", async () => {
    const res = await fetch(`${baseUrl}/food-entry/1/delete`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Delete Food Entry"));
    assert.ok(html.includes("Oatmeal"));
  });

  await t.test("POST /food-entry/:id/delete deletes record and redirects", async () => {
    const res = await fetch(`${baseUrl}/food-entry/1/delete`, {
      method: "POST",
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");

    const deleteMaster = executedQueries.find((q) =>
      q.sql.includes("DELETE FROM food_entries WHERE id = ?")
    );
    assert.ok(deleteMaster);
    assert.deepEqual(deleteMaster.params, [1]);
  });

  await t.test("Async Error Handling - Database error on GET / triggers 500 error middleware", async () => {
    // Temporarily simulate database failure
    const failingExecute = async () => {
      throw new Error("Simulated MariaDB failure");
    };
    indexModule.dbConnection.execute = failingExecute;

    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.ok(body.includes("Internal Server Error"));

    // Restore mock execute
    indexModule.dbConnection.execute = mockDb.execute.bind(mockDb);
  });

  await t.test("404 Guard - GET /food-entry/:id/edit returns 404 if record does not exist", async () => {
    const res = await fetch(`${baseUrl}/food-entry/99999/edit`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(body.includes("Food entry not found"));
  });

  await t.test("404 Guard - GET /food-entry/:id/delete returns 404 if record does not exist", async () => {
    const res = await fetch(`${baseUrl}/food-entry/99999/delete`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(body.includes("Food entry not found"));
  });

  await t.test("Invalid ID Guard - GET & POST with non-integer ID returns 400 Bad Request", async () => {
    const resEditGet = await fetch(`${baseUrl}/food-entry/not-a-number/edit`);
    assert.equal(resEditGet.status, 400);
    assert.ok((await resEditGet.text()).includes("Invalid ID"));

    const resEditPost = await fetch(`${baseUrl}/food-entry/not-a-number/edit`, {
      method: "POST",
    });
    assert.equal(resEditPost.status, 400);
    assert.ok((await resEditPost.text()).includes("Invalid ID"));

    const resDeleteGet = await fetch(`${baseUrl}/food-entry/not-a-number/delete`);
    assert.equal(resDeleteGet.status, 400);
    assert.ok((await resDeleteGet.text()).includes("Invalid ID"));

    const resDeletePost = await fetch(`${baseUrl}/food-entry/not-a-number/delete`, {
      method: "POST",
    });
    assert.equal(resDeletePost.status, 400);
    assert.ok((await resDeletePost.text()).includes("Invalid ID"));
  });

  await t.test("Invalid ID Guard - Non-positive integer (<= 0) returns 400 Bad Request", async () => {
    const resNegative = await fetch(`${baseUrl}/food-entry/-5/edit`);
    assert.equal(resNegative.status, 400);

    const resZero = await fetch(`${baseUrl}/food-entry/0/delete`);
    assert.equal(resZero.status, 400);
  });

  await t.test("Tag Normalization - Single scalar string tag is handled as single array item", async () => {
    const formBody = new URLSearchParams();
    formBody.append("dateTime", "2026-11-01 10:00:00");
    formBody.append("foodName", "Single Tag Item");
    formBody.append("calories", "100");
    formBody.append("servingSize", "1");
    formBody.append("unit", "serving");
    formBody.append("meal", "1");
    formBody.append("tags", "2"); // Sent as scalar "tags=2", not "tags[]=2"

    const res = await fetch(`${baseUrl}/food-entry/create`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    const tagInserts = executedQueries.filter((q) =>
      q.sql.includes("INSERT INTO food_entries_tags")
    );
    assert.equal(tagInserts.length, 1);
    assert.deepEqual(tagInserts[0].params, [99, "2"]);
  });

  await t.test("Numeric Sanitization - Empty string calories and servingSize fall back to safe integers", async () => {
    const formBody = new URLSearchParams();
    formBody.append("dateTime", "2026-11-01 12:00:00");
    formBody.append("foodName", "Zero Calorie Water");
    formBody.append("calories", ""); // empty string
    formBody.append("servingSize", ""); // empty string
    formBody.append("unit", "cup");
    formBody.append("meal", "1");

    const res = await fetch(`${baseUrl}/food-entry/create`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    const insertMaster = executedQueries.find(
      (q) => q.sql.includes("INSERT INTO food_entries (") && q.params[1] === "Zero Calorie Water"
    );
    assert.ok(insertMaster);
    // calories should be integer 0, servingSize should be integer 1
    assert.equal(insertMaster.params[2], 0);
    assert.equal(insertMaster.params[4], 1);
  });

  await t.test("404 Catch-All - Request to unmapped route returns 404 Page Not Found", async () => {
    const res = await fetch(`${baseUrl}/some-non-existent-route`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(body.includes("Page Not Found"));
  });
});
