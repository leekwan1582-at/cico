# Codebase Audit: Logic Errors & Missing Error Handling

This document summarizes findings from inspecting the `cico` codebase, categorizing logic bugs, edge-case flaws, and missing error handling routines. None of the recommendations alter the core application logic or design.

---

## 1. High Priority Findings (Potential Crashes / Unhandled Errors)

### 1.1 Unhandled Async Errors Leading to Server Hangs (RESOLVED)
- **Locations**:
  - `GET /` ([index.js:34-52](file:///home/leekwan/code/cico/index.js#L34-L52))
  - `GET /food-entry/create` ([index.js:55-59](file:///home/leekwan/code/cico/index.js#L55-L59))
  - `GET /food-entry/:id/edit` ([index.js:99-124](file:///home/leekwan/code/cico/index.js#L99-L124))
  - `GET /food-entry/:id/delete` ([index.js:176-185](file:///home/leekwan/code/cico/index.js#L176-L185))
  - `POST /food-entry/:id/delete` ([index.js:187-193](file:///home/leekwan/code/cico/index.js#L187-L193))
- **Status**: **RESOLVED**
- **Changes Applied**:
  - All async database queries across all route handlers are now wrapped in `try...catch (e)` blocks.
  - Route signatures accept `next` and forward exceptions via `next(e)` so requests never hang.
  - Implemented an Express global error-handling middleware (`app.use((err, req, res, next) => ...)`) returning HTTP 500 when an unhandled error bubbles up.
  - Added an integration test in `test/integration.test.js` validating that database errors on async routes trigger the 500 handler without hanging.

---

### 1.2 Missing 404 Guard When Record Does Not Exist (RESOLVED)
- **Locations**:
  - `GET /food-entry/:id/edit` ([index.js:109-119](file:///home/leekwan/code/cico/index.js#L109-L119))
  - `GET /food-entry/:id/delete` ([index.js:195-203](file:///home/leekwan/code/cico/index.js#L195-L203))
- **Status**: **RESOLVED**
- **Changes Applied**:
  - Added existence checks: if `!foodEntry`, the route immediately responds with `res.status(404).send("Food entry not found")` before attempting to access properties or render views.
  - Added integration tests in `test/integration.test.js` validating that requests to non-existent IDs on both edit and delete endpoints return HTTP 404.

---

### 1.3 `NaN` / Non-Integer IDs in Query Parameters (RESOLVED)
- **Locations**:
  - `GET & POST /food-entry/:id/edit` ([index.js:109-195](file:///home/leekwan/code/cico/index.js#L109-L195))
  - `GET & POST /food-entry/:id/delete` ([index.js:197-236](file:///home/leekwan/code/cico/index.js#L197-L236))
- **Status**: **RESOLVED**
- **Changes Applied**:
  - Added numeric parameter validation: `const id = parseInt(req.params.id, 10); if (isNaN(id) || id <= 0) return res.status(400).send("Invalid ID");`.
  - Applied to all 4 endpoints (`GET /food-entry/:id/edit`, `POST /food-entry/:id/edit`, `GET /food-entry/:id/delete`, and `POST /food-entry/:id/delete`).
  - Added integration tests in `test/integration.test.js` validating that requests with non-numeric strings or non-positive integers (`<= 0`) return HTTP 400 Bad Request.

---

## 2. Medium Priority Findings (Logic Flaws & Form Handling)

### 2.1 Single Checkbox vs. Multiple Checkbox Parsing (`req.body.tags`) (RESOLVED)
- **Locations**:
  - `views/food-entry-form.ejs:41`: `name="tags[]"`
  - `POST /food-entry/create` ([index.js:92-96](file:///home/leekwan/code/cico/index.js#L92-L96))
  - `POST /food-entry/:id/edit` ([index.js:189-193](file:///home/leekwan/code/cico/index.js#L189-L193))
- **Status**: **RESOLVED**
- **Changes Applied**:
  - Normalized tag retrieval across both create and edit routes:
    ```javascript
    const rawTags = req.body.tags || req.body["tags[]"] || [];
    const tagsArray = Array.isArray(rawTags) ? rawTags : [rawTags];
    const tags = [...new Set(tagsArray)].filter(Boolean);
    ```
  - Supports both `tags` and `tags[]` input keys, prevents splitting single string scalars into individual characters, and removes falsy values.
  - Added unit test in `test/unit.test.js` and an integration test in `test/integration.test.js` verifying that a single scalar string is stored as a single tag record.

---

### 2.2 Lack of Input Type Sanitization / Empty Number Handling (RESOLVED)
- **Locations**:
  - `POST /food-entry/create` ([index.js:76-88](file:///home/leekwan/code/cico/index.js#L76-L88))
  - `POST /food-entry/:id/edit` ([index.js:163-176](file:///home/leekwan/code/cico/index.js#L163-L176))
- **Status**: **RESOLVED**
- **Changes Applied**:
  - Sanitized numeric input values before SQL binding:
    ```javascript
    const caloriesNum = calories ? parseInt(calories, 10) || 0 : 0;
    const servingSizeNum = servingSize ? parseInt(servingSize, 10) || 1 : 1;
    ```
  - Prevents `ER_TRUNCATED_WRONG_VALUE_FOR_FIELD` when users submit empty number inputs (`""`) or non-numeric values under strict SQL modes.
  - Added unit test in `test/unit.test.js` and an integration test in `test/integration.test.js` verifying that empty string number inputs safely default to integer 0 and 1.

---

### 2.3 SQL Wildcard Escaping in Search (RESOLVED)
- **Locations**:
  - `GET /` ([index.js:36-48](file:///home/leekwan/code/cico/index.js#L36-L48))
- **Status**: **RESOLVED**
- **Changes Applied**:
  - Escaped SQL `LIKE` wildcard operators (`%` and `_`) using `.replace(/[%_]/g, "\\$&")`:
    ```javascript
    const searchTerm = (req.query.search || "").trim();
    const escapedSearchTerm = searchTerm.replace(/[%_]/g, "\\$&");
    ```
  - Passed `%${escapedSearchTerm}%` to the SQL query parameter while preserving the unescaped `searchTerm` for the template view search input value.
  - Added a unit test in `test/unit.test.js` and an integration test in `test/integration.test.js` validating that input terms containing `%` or `_` are escaped properly in the SQL query parameter.

---

## 3. Low Priority / Maintenance Findings

### 3.1 Missing 404 Route Catch-All and Global Error Middleware (RESOLVED)
- **Locations**:
  - End of `index.js` ([index.js:254-266](file:///home/leekwan/code/cico/index.js#L254-L266))
- **Status**: **RESOLVED**
- **Changes Applied**:
  - Added a 404 catch-all middleware (`app.use((req, res, next) => res.status(404).send("Page Not Found"))`) for unmapped routes.
  - Retained custom 4-argument global error middleware (`app.use((err, req, res, next) => ...)`) returning HTTP 500 without leaking stack traces.
  - Added integration test in `test/integration.test.js` verifying that requests to unmapped endpoints return HTTP 404.

### 3.2 Typo in Comment (RESOLVED)
- **Location**:
  - `index.js:21`
- **Status**: **RESOLVED**
- **Correction Applied**:
  - Updated `// mariable db connection configuration` to `// MariaDB connection configuration`.

---

## Summary Matrix

| Issue | Severity | Status | Impact | Solution Applied |
| :--- | :---: | :---: | :--- | :--- |
| Unhandled async exceptions in GET routes | High | **RESOLVED** | Request hangs / crash on DB disconnection | Wrapped in `try/catch` and forwarded via `next(e)` to 500 middleware |
| Missing 404 on edit/delete non-existent ID | High | **RESOLVED** | Uncaught `TypeError` crashing render | Verified record exists before calling `res.render`, returning 404 if missing |
| `NaN` / Non-Integer IDs in Query Parameters | High | **RESOLVED** | SQL conversion warnings or invalid DB queries | Parameter validation `parseInt(id, 10) <= 0` returning 400 Bad Request |
| Tag field array normalization | Medium | **RESOLVED** | String scalar decomposed into characters | Normalized tags using `Array.isArray()` and `.filter(Boolean)` |
| Empty string numeric conversion | Medium | **RESOLVED** | SQL error under `STRICT_TRANS_TABLES` | Fallback sanitization to safe integers (`0` and `1`) |
| Search wildcard escaping | Low | **RESOLVED** | Unintended wildcard matching in SQL | Escaped `%` and `_` with backslashes before binding |
| Missing 404 Route Catch-All | Low | **RESOLVED** | Default fallback behavior for invalid routes | Added 404 catch-all middleware returning `Page Not Found` |
| Typo in Comment | Low | **RESOLVED** | Code hygiene | Corrected comment to `MariaDB connection configuration` |
