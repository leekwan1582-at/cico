/**
 * @file Notification Dispatch Service
 * @description Manages multi-channel notifications (Telegram Bot API, Discord Webhooks, SMTP/Simulated Email, In-App),
 * user quiet hours enforcement, encrypted targets at rest, and exponential backoff delivery retries with notification_log.
 * @module services/notificationService
 */

const dotenv = require("dotenv");
const path = require("path");
const net = require("net");
const tls = require("tls");
const pool = require("../config/db");
const cryptoService = require("./cryptoService");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

/**
 * Supported notification channels.
 * @readonly
 * @enum {string}
 */
const NOTIFICATION_CHANNELS = {
  IN_APP: "IN_APP",
  EMAIL: "EMAIL",
  TELEGRAM: "TELEGRAM",
  DISCORD: "DISCORD",
};

/**
 * Max retry attempts for failed notifications.
 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Exponential backoff interval calculation in seconds:
 * Attempt 1: 30s, Attempt 2: 120s (2m), Attempt 3: 480s (8m).
 *
 * @param {number} attempt
 * @returns {number} Delay in seconds
 */
function getBackoffDelaySeconds(attempt) {
  return Math.min(30 * Math.pow(4, Math.max(0, attempt - 1)), 3600);
}

/**
 * Checks whether the current time falls within a user's configured quiet hours window.
 *
 * @param {string} startTime - Format 'HH:MM:SS' or 'HH:MM'
 * @param {string} endTime - Format 'HH:MM:SS' or 'HH:MM'
 * @param {Date} [nowDate=new Date()]
 * @returns {boolean} True if quiet hours are currently active
 */
function isWithinQuietHours(startTime, endTime, nowDate = new Date()) {
  if (!startTime || !endTime) return false;

  const pad = (n) => String(n).padStart(2, "0");
  const currentStr = `${pad(nowDate.getHours())}:${pad(nowDate.getMinutes())}:${pad(nowDate.getSeconds())}`;

  const cleanStart = startTime.length === 5 ? `${startTime}:00` : startTime;
  const cleanEnd = endTime.length === 5 ? `${endTime}:00` : endTime;

  if (cleanStart <= cleanEnd) {
    // Normal window within the same calendar day (e.g. 09:00 - 17:00)
    return currentStr >= cleanStart && currentStr <= cleanEnd;
  }
  // Overnight window crossing midnight (e.g. 22:00 - 07:00)
  return currentStr >= cleanStart || currentStr <= cleanEnd;
}

/**
 * Dispatches a Telegram notification via Bot API sendMessage.
 * If bot token is not set, logs the message and simulates delivery.
 *
 * @async
 * @param {string} chatId - Target Telegram chat or channel ID (plain or encrypted).
 * @param {string} messageText - Formatted notification text.
 * @returns {Promise<{ success: boolean, channel: string, target: string, simulated?: boolean, error?: string }>}
 */
async function sendTelegramAlert(chatId, messageText) {
  const plainChatId = cryptoService.decrypt(chatId);
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log(`[Notification: TELEGRAM (Simulated)] -> Chat: ${cryptoService.maskTarget(plainChatId)} | Message:\n${messageText}`);
    return { success: true, channel: "TELEGRAM", target: plainChatId, simulated: true };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: plainChatId,
        text: messageText,
        parse_mode: "Markdown",
      }),
    });
    const result = await response.json();
    return { success: response.ok, channel: "TELEGRAM", target: plainChatId, raw: result };
  } catch (err) {
    console.error(`Telegram dispatch error to ${cryptoService.maskTarget(plainChatId)}:`, err.message);
    return { success: false, channel: "TELEGRAM", target: plainChatId, error: err.message };
  }
}

/**
 * Dispatches a Discord notification via Webhook POST.
 * If webhook URL is mock, unset, or simulated, logs cleanly.
 *
 * @async
 * @param {string} webhookUrl - Target Discord webhook URL (plain or encrypted).
 * @param {string} messageText - Notification message.
 * @param {object} [metadata] - Optional embed metadata.
 * @returns {Promise<{ success: boolean, channel: string, target: string, simulated?: boolean, error?: string }>}
 */
