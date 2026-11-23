/**
 * @file Client-Side Real-Time Dashboard Controller (SSE)
 * @description Manages Server-Sent Events (/api/stream) connection lifecycle,
 * live price patching, alert status transitions, toast notifications,
 * and an interactive On/Off toggle switch persisted in localStorage.
 */

(function () {
  const STORAGE_KEY = "crypto_realtime_sync_enabled";
  let eventSource = null;
  let isEnabled = true;

  // Retrieve user preference from localStorage (defaults to true)
  const storedPreference = localStorage.getItem(STORAGE_KEY);
  if (storedPreference !== null) {
    isEnabled = storedPreference === "true";
  }

  // DOM Elements
  const toggleBtn = document.querySelector("#toggleRealtimeSync");
  const statusBadge = document.querySelector("#realtimeStatusBadge");
  const statusText = document.querySelector("#realtimeStatusText");
  const statusDot = document.querySelector("#realtimeStatusDot");

  /**
   * Updates visual status indicators across the UI.
   *
   * @param {"connected"|"connecting"|"paused"|"disconnected"} state
   */
  function updateUIState(state) {
    if (!statusBadge) return;

    statusBadge.classList.remove(
      "border-success",
      "text-success",
      "border-warning",
      "text-warning",
      "border-secondary",
      "text-secondary",
      "border-danger",
      "text-danger"
    );

    if (state === "connected") {
      statusBadge.classList.add("border-success", "text-success");
      if (statusText) statusText.textContent = "Live Sync: Active";
      if (statusDot) statusDot.className = "spinner-grow spinner-grow-sm text-success me-1";
      if (toggleBtn) {
        toggleBtn.classList.remove("btn-outline-secondary");
        toggleBtn.classList.add("btn-outline-success", "active");
        toggleBtn.setAttribute("aria-pressed", "true");
        toggleBtn.title = "Click to Pause Live Sync";
      }
    } else if (state === "connecting") {
      statusBadge.classList.add("border-warning", "text-warning");
      if (statusText) statusText.textContent = "Live Sync: Connecting...";
      if (statusDot) statusDot.className = "spinner-border spinner-border-sm text-warning me-1";
    } else if (state === "paused") {
      statusBadge.classList.add("border-secondary", "text-secondary");
      if (statusText) statusText.textContent = "Live Sync: Paused";
      if (statusDot) statusDot.className = "badge bg-secondary rounded-circle p-1 me-1";
      if (toggleBtn) {
        toggleBtn.classList.remove("btn-outline-success", "active");
        toggleBtn.classList.add("btn-outline-secondary");
        toggleBtn.setAttribute("aria-pressed", "false");
        toggleBtn.title = "Click to Enable Live Sync";
      }
    } else if (state === "disconnected") {
      statusBadge.classList.add("border-danger", "text-danger");
      if (statusText) statusText.textContent = "Live Sync: Disconnected";
      if (statusDot) statusDot.className = "badge bg-danger rounded-circle p-1 me-1";
    }
  }

  /**
   * Initializes or connects the EventSource stream.
   */
  function startStream() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    if (!isEnabled) {
      updateUIState("paused");
      return;
    }

    updateUIState("connecting");

    try {
      eventSource = new EventSource("/api/stream");

      eventSource.addEventListener("connected", (event) => {
        updateUIState("connected");
      });

      eventSource.addEventListener("price_update", (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && Array.isArray(payload.assets)) {
            handlePriceUpdates(payload.assets);
          }
        } catch (e) {
          console.warn("SSE parse error (price_update):", e);
        }
      });

      eventSource.addEventListener("alert_trigger", (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && Array.isArray(payload.alerts)) {
            handleAlertTriggers(payload.alerts);
          }
        } catch (e) {
          console.warn("SSE parse error (alert_trigger):", e);
        }
      });

      eventSource.addEventListener("kpi_update", (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && payload.kpis) {
            handleKPIUpdates(payload.kpis);
          }
        } catch (e) {
          console.warn("SSE parse error (kpi_update):", e);
        }
      });

      eventSource.onerror = () => {
        // EventSource will auto-reconnect; reflect connecting/disconnected state
        if (eventSource && eventSource.readyState === EventSource.CONNECTING) {
          updateUIState("connecting");
        } else {
          updateUIState("disconnected");
        }
      };
    } catch (err) {
      console.error("Failed to establish SSE connection:", err);
      updateUIState("disconnected");
    }
  }

  /**
   * Closes the active EventSource stream.
   */
  function stopStream() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    updateUIState("paused");
  }

  /**
   * Toggles the real-time live sync state on or off.
   */
  function toggleSync() {
    isEnabled = !isEnabled;
    localStorage.setItem(STORAGE_KEY, String(isEnabled));
    if (isEnabled) {
      startStream();
      showToast("Live Sync Enabled", "Streaming real-time crypto prices & alerts", "success");
    } else {
      stopStream();
      showToast("Live Sync Paused", "Real-time updates paused to save bandwidth", "secondary");
    }
  }

  /**
   * Patches updated asset prices and 24h percentage changes in the DOM.
   *
   * @param {Array<{ symbol: string, price: number, change_24h_pct?: number }>} assets
   */
  function handlePriceUpdates(assets) {
    assets.forEach((asset) => {
      // Look for DOM elements with data-asset-symbol
      const priceEls = document.querySelectorAll(`[data-asset-symbol="${asset.symbol}"]`);
      priceEls.forEach((el) => {
        const formattedPrice = `$${Number(asset.price).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        })}`;

        // Flash green/red animation class
        const prevPriceText = el.textContent.replace(/[^0-9.]/g, "");
        const prevVal = parseFloat(prevPriceText);
        el.textContent = formattedPrice;

        if (!isNaN(prevVal) && prevVal !== asset.price) {
          const flashClass = asset.price >= prevVal ? "bg-success-subtle" : "bg-danger-subtle";
          el.classList.add(flashClass);
          setTimeout(() => el.classList.remove(flashClass), 1500);
        }
      });

      // Update 24h change pill if present
      if (asset.change_24h_pct !== undefined || asset.change24hPct !== undefined) {
        const rawPct = asset.change_24h_pct !== undefined ? asset.change_24h_pct : asset.change24hPct;
        const changeEls = document.querySelectorAll(`[data-change-symbol="${asset.symbol}"]`);
        changeEls.forEach((el) => {
          const pct = parseFloat(rawPct) || 0;
          const isPos = pct >= 0;
          el.className = `small fw-bold ${isPos ? "text-success" : "text-danger"}`;
          el.textContent = `${isPos ? "+" : ""}${pct.toFixed(2)}%`;
        });
      }

      // Update card Synced timestamp
      const syncEls = document.querySelectorAll(`[data-synced-symbol="${asset.symbol}"]`);
      syncEls.forEach((el) => {
        const ts = asset.last_updated ? new Date(asset.last_updated) : new Date();
        const yyyy = ts.getFullYear();
        const mm = String(ts.getMonth() + 1).padStart(2, "0");
        const dd = String(ts.getDate()).padStart(2, "0");
        const hh = String(ts.getHours()).padStart(2, "0");
        const min = String(ts.getMinutes()).padStart(2, "0");
        const ss = String(ts.getSeconds()).padStart(2, "0");
        el.textContent = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
      });
    });
  }

  /**
   * Handles newly triggered alerts in the UI.
   *
   * @param {Array<object>} alerts
   */
  function handleAlertTriggers(alerts) {
    alerts.forEach((alt) => {
      // Display floating notification toast
      const symbol = alt.symbol || "Crypto";
      const target = Number(alt.target_price).toLocaleString();
      const current = Number(alt.last_d1_close || alt._triggerMetricVal || 0).toLocaleString();
      const title = `🚨 Alert Triggered: ${symbol}`;
      const msg = `${alt.condition_type} $${target} met at current $${current}!`;
      showToast(title, msg, "danger");

      // Mark row in alerts table if visible
      const rowEl = document.querySelector(`tr[data-alert-id="${alt.id}"]`);
      if (rowEl) {
        rowEl.classList.add("table-danger");
        const statusBadgeEl = rowEl.querySelector(".alert-status-badge");
        if (statusBadgeEl) {
          statusBadgeEl.className = "badge bg-danger alert-status-badge";
          statusBadgeEl.textContent = "TRIGGERED";
        }
      }
    });
  }

  /**
   * Updates KPI summary counts in the KPI ribbon.
   *
   * @param {{ totalPairs?: number, activeAlerts?: number, triggeredAlerts?: number }} kpis
   */
  function handleKPIUpdates(kpis) {
    if (kpis.triggeredAlerts !== undefined) {
      const el = document.querySelector("#kpiTriggeredAlerts");
      if (el) el.textContent = kpis.triggeredAlerts;
    }
    if (kpis.activeAlerts !== undefined) {
      const el = document.querySelector("#kpiActiveAlerts");
      if (el) el.textContent = kpis.activeAlerts;
    }
    if (kpis.totalPairs !== undefined) {
      const el = document.querySelector("#kpiTotalPairs");
      if (el) el.textContent = kpis.totalPairs;
    }
  }

  /**
   * Displays an interactive Bootstrap 5 Toast notification.
   *
   * @param {string} title - Toast heading.
   * @param {string} message - Toast body text.
   * @param {"success"|"danger"|"secondary"|"info"} [theme="info"] - Bootstrap color.
   */
  function showToast(title, message, theme = "info") {
    let container = document.querySelector("#realtimeToastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "realtimeToastContainer";
      container.className = "toast-container position-fixed bottom-0 end-0 p-3";
      container.style.zIndex = "1090";
      document.body.appendChild(container);
    }

    const toastEl = document.createElement("div");
    toastEl.className = `toast align-items-center text-bg-${theme} border-0 shadow`;
    toastEl.setAttribute("role", "alert");
    toastEl.setAttribute("aria-live", "assertive");
    toastEl.setAttribute("aria-atomic", "true");
    toastEl.innerHTML = `
      <div class="d-flex">
        <div class="toast-body">
          <strong>${title}</strong><br>
          <small>${message}</small>
        </div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
    `;

    container.appendChild(toastEl);
    if (typeof bootstrap !== "undefined" && bootstrap.Toast) {
      const bsToast = new bootstrap.Toast(toastEl, { delay: 6000 });
      bsToast.show();
      toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
    } else {
      setTimeout(() => toastEl.remove(), 6000);
    }
  }

  // Bind toggle click event
  if (toggleBtn) {
    toggleBtn.addEventListener("click", toggleSync);
  }

  // Initialize on page load
  document.addEventListener("DOMContentLoaded", () => {
    if (isEnabled) {
      startStream();
    } else {
      updateUIState("paused");
    }
  });

  // Expose global controller for testing or manual triggers
  window.CryptoRealtime = {
    startStream,
    stopStream,
    toggleSync,
    isEnabled: () => isEnabled,
  };
})();
