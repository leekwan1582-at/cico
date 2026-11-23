/**
 * @file Server-Sent Events (SSE) Real-Time Service
 * @description Manages active HTTP SSE client connections, heartbeat keep-alive pings,
 * and broadcasts price refreshes, trigger notifications, and KPI metrics.
 * @module services/sseService
 */

const EventEmitter = require("events");

class SSEEventEmitter extends EventEmitter {}
const sseEmitter = new SSEEventEmitter();

// Increase max listeners for multi-client connections
sseEmitter.setMaxListeners(200);

/**
 * Set of active client connection objects.
 * Each object holds: { id, userId, res, ip, connectedAt }
 * @type {Set<{ id: string, userId: number|null, res: import('express').Response, ip: string, connectedAt: Date }>}
 */
const activeClients = new Set();

/**
 * Timer ID for heartbeat ping interval.
 * @type {NodeJS.Timeout|null}
 */
let heartbeatInterval = null;

/**
 * Formats an SSE payload packet.
 *
 * @param {string} event - Event name (e.g. 'connected', 'price_update', 'alert_trigger', 'kpi_update').
 * @param {any} data - Data to JSON stringify into the data: line.
 * @returns {string} Formatted SSE payload string.
 */
function formatSSE(event, data) {
  const jsonStr = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${jsonStr}\n\n`;
}

/**
 * Starts the heartbeat timer if not already running.
 * Heartbeat sends a comment ping (`: ping\n\n`) every 25 seconds to avoid proxy timeouts.
 */
function ensureHeartbeat() {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    if (activeClients.size === 0) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      return;
    }

    const pingPacket = ": ping\n\n";
    for (const client of activeClients) {
      try {
        client.res.write(pingPacket);
      } catch (err) {
        removeClient(client.res);
      }
    }
  }, 25000);

  if (heartbeatInterval.unref) {
    heartbeatInterval.unref();
  }
}

/**
 * Registers a new SSE client response stream.
 *
 * @param {number|null} userId - Authenticated user ID or null.
 * @param {import('express').Request} req - Express request.
 * @param {import('express').Response} res - Express response.
 * @returns {{ id: string, userId: number|null }} Registered client info.
 */
function addClient(userId, req, res) {
  // Set required SSE HTTP headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disables response buffering in NGINX
  });

  // Flush headers if supported
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const clientObj = {
    id: clientId,
    userId: userId || null,
    res,
    ip: req.ip || req.socket?.remoteAddress || "127.0.0.1",
    connectedAt: new Date(),
  };

  activeClients.add(clientObj);

  // Send initial handshake event
  const welcomePayload = {
    clientId,
    status: "connected",
    activeClientsCount: activeClients.size,
    timestamp: new Date().toISOString(),
  };
  res.write(formatSSE("connected", welcomePayload));

  // Handle client disconnect / socket close
  req.on("close", () => {
    removeClient(res);
  });

  ensureHeartbeat();
  return { id: clientId, userId };
}

/**
 * Removes an SSE client by matching its Response object.
 *
 * @param {import('express').Response} res - Express response object.
 */
function removeClient(res) {
  for (const client of activeClients) {
    if (client.res === res) {
      activeClients.delete(client);
      try {
        if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // Safe ignore
      }
      break;
    }
  }

  if (activeClients.size === 0 && heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Broadcasts an SSE event to all connected clients (or clients matching userId).
 *
 * @param {string} event - Event name.
 * @param {any} data - Data to transmit.
 * @param {number|null} [targetUserId=null] - Optional specific user ID to target.
 * @returns {number} Count of clients that received the event.
 */
function broadcast(event, data, targetUserId = null) {
  if (activeClients.size === 0) return 0;

  const payload = formatSSE(event, data);
  let delivered = 0;

  for (const client of Array.from(activeClients)) {
    if (targetUserId && client.userId !== targetUserId) {
      continue;
    }

    try {
      client.res.write(payload);
      delivered++;
    } catch (err) {
      removeClient(client.res);
    }
  }

  return delivered;
}

/**
 * Broadcasts updated asset price list.
 *
 * @param {Array<{ symbol: string, price: number, source: string, change_24h_pct?: number }>} updatedAssets
 * @returns {number} Count of clients notified.
 */
function broadcastPriceUpdate(updatedAssets) {
  return broadcast("price_update", {
    assets: updatedAssets,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcasts alert trigger notifications.
 *
 * @param {Array<object>} triggeredAlerts - Array of triggered alert objects.
 * @returns {number} Count of clients notified.
 */
function broadcastAlertTrigger(triggeredAlerts) {
  return broadcast("alert_trigger", {
    alerts: triggeredAlerts,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcasts refreshed aggregate KPI summary.
 *
 * @param {{ totalPairs: number, activeAlerts: number, triggeredAlerts: number }} kpis
 * @returns {number} Count of clients notified.
 */
function broadcastKPIUpdate(kpis) {
  return broadcast("kpi_update", {
    kpis,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Returns current count of connected SSE clients.
 * @returns {number}
 */
function getConnectedClientsCount() {
  return activeClients.size;
}

/**
 * Resets active clients (useful for test tear-downs).
 */
function resetClients() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  for (const client of activeClients) {
    try {
      client.res.end();
    } catch {}
  }
  activeClients.clear();
}

module.exports = {
  addClient,
  removeClient,
  broadcast,
  broadcastPriceUpdate,
  broadcastAlertTrigger,
  broadcastKPIUpdate,
  formatSSE,
  getConnectedClientsCount,
  resetClients,
  sseEmitter,
};