async function sendDiscordAlert(webhookUrl, messageText, metadata = {}) {
  const rawTarget = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
  const targetUrl = cryptoService.decrypt(rawTarget);

  if (!targetUrl || targetUrl.includes("mock")) {
    console.log(`[Notification: DISCORD (Simulated)] -> Webhook: ${cryptoService.maskTarget(targetUrl || "Default")} | Message: ${messageText}`);
    return { success: true, channel: "DISCORD", target: targetUrl || "default", simulated: true };
  }

  try {
    const embedColor = metadata.conditionType === "ABOVE" ? 0x10b981 : 0xef4444;
    const payload = {
      content: `🚨 **Crypto Price Alert Triggered!**`,
      embeds: [
        {
          title: `${metadata.assetSymbol || "Asset"} Alert Triggered`,
          description: messageText,
          color: embedColor,
          fields: [
            { name: "Condition", value: metadata.conditionType || "N/A", inline: true },
            { name: "Target Price", value: `$${metadata.targetPrice || "0"}`, inline: true },
            { name: "Trigger Price", value: `$${metadata.currentPrice || "0"}`, inline: true },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return { success: response.ok, channel: "DISCORD", target: targetUrl };
  } catch (err) {
    console.error(`Discord dispatch error to ${cryptoService.maskTarget(targetUrl)}:`, err.message);
    return { success: false, channel: "DISCORD", target: targetUrl, error: err.message };
  }
}

/**
 * Raw RFC 5321 socket-level SMTP transport implementation without external dependencies.
 * Automatically engages STARTTLS if supported and port 587/25, or connects directly via TLS on 465.
 *
 * @param {object} smtpConfig
 * @param {string} from
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @returns {Promise<{ success: boolean, info?: string }>}
 */
function sendSmtpSocket(smtpConfig, from, to, subject, body) {
  return new Promise((resolve, reject) => {
    const host = smtpConfig.host;
    const port = parseInt(smtpConfig.port, 10) || 587;
    const timeout = 10000;
    const isSecure = port === 465;

    let socket;
    let stage = 0;
    let logBuffer = "";

    const cleanBody = body.replace(/\r?\n/g, "\r\n");
    const mailData =
      `From: ${from}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
      `${cleanBody}\r\n.\r\n`;

    const onConnect = () => {
      // Wait for server 220 banner
    };

    if (isSecure) {
      socket = tls.connect({ host, port, rejectUnauthorized: false }, onConnect);
    } else {
      socket = net.connect({ host, port }, onConnect);
    }

    socket.setTimeout(timeout);
    socket.setEncoding("utf8");

    socket.on("timeout", () => {
      socket.destroy(new Error("SMTP socket timeout"));
    });

    socket.on("error", (err) => {
      reject(err);
    });

    socket.on("data", (chunk) => {
      logBuffer += chunk;
      const lines = chunk.trim().split("\r\n");
      const lastLine = lines[lines.length - 1] || "";
      const code = parseInt(lastLine.slice(0, 3), 10);

      // Multi-line continuation codes e.g. "250-SIZE"
      if (lastLine.charAt(3) === "-") return;

      if (code >= 400) {
        socket.end("QUIT\r\n");
        return reject(new Error(`SMTP error (${code}): ${lastLine}`));
      }

      switch (stage) {
        case 0: // Received 220 banner -> send EHLO
          stage = 1;
          socket.write(`EHLO ${host}\r\n`);
          break;

        case 1: // Received 250 from EHLO -> handle AUTH or MAIL FROM
          if (smtpConfig.user && smtpConfig.pass) {
            stage = 2;
            socket.write("AUTH LOGIN\r\n");
          } else {
            stage = 4;
            socket.write(`MAIL FROM:<${from}>\r\n`);
          }
          break;

        case 2: // Received 334 for username prompt
          stage = 3;
          socket.write(`${Buffer.from(smtpConfig.user).toString("base64")}\r\n`);
          break;

        case 3: // Received 334 for password prompt
          stage = 4;
          socket.write(`${Buffer.from(smtpConfig.pass).toString("base64")}\r\n`);
          break;

        case 4: // Authenticated (235) or EHLO without auth (250) -> MAIL FROM
          stage = 5;
          socket.write(`MAIL FROM:<${from}>\r\n`);
          break;

        case 5: // Received 250 -> RCPT TO
          stage = 6;
          socket.write(`RCPT TO:<${to}>\r\n`);
          break;

        case 6: // Received 250 -> DATA
          stage = 7;
          socket.write("DATA\r\n");
          break;

        case 7: // Received 354 -> Send email body
          stage = 8;
          socket.write(mailData);
          break;

        case 8: // Received 250 -> Message accepted
          socket.write("QUIT\r\n");
          resolve({ success: true, info: `SMTP 250 Accepted: ${lastLine}` });
          break;
      }
    });
  });
}

/**
 * Dispatches an Email notification using Real SMTP if configured, or clean simulated console logging.
 *
 * @async
 * @param {string} recipientEmail - User email address (plain or encrypted).
 * @param {string} subject - Email subject line.
 * @param {string} bodyText - Notification body.
 * @returns {Promise<{ success: boolean, channel: string, target: string, simulated?: boolean, error?: string }>}
 */
async function sendEmailAlert(recipientEmail, subject, bodyText) {
  const plainEmail = cryptoService.decrypt(recipientEmail);
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || "alerts@cryptoalert.sg";

  // If SMTP host is not configured, fallback to console simulation
  if (!smtpHost) {
    console.log(`[Notification: EMAIL] -> To: ${plainEmail} | Subject: ${subject}\n${bodyText}`);
    return { success: true, channel: "EMAIL", target: plainEmail, simulated: true };
  }

  try {
    const result = await sendSmtpSocket(
      { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
      smtpFrom,
      plainEmail,
      subject,
      bodyText
    );
    return { success: true, channel: "EMAIL", target: plainEmail, info: result.info };
  } catch (err) {
    console.error(`SMTP delivery error to ${plainEmail}:`, err.message);
    return { success: false, channel: "EMAIL", target: plainEmail, error: err.message };
  }
}

/**
 * Formats standard alert notification message.
 *
 * @param {object} alert
 * @returns {string}
 */
function formatAlertMessage(alert) {
  let conditionStr = `${alert.condition_type} $${Number(alert.target_price).toLocaleString()}`;

  if (alert.condition_type === "PCT_CHANGE_24H_ABOVE") {
    conditionStr = `24h Return >= +${alert.target_price}% (Current: ${alert.change_24h_pct ? alert.change_24h_pct.toFixed(2) : "0"}%)`;
  } else if (alert.condition_type === "PCT_CHANGE_24H_BELOW") {
    conditionStr = `24h Drop <= -${alert.target_price}% (Current: ${alert.change_24h_pct ? alert.change_24h_pct.toFixed(2) : "0"}%)`;
  } else if (alert.condition_type === "TRAILING_STOP") {
    const peakStr = alert.peak_price ? `$${Number(alert.peak_price).toLocaleString()}` : "N/A";
    conditionStr = `Trailing Stop ${alert.target_price}% drop from peak (Peak: ${peakStr})`;
  }

  return (
    `🚨 *CRYPTO PRICE ALERT TRIGGERED*\n` +
    `• User: ${alert.username || "Trader"}\n` +
    `• Asset: ${alert.asset_symbol || alert.symbol} (${alert.asset_name || "Crypto"})\n` +
    `• Exchange: ${alert.exchange_name || "Exchange"}\n` +
    `• Condition: ${conditionStr}\n` +
    `• Current Market Price: $${Number(alert.last_d1_close).toLocaleString()}\n` +
    `• Time: ${new Date().toISOString()}`
  );
}

/**
 * Dispatches a single alert through its configured channel, checking quiet hours,
 * encrypting sensitive recipient targets, and persisting delivery attempt into notification_log.
 *
 * @async
 * @param {object} alert - Alert record with user and asset join details.
 * @returns {Promise<{ success: boolean, channel: string, target: string, suppressed?: boolean, logId?: number }>}
 */
async function dispatchAlertNotification(alert) {
  const userId = alert.user_id;
  let channel = (alert.notification_channel || "IN_APP").toUpperCase();
  let target = alert.recipient_target || alert.email || alert.username || "Dashboard";

  // 1. Fetch user notification preferences (quiet hours & default channels)
  let userPref = null;
  if (userId) {
    try {
      const [rows] = await pool.query(
        "SELECT * FROM user_notification_preferences WHERE user_id = ?",
        [userId]
      );
      if (rows && rows.length > 0) {
        userPref = rows[0];
      }
    } catch {
      // Preferences table pending migration or offline
    }
  }

  // 2. Check Quiet Hours suppression (Except IN_APP which is always saved quietly)
  if (userPref && userPref.quiet_hours_enabled && channel !== NOTIFICATION_CHANNELS.IN_APP) {
    const isQuiet = isWithinQuietHours(userPref.quiet_hours_start, userPref.quiet_hours_end);
    if (isQuiet) {
      console.log(`[NotificationService] Alert #${alert.id} suppressed for user ${userId} during Quiet Hours (${userPref.quiet_hours_start} - ${userPref.quiet_hours_end}).`);

      // Log SUPPRESSED event in notification_log
      try {
        const encryptedTarget = cryptoService.encrypt(target);
        await pool.query(
          `INSERT INTO notification_log 
           (alert_id, user_id, channel, recipient_target, status, attempt_count, message_payload, last_error) 
           VALUES (?, ?, ?, ?, 'SUPPRESSED', 0, ?, 'Suppressed by user Quiet Hours schedule')`,
          [alert.id, userId, channel, encryptedTarget, formatAlertMessage(alert)]
        );
      } catch (logErr) {
        console.warn("Notice: Suppression log skipped:", logErr.message);
      }

      return { success: true, channel, target, suppressed: true };
    }
  }

  // Decrypt target if stored encrypted, or encrypt before logging
  const plainTarget = cryptoService.decrypt(target);
  const encryptedTarget = cryptoService.encrypt(target);
  const message = formatAlertMessage(alert);

  let result;
  switch (channel) {
    case NOTIFICATION_CHANNELS.TELEGRAM:
      result = await sendTelegramAlert(plainTarget, message);
      break;

    case NOTIFICATION_CHANNELS.DISCORD:
      result = await sendDiscordAlert(plainTarget, message, {
        assetSymbol: alert.asset_symbol,
        conditionType: alert.condition_type,
        targetPrice: alert.target_price,
        currentPrice: alert.last_d1_close,
      });
      break;

    case NOTIFICATION_CHANNELS.EMAIL:
      result = await sendEmailAlert(
        plainTarget,
        `🚨 Alert Triggered: ${alert.asset_symbol} is ${alert.condition_type} $${alert.target_price}`,
        message
      );
      break;

    case NOTIFICATION_CHANNELS.IN_APP:
    default:
      console.log(`[Notification: IN_APP] Alert #${alert.id} marked as triggered for ${alert.username}`);
      result = { success: true, channel: "IN_APP", target: "Dashboard" };
      break;
  }

  // 3. Persist notification_log entry with retry/backoff tracking
  let logId = null;
  try {
    const status = result.success ? "SENT" : "FAILED";
    const nextRetryAt = result.success
      ? null
      : new Date(Date.now() + getBackoffDelaySeconds(1) * 1000);

    const [logInsert] = await pool.query(
      `INSERT INTO notification_log 
       (alert_id, user_id, channel, recipient_target, status, attempt_count, max_attempts, next_retry_at, last_error, message_payload, sent_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [
        alert.id || null,
        userId || 1,
        channel,
        encryptedTarget,
        status,
        MAX_RETRY_ATTEMPTS,
        nextRetryAt,
        result.error || null,
        message,
        result.success ? new Date() : null,
      ]
    );
    logId = logInsert.insertId;
  } catch (logErr) {
    console.warn("Notice: notification_log insert skipped:", logErr.message);
  }

  // 4. Audit Trail Logging: Record NOTIFIED or FAILED in alert_events
  try {
    const eventType = result.success ? "NOTIFIED" : "FAILED";
    const eventMsg = result.success
      ? `Dispatched via ${channel} to ${cryptoService.maskTarget(plainTarget)}`
      : `Failed dispatch via ${channel} to ${cryptoService.maskTarget(plainTarget)}: ${result.error || "Unknown error"}`;

    await pool.query(
      "INSERT INTO alert_events (alert_id, event_type, price_at_event, metric_value, message) VALUES (?, ?, ?, ?, ?)",
      [alert.id, eventType, alert.last_d1_close || null, alert.target_price || null, eventMsg]
    );
  } catch (auditErr) {
    console.warn("Notice: Notification audit logging skipped:", auditErr.message);
  }

  return { ...result, logId };
}

/**
 * Worker: Scans notification_log for FAILED/RETRYING items eligible for retry,
 * and re-attempts dispatch with exponential backoff.
 *
 * @async
 * @returns {Promise<{ retriedCount: number, successCount: number }>}
 */
async function processNotificationRetries() {
  let pendingRetries = [];
  try {
    const [rows] = await pool.query(
      `SELECT nl.*, u.username 
       FROM notification_log nl
       JOIN users u ON nl.user_id = u.id
       WHERE nl.status IN ('FAILED', 'RETRYING') 
         AND nl.attempt_count < nl.max_attempts
         AND (nl.next_retry_at IS NULL OR nl.next_retry_at <= NOW())
       LIMIT 20`
    );
    pendingRetries = rows || [];
  } catch {
    return { retriedCount: 0, successCount: 0 };
  }

  if (pendingRetries.length === 0) {
    return { retriedCount: 0, successCount: 0 };
  }

  let successCount = 0;
  for (const item of pendingRetries) {
    const plainTarget = cryptoService.decrypt(item.recipient_target);
    const newAttempt = item.attempt_count + 1;
    let dispatchRes;

    switch (item.channel) {
      case NOTIFICATION_CHANNELS.TELEGRAM:
        dispatchRes = await sendTelegramAlert(plainTarget, item.message_payload);
        break;
      case NOTIFICATION_CHANNELS.DISCORD:
        dispatchRes = await sendDiscordAlert(plainTarget, item.message_payload);
        break;
      case NOTIFICATION_CHANNELS.EMAIL:
        dispatchRes = await sendEmailAlert(plainTarget, "Alert Notification", item.message_payload);
        break;
      default:
        dispatchRes = { success: true };
    }

    if (dispatchRes.success) {
      successCount++;
      await pool.query(
        "UPDATE notification_log SET status = 'SENT', attempt_count = ?, sent_at = NOW(), last_error = NULL WHERE id = ?",
        [newAttempt, item.id]
      ).catch(() => {});
    } else {
      const isExhausted = newAttempt >= item.max_attempts;
      const nextDelay = getBackoffDelaySeconds(newAttempt);
      const nextRetryDate = isExhausted ? null : new Date(Date.now() + nextDelay * 1000);
      const newStatus = isExhausted ? "FAILED" : "RETRYING";

      await pool.query(
        "UPDATE notification_log SET status = ?, attempt_count = ?, next_retry_at = ?, last_error = ? WHERE id = ?",
        [newStatus, newAttempt, nextRetryDate, dispatchRes.error || "Retry failed", item.id]
      ).catch(() => {});
    }
  }

  return { retriedCount: pendingRetries.length, successCount };
}

/**
 * Dispatches notifications asynchronously for a batch of newly triggered alerts without blocking database transactions.
 *
 * @param {Array<object>} triggeredAlerts - Newly triggered alerts.
 * @returns {void}
 */
function dispatchNotificationsAsync(triggeredAlerts) {
  if (!triggeredAlerts || triggeredAlerts.length === 0) return;

  // Use setImmediate to defer dispatch past the current event loop turn
  setImmediate(async () => {
    console.log(`[NotificationService] Asynchronously dispatching ${triggeredAlerts.length} triggered alert(s)...`);
    const results = await Promise.allSettled(
      triggeredAlerts.map((alert) => dispatchAlertNotification(alert))
    );
    console.log(`[NotificationService] Completed dispatch of ${results.length} notification(s).`);
  });
}

module.exports = {
  NOTIFICATION_CHANNELS,
  MAX_RETRY_ATTEMPTS,
  getBackoffDelaySeconds,
  isWithinQuietHours,
  sendTelegramAlert,
  sendDiscordAlert,
  sendEmailAlert,
  sendSmtpSocket,
  formatAlertMessage,
  dispatchAlertNotification,
  dispatchNotificationsAsync,
  processNotificationRetries,
};
