/**
 * @file Encryption Utility for Data At Rest
 * @description Provides AES-256-GCM authenticated encryption and decryption for sensitive notification targets
 * (e.g., Telegram bot chat IDs, private Discord webhook URLs, phone numbers, or private emails).
 * @module services/cryptoService
 */

const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const PREFIX = "enc:v1:";

/**
 * Derives a consistent 32-byte encryption key from ENCRYPTION_SECRET or JWT_SECRET.
 * @returns {Buffer}
 */
function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || "default_development_secret_32_bytes_key!";
  return crypto.createHash("sha256").update(String(secret)).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Formats output as: enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 * If input is already encrypted, null, or empty, returns input safely.
 *
 * @param {string} text - Raw sensitive string.
 * @returns {string} Encrypted cipher string or original.
 */
function encrypt(text) {
  if (!text || typeof text !== "string") return text;
  if (text.startsWith(PREFIX)) return text; // already encrypted

  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${PREFIX}${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM ciphertext created by encrypt().
 * If input is not encrypted or plaintext, returns input safely.
 *
 * @param {string} cipherText - Formatted encrypted string.
 * @returns {string} Decrypted plaintext string.
 */
function decrypt(cipherText) {
  if (!cipherText || typeof cipherText !== "string") return cipherText;
  if (!cipherText.startsWith(PREFIX)) return cipherText; // plaintext legacy

  try {
    const raw = cipherText.slice(PREFIX.length);
    const parts = raw.split(":");
    if (parts.length !== 3) return cipherText;

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const key = getEncryptionKey();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.warn("Notice: Decryption failed, returning raw value:", err.message);
    return cipherText;
  }
}

/**
 * Masks a sensitive notification target for display in UI / logs.
 * e.g. https://discord.com/api/webhooks/123/xyz -> https://discord.com/.../xyz
 * e.g. 123456789 -> 12***789
 * e.g. trader@example.com -> t***r@example.com
 *
 * @param {string} text - Plain or encrypted target.
 * @returns {string} Masked string.
 */
function maskTarget(text) {
  if (!text) return "";
  const plain = decrypt(text);
  if (!plain) return "";

  if (plain.startsWith("http://") || plain.startsWith("https://")) {
    try {
      const url = new URL(plain);
      const segments = url.pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1] || "";
      const maskedLast = last.length > 6 ? `${last.slice(0, 3)}...${last.slice(-3)}` : "***";
      return `${url.origin}/.../${maskedLast}`;
    } catch {
      return `${plain.slice(0, 15)}...`;
    }
  }

  if (plain.includes("@") && !plain.startsWith("@")) {
    const [user, domain] = plain.split("@");
    if (user.length <= 2) return `*@${domain}`;
    return `${user[0]}***${user[user.length - 1]}@${domain}`;
  }

  if (plain.length <= 4) return "****";
  return `${plain.slice(0, 2)}****${plain.slice(-2)}`;
}

module.exports = {
  encrypt,
  decrypt,
  maskTarget,
};
