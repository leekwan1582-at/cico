/**
 * @file Authentication & Token Service
 * @description Provides secure password hashing via native Node.js crypto.scrypt,
 * constant-time verification, and cryptographic HMAC-SHA256 JWT tokens.
 * @module services/authService
 */

const crypto = require("crypto");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const JWT_SECRET = process.env.JWT_SECRET || process.env.TOKEN_SECRET || "default_dev_fallback_secret_key_32_chars";
const JWT_EXPIRES_IN_HOURS = parseInt(process.env.JWT_EXPIRES_IN_HOURS || "24", 10);

/**
 * Encodes an object or string to URL-safe Base64 without padding.
 * @param {string|Buffer} input
 * @returns {string}
 */
function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Decodes URL-safe Base64 to string.
 * @param {string} input
 * @returns {string}
 */
function base64UrlDecode(input) {
  let str = input.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4 !== 0) {
    str += "=";
  }
  return Buffer.from(str, "base64").toString("utf8");
}

/**
 * Hashes a plaintext password using native crypto.scrypt with a unique random salt.
 *
 * @async
 * @param {string} password - Plaintext password.
 * @returns {Promise<{ hash: string, salt: string }>}
 */
async function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve({
        hash: derivedKey.toString("hex"),
        salt,
      });
    });
  });
}

/**
 * Verifies a plaintext password against a stored hash and salt using timing-safe comparison.
 *
 * @async
 * @param {string} password - Plaintext password candidate.
 * @param {string} storedHash - Stored hex hash.
 * @param {string} storedSalt - Stored hex salt.
 * @returns {Promise<boolean>} True if valid, false otherwise.
 */
async function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  return new Promise((resolve) => {
    crypto.scrypt(password, storedSalt, 64, (err, derivedKey) => {
      if (err) return resolve(false);
      try {
        const keyBuffer = derivedKey;
        const hashBuffer = Buffer.from(storedHash, "hex");
        if (keyBuffer.length !== hashBuffer.length) {
          return resolve(false);
        }
        const matches = crypto.timingSafeEqual(keyBuffer, hashBuffer);
        resolve(matches);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Generates a signed, URL-safe JWT token.
 *
 * @param {object} payload - Custom claims (e.g., { id, username, email }).
 * @param {number} [expiresInHours=24] - Token validity duration in hours.
 * @returns {string} Encoded JWT token string: `Header.Payload.Signature`.
 */
function generateToken(payload, expiresInHours = JWT_EXPIRES_IN_HOURS) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expiresInHours * 3600;

  const fullPayload = {
    ...payload,
    iat: now,
    exp,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(dataToSign)
    .digest();

  const encodedSignature = base64UrlEncode(signature);
  return `${dataToSign}.${encodedSignature}`;
}

/**
 * Verifies and decodes a JWT token.
 *
 * @param {string} token - The raw JWT token string.
 * @returns {object|null} Decoded payload if signature and expiry are valid, or null.
 */
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(dataToSign)
    .digest();
  const expectedEncodedSig = base64UrlEncode(expectedSignature);

  try {
    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(encodedSignature),
      Buffer.from(expectedEncodedSig)
    );
    if (!isSignatureValid) return null;

    const payloadJson = base64UrlDecode(encodedPayload);
    const payload = JSON.parse(payloadJson);

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  JWT_SECRET,
};
