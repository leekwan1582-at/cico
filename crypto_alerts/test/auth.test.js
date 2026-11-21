const test = require("node:test");
const assert = require("node:assert/strict");
const authService = require("../services/authService");

test("Unit Tests - Authentication & JWT Token Service", async (t) => {
  await t.test("hashPassword generates unique salts and verifiable hashes", async () => {
    const p1 = await authService.hashPassword("mypassword");
    const p2 = await authService.hashPassword("mypassword");

    assert.ok(p1.hash);
    assert.ok(p1.salt);
    assert.ok(p2.hash);
    assert.ok(p2.salt);
    // Salts must be cryptographically unique
    assert.notEqual(p1.salt, p2.salt);
    assert.notEqual(p1.hash, p2.hash);
  });

  await t.test("verifyPassword validates correct password and rejects invalid ones", async () => {
    const { hash, salt } = await authService.hashPassword("secret123");

    const valid = await authService.verifyPassword("secret123", hash, salt);
    assert.equal(valid, true, "Correct password should return true");

    const invalid = await authService.verifyPassword("wrongpass", hash, salt);
    assert.equal(invalid, false, "Wrong password should return false");

    const empty = await authService.verifyPassword("", hash, salt);
    assert.equal(empty, false);
  });

  await t.test("generateToken and verifyToken work with valid claims", () => {
    const payload = { id: 1, username: "leekwan", email: "leekwan@example.com" };
    const token = authService.generateToken(payload, 1); // 1 hour validity

    assert.ok(token);
    assert.equal(token.split(".").length, 3);

    const verified = authService.verifyToken(token);
    assert.ok(verified);
    assert.equal(verified.id, 1);
    assert.equal(verified.username, "leekwan");
    assert.equal(verified.email, "leekwan@example.com");
  });

  await t.test("verifyToken rejects tampered signature or invalid structure", () => {
    const payload = { id: 2, username: "trader_sg" };
    const token = authService.generateToken(payload, 1);

    const [header, body, sig] = token.split(".");
    // Tamper with body to claim id: 1 (leekwan)
    const tamperedBody = Buffer.from(JSON.stringify({ ...payload, id: 1 }))
      .toString("base64")
      .replace(/=/g, "");
    const tamperedToken = `${header}.${tamperedBody}.${sig}`;

    const verified = authService.verifyToken(tamperedToken);
    assert.equal(verified, null, "Tampered token signature must fail verification");

    assert.equal(authService.verifyToken("invalid.token"), null);
    assert.equal(authService.verifyToken(""), null);
  });

  await t.test("sanitizeRedirectUrl prevents open redirect vulnerabilities", () => {
    const { sanitizeRedirectUrl } = require("../middleware/authMiddleware");

    // Safe relative paths
    assert.equal(sanitizeRedirectUrl("/"), "/");
    assert.equal(sanitizeRedirectUrl("/alerts"), "/alerts");
    assert.equal(sanitizeRedirectUrl("/assets?format=json"), "/assets?format=json");

    // Unsafe protocol-relative / backslash / external URLs
    assert.equal(sanitizeRedirectUrl("//evil.com/phish"), "/");
    assert.equal(sanitizeRedirectUrl("///evil.com"), "/");
    assert.equal(sanitizeRedirectUrl("/\\evil.com"), "/");
    assert.equal(sanitizeRedirectUrl("https://evil.com"), "/");
    assert.equal(sanitizeRedirectUrl("javascript:alert(1)"), "/");
    assert.equal(sanitizeRedirectUrl(""), "/");
    assert.equal(sanitizeRedirectUrl(null), "/");
  });

  await t.test("requireRole middleware allows matching role and forbids mismatching role", () => {
    const { requireRole } = require("../middleware/authMiddleware");

    const adminMiddleware = requireRole("ADMIN");
    let nextCalled = false;
    const nextFn = () => { nextCalled = true; };

    // 1. Matching ADMIN user
    let req = { user: { id: 1, username: "leekwan", role: "ADMIN" } };
    let res = {};
    adminMiddleware(req, res, nextFn);
    assert.equal(nextCalled, true, "Admin user should pass requireRole('ADMIN')");

    // 2. Case-insensitive matching ('admin' vs 'ADMIN')
    nextCalled = false;
    req = { user: { id: 1, username: "leekwan", role: "admin" } };
    adminMiddleware(req, res, nextFn);
    assert.equal(nextCalled, true, "Case-insensitive admin role should pass");

    // 3. Trader user blocked from ADMIN role (HTML request)
    nextCalled = false;
    let statusCode = 0;
    let responseBody = "";
    req = { user: { id: 2, username: "trader_sg", role: "TRADER" }, path: "/admin" };
    res = {
      status(code) {
        statusCode = code;
        return {
          send(msg) { responseBody = msg; },
          json(obj) { responseBody = obj; },
        };
      },
    };
    adminMiddleware(req, res, nextFn);
    assert.equal(nextCalled, false, "Trader user must be blocked");
    assert.equal(statusCode, 403);
    assert.ok(responseBody.includes("Forbidden"));

    // 4. Trader user blocked from ADMIN role (JSON/API request)
    nextCalled = false;
    statusCode = 0;
    responseBody = "";
    req = { user: { id: 2, username: "trader_sg", role: "TRADER" }, path: "/api/admin/exchanges" };
    adminMiddleware(req, res, nextFn);
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
    assert.equal(responseBody.error, "Forbidden");
  });
});
