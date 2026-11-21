/**
 * @file Background Cron Scheduler Service
 * @description Manages automated price synchronization schedules (e.g. daily close at 00:00 UTC
 * and periodic intervals such as hourly) using a robust native Node.js scheduler with optional node-cron support.
 * @module services/schedulerService
 */

const dotenv = require("dotenv");
const path = require("path");
const priceService = require("./priceService");
const notificationService = require("./notificationService");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

/**
 * Scheduler state tracking.
 */
let isRunning = false;
let lastSyncTime = null;
let nextSyncTime = null;
let lastSyncResult = null;
let timerHandle = null;

/**
 * Calculates milliseconds remaining until the next UTC midnight (00:00:00 UTC).
 * @returns {number} Milliseconds to next UTC midnight.
 */
function getMsUntilNextUtcMidnight() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return nextMidnight.getTime() - now.getTime();
}

/**
 * Runs a single scheduled price synchronization cycle.
 *
 * @async
 * @returns {Promise<object>} Result of price refresh.
 */
async function executeScheduledSync() {
  console.log(`[Scheduler] [${new Date().toISOString()}] Executing scheduled automated price refresh...`);
  try {
    const result = await priceService.refreshAllPrices();

    // Process pending failed notification retries (Phase 8+ 3.3 Reliability Layer)
    await notificationService.processNotificationRetries().catch((retErr) => {
      console.warn("Notice: Notification retry pass error:", retErr.message);
    });

    lastSyncTime = new Date().toISOString();
    lastSyncResult = {
      success: true,
      sourceUsed: result.sourceUsed,
      updatedAssetsCount: result.updatedAssets?.length || 0,
      triggeredCount: result.triggeredCount,
      notificationsDispatched: result.notificationsDispatched || 0,
    };
    console.log(`[Scheduler] Automated sync succeeded: ${lastSyncResult.updatedAssetsCount} assets updated via ${lastSyncResult.sourceUsed}`);
    return lastSyncResult;
  } catch (err) {
    lastSyncTime = new Date().toISOString();
    lastSyncResult = {
      success: false,
      error: err.message,
    };
    console.error(`[Scheduler] Automated sync failed:`, err.message);
    throw err;
  }
}

/**
 * Starts the automated price polling scheduler.
 * Configured via .env:
 * - CRON_ENABLED: "true" (default) or "false"
 * - CRON_SCHEDULE_TYPE: "HOURLY" (every hour) or "DAILY_UTC_MIDNIGHT" (00:00 UTC) or "INTERVAL"
 * - CRON_INTERVAL_MINUTES: Interval in minutes (default 60)
 */
function startScheduler() {
  const enabled = (process.env.CRON_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) {
    console.log("[Scheduler] Automated cron polling is disabled via CRON_ENABLED=false.");
    return { isRunning: false, reason: "disabled" };
  }

  if (isRunning) {
    return { isRunning: true, reason: "already_running" };
  }

  const scheduleType = (process.env.CRON_SCHEDULE_TYPE || "HOURLY").toUpperCase();
  const intervalMinutes = parseInt(process.env.CRON_INTERVAL_MINUTES, 10) || 60;
  const intervalMs = intervalMinutes * 60 * 1000;

  isRunning = true;

  if (scheduleType === "DAILY_UTC_MIDNIGHT") {
    // Schedule for next 00:00 UTC
    const delay = getMsUntilNextUtcMidnight();
    nextSyncTime = new Date(Date.now() + delay).toISOString();
    console.log(`[Scheduler] Configured for DAILY 00:00 UTC market close. Next run in ${(delay / 1000 / 60).toFixed(1)} mins at ${nextSyncTime}`);

    timerHandle = setTimeout(async function runUtcMidnightCycle() {
      await executeScheduledSync().catch(() => {});
      // Repeat daily (24 hours)
      const nextDelay = getMsUntilNextUtcMidnight();
      nextSyncTime = new Date(Date.now() + nextDelay).toISOString();
      timerHandle = setTimeout(runUtcMidnightCycle, nextDelay);
    }, delay);
  } else {
    // Interval or Hourly polling (default 60 minutes)
    nextSyncTime = new Date(Date.now() + intervalMs).toISOString();
    console.log(`[Scheduler] Configured for recurring interval every ${intervalMinutes} minute(s). Next run at ${nextSyncTime}`);

    timerHandle = setInterval(async () => {
      await executeScheduledSync().catch(() => {});
      nextSyncTime = new Date(Date.now() + intervalMs).toISOString();
    }, intervalMs);
  }

  return {
    isRunning: true,
    scheduleType,
    nextSyncTime,
  };
}

/**
 * Stops the automated scheduler.
 */
function stopScheduler() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    clearInterval(timerHandle);
    timerHandle = null;
  }
  isRunning = false;
  nextSyncTime = null;
  console.log("[Scheduler] Automated scheduler stopped.");
}

/**
 * Returns current scheduler status metadata.
 */
function getSchedulerStatus() {
  return {
    isRunning,
    lastSyncTime,
    nextSyncTime,
    lastSyncResult,
    scheduleType: process.env.CRON_SCHEDULE_TYPE || "HOURLY",
    intervalMinutes: parseInt(process.env.CRON_INTERVAL_MINUTES, 10) || 60,
  };
}

module.exports = {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
  executeScheduledSync,
  getMsUntilNextUtcMidnight,
};
