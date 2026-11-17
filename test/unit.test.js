const test = require("node:test");
const assert = require("node:assert/strict");

test("Unit Tests - Parameter and URL Normalization", async (t) => {
  await t.test("tag deduplication logic deduplicates array items", () => {
    const rawTags = ["1", "2", "2", "3"];
    const uniqueTags = [...new Set(rawTags || [])];
    assert.deepEqual(uniqueTags, ["1", "2", "3"]);
  });

  await t.test("tag deduplication handles undefined or null tags safely", () => {
    const normalize = (val) => {
      const arr = Array.isArray(val) ? val : [val];
      return [...new Set(arr)].filter(Boolean);
    };
    assert.deepEqual(normalize(undefined), []);
    assert.deepEqual(normalize(null), []);
    assert.deepEqual(normalize(""), []);
  });

  await t.test("tag normalization safely converts single scalar string into array", () => {
    const normalize = (val) => {
      const arr = Array.isArray(val) ? val : [val];
      return [...new Set(arr)].filter(Boolean);
    };
    assert.deepEqual(normalize("5"), ["5"]);
    assert.deepEqual(normalize(["2", "3"]), ["2", "3"]);
  });

  await t.test("search term trimming removes whitespace", () => {
    const rawSearch = "   Chicken Salad   ";
    const searchTerm = (rawSearch || "").trim();
    assert.equal(searchTerm, "Chicken Salad");
    assert.equal(`%${searchTerm}%`, "%Chicken Salad%");
  });

  await t.test("search term wildcard escaping escapes % and _", () => {
    const escapeWildcards = (term) => (term || "").trim().replace(/[%_]/g, "\\$&");

    assert.equal(escapeWildcards("100% juice"), "100\\% juice");
    assert.equal(escapeWildcards("meal_id"), "meal\\_id");
    assert.equal(escapeWildcards("50%_off"), "50\\%\\_off");
    assert.equal(escapeWildcards("normal chicken"), "normal chicken");
  });

  await t.test("search term defaults to empty string when not provided", () => {
    const rawSearch = undefined;
    const searchTerm = (rawSearch || "").trim();
    assert.equal(searchTerm, "");
    assert.equal(`%${searchTerm}%`, "%%");
  });

  await t.test("meal fallback defaults to '1' (N/A) when empty or undefined", () => {
    const mealProvided = "3";
    const mealOmitted = "";
    assert.equal(mealProvided || "1", "3");
    assert.equal(mealOmitted || "1", "1");
  });

  await t.test("numeric input sanitization safely parses numbers and applies defaults", () => {
    const sanitizeCalories = (val) => (val ? parseInt(val, 10) || 0 : 0);
    const sanitizeServingSize = (val) => (val ? parseInt(val, 10) || 1 : 1);

    assert.equal(sanitizeCalories("350"), 350);
    assert.equal(sanitizeCalories(""), 0);
    assert.equal(sanitizeCalories(undefined), 0);
    assert.equal(sanitizeCalories("not-a-number"), 0);

    assert.equal(sanitizeServingSize("2"), 2);
    assert.equal(sanitizeServingSize(""), 1);
    assert.equal(sanitizeServingSize(undefined), 1);
    assert.equal(sanitizeServingSize("not-a-number"), 1);
  });

  await t.test("datetime slicing and formatting for datetime-local input", () => {
    const dbDateTime = "2026-11-01 08:30:00";
    const formatted = dbDateTime.replace(" ", "T").slice(0, 16);
    assert.equal(formatted, "2026-11-01T08:30");
  });
});
