/**
 * @file Chart Configuration Utility
 * @description Parses and validates candlestick chart timeframe settings from environment variables (.env).
 * Provides supported timeframes (e.g. 7D, 30D, 180D) and default timeframe (e.g. 7D).
 * @module config/chartConfig
 */

const dotenv = require("dotenv");
const path = require("path");

// Ensure environment variables are loaded
dotenv.config({ path: path.join(__dirname, "..", ".env") });

/**
 * Parses a timeframe token string like "7D", "30d", "180" into day count number and clean label.
 *
 * @param {string} token - e.g. "7D", "30", "180d".
 * @returns {{ days: number, label: string }|null}
 */
function parseTimeframeToken(token) {
  if (!token || typeof token !== "string") return null;
  const trimmed = token.trim();
  const match = trimmed.match(/^(\d+)[dD]?$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  if (isNaN(days) || days <= 0) return null;
  return {
    days,
    label: `${days}D`,
  };
}

/**
 * Retrieves the list of supported chart timeframes parsed from CHART_SUPPORTED_TIMEFRAMES in .env.
 * Defaults to ['7D', '30D', '180D'].
 *
 * @returns {Array<{ days: number, label: string }>} List of valid timeframe objects.
 */
function getSupportedTimeframes() {
  const rawEnv = process.env.CHART_SUPPORTED_TIMEFRAMES || "7D,30D,180D";
  const tokens = rawEnv
    .split(",")
    .map((s) => parseTimeframeToken(s))
    .filter(Boolean);

  if (tokens.length === 0) {
    return [
      { days: 7, label: "7D" },
      { days: 30, label: "30D" },
      { days: 180, label: "180D" },
    ];
  }
  return tokens;
}

/**
 * Retrieves default timeframe days parsed from CHART_DEFAULT_TIMEFRAME in .env.
 * Defaults to 7 if missing or invalid.
 *
 * @returns {number} Default days (e.g. 7).
 */
function getDefaultTimeframeDays() {
  const rawEnv = process.env.CHART_DEFAULT_TIMEFRAME || "7D";
  const parsed = parseTimeframeToken(rawEnv);
  const supported = getSupportedTimeframes();

  if (parsed && supported.some((item) => item.days === parsed.days)) {
    return parsed.days;
  }
  return supported[0].days;
}

/**
 * Checks if a requested day count is supported.
 *
 * @param {number} days - Requested days count.
 * @returns {boolean} True if supported.
 */
function isTimeframeSupported(days) {
  const supported = getSupportedTimeframes();
  return supported.some((item) => item.days === days);
}

module.exports = {
  parseTimeframeToken,
  getSupportedTimeframes,
  getDefaultTimeframeDays,
  isTimeframeSupported,
};
