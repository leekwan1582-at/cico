/**
 * @file Personal API Token Service
 * @description Manages creation, SHA-256 hashing, verification, scope checking,
 * and revocation for Personal Access Tokens (PAT).
 * @module services/tokenService
 */

const crypto = require("crypto");
const pool = require("../config/db");

/**
 * Valid allowed scopes for personal access tokens.
 * @type {string[]}
 */
const ALLOWED_SCOPES = ["read:alerts", "write:alerts", "read:markets", "read:kpi"];

/**
 * Hashes a plaintext token string with SHA-256.
 *
 * @param {string} rawToken - Plaintext token.
 * @returns {string} Hex-encoded SHA-256 hash.
 */
function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Generates a new cryptographically secure personal access token.
 *
 * @returns {{ rawToken: string, prefix: string, hash: string }}
 */
function generateTokenPair() {
  const secret = crypto.randomBytes(24).toString("hex");
  const rawToken = `cpat_${secret}`;
  const prefix = rawToken.slice(0, 12); // e.g. "cpat_a1b2c3d"
  const hash = hashToken(rawToken);
  return { rawToken, prefix, hash };
}

/**
 * Creates and persists a new Personal Access Token for a user.
 *
 * @async
 * @param {number} userId - Owner user ID.
 * @param {string} name - Token name / description.
 * @param {string[]|string} [scopes=['read:alerts']] - Requested token scopes.
 * @param {number|null} [expiresInDays=null] - Optional days until token expires.
 * @returns {Promise<{ id: number, rawToken: string, name: string, prefix: string, scopes: string[], expiresAt: string|null }>}
 */
async function createToken(userId, name, scopes = ["read:alerts"], expiresInDays = null) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Token name is required");
  }

  // Normalize scopes
  const scopeList = Array.isArray(scopes)
    ? scopes.map((s) => s.trim().toLowerCase()).filter((s) => ALLOWED_SCOPES.includes(s))
    : scopes.split(",").map((s) => s.trim().toLowerCase()).filter((s) => ALLOWED_SCOPES.includes(s));

  if (scopeList.length === 0) {
    scopeList.push("read:alerts");
  }
  const scopeStr = scopeList.join(",");

  const { rawToken, prefix, hash } = generateTokenPair();

  let expiresAt = null;
  if (expiresInDays && Number(expiresInDays) > 0) {
    const exp = new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000);
    expiresAt = exp.toISOString().slice(0, 19).replace("T", " ");
  }

  const sql = `
    INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, scopes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const [result] = await pool.query(sql, [
    userId,
    name.trim().slice(0, 100),
    prefix,
    hash,
    scopeStr,
    expiresAt,
  ]);

  return {
    id: result.insertId,
    rawToken, // Only returned once at creation time!
    name: name.trim(),
    prefix,
    scopes: scopeList,
    expiresAt,
  };
}

/**
 * Validates a plaintext Bearer token and verifies an optional required scope.
 * If valid, returns the associated user and token metadata, and updates last_used_at.
 *
 * @async
 * @param {string} rawToken - Plaintext token provided in Bearer header.
 * @param {string|null} [requiredScope=null] - Required scope string (e.g. 'read:alerts').
 * @returns {Promise<object|null>} Authenticated user object or null.
 */
async function verifyToken(rawToken, requiredScope = null) {
  if (!rawToken || typeof rawToken !== "string" || !rawToken.startsWith("cpat_")) {
    return null;
  }

  const tokenHash = hashToken(rawToken);

  const sql = `
    SELECT t.id AS token_id, t.name AS token_name, t.scopes, t.expires_at,
           u.id, u.username, u.email, u.role
    FROM api_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token_hash = ?
      AND (t.expires_at IS NULL OR t.expires_at > NOW())
    LIMIT 1
  `;
  const [rows] = await pool.query(sql, [tokenHash]);
  if (!rows || rows.length === 0) {
    return null;
  }

  const record = rows[0];
  const scopes = record.scopes ? record.scopes.split(",").map((s) => s.trim().toLowerCase()) : [];

  if (requiredScope && !scopes.includes(requiredScope.toLowerCase())) {
    return {
      error: "INSUFFICIENT_SCOPE",
      requiredScope,
      userScopes: scopes,
    };
  }

  // Update last_used_at asynchronously (non-blocking)
  pool.query("UPDATE api_tokens SET last_used_at = NOW() WHERE id = ?", [record.token_id]).catch(() => {});

  return {
    id: record.id,
    username: record.username,
    email: record.email,
    role: record.role,
    isApiToken: true,
    tokenId: record.token_id,
    tokenName: record.token_name,
    tokenScopes: scopes,
  };
}

/**
 * Lists all active API tokens for a user (without exposing secret hashes).
 *
 * @async
 * @param {number} userId - User ID.
 * @returns {Promise<Array<object>>} List of token records.
 */
async function listTokens(userId) {
  const sql = `
    SELECT id, name, token_prefix, scopes, last_used_at, expires_at, created_at
    FROM api_tokens
    WHERE user_id = ?
    ORDER BY created_at DESC
  `;
  const [rows] = await pool.query(sql, [userId]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.token_prefix,
    scopes: r.scopes ? r.scopes.split(",") : [],
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

/**
 * Revokes / deletes an API token owned by a user.
 *
 * @async
 * @param {number} userId - Owner user ID.
 * @param {number} tokenId - Token ID.
 * @returns {Promise<boolean>} True if deleted.
 */
async function revokeToken(userId, tokenId) {
  const [result] = await pool.query("DELETE FROM api_tokens WHERE id = ? AND user_id = ?", [tokenId, userId]);
  return result.affectedRows > 0;
}

module.exports = {
  createToken,
  verifyToken,
  listTokens,
  revokeToken,
  hashToken,
  generateTokenPair,
  ALLOWED_SCOPES,
};
