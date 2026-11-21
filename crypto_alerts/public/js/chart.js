/**
 * @file Client-Side ApexCharts 8.8.1 Controller
 * @description Manages candlestick chart rendering, timeframe toggling (7D/30D),
 * multi-exchange selection, price alert Y-axis annotations, and dynamic dark/light theme switching.
 */

(function () {
  let chartInstance = null;
  let currentAssetId = null;
  let currentExchangeId = 1;
  let currentDays = 7; // Fallback default, updated from active button below

  const chartContainer = document.querySelector("#apexCandleChart");
  const assetSelect = document.querySelector("#chartAssetSelect");
  const exchangeSelect = document.querySelector("#chartExchangeSelect");
  const timeframeButtons = document.querySelectorAll("[data-days]");
  const reloadBtn = document.querySelector("#chartReloadBtn");
  const loadingIndicator = document.querySelector("#chartLoadingIndicator");

  // Read initial default days from the server-rendered active button
  const initialActiveBtn = document.querySelector("[data-days].active");
  if (initialActiveBtn) {
    const parsedDays = parseInt(initialActiveBtn.getAttribute("data-days"), 10);
    if (!isNaN(parsedDays)) {
      currentDays = parsedDays;
    }
  }

  if (!chartContainer) return;

  /**
   * Determine current Bootstrap theme mode (dark vs light).
   * @returns {"dark"|"light"}
   */
  function getThemeMode() {
    return document.documentElement.getAttribute("data-bs-theme") === "dark" ? "dark" : "light";
  }

  /**
   * Fetches candlestick series and active alerts from backend API.
   *
   * @async
   * @param {number} assetId
   * @param {number} exchangeId
   * @param {number} days
   */
  async function loadAndRenderChart(assetId, exchangeId, days) {
    if (!assetId) return;

    if (loadingIndicator) loadingIndicator.classList.remove("d-none");

    try {
      const url = `/api/assets/${assetId}/chart-data?exchange_id=${exchangeId}&days=${days}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load chart data (${response.status})`);
      }
      const data = await response.json();

      // Transform alert targets into ApexCharts Y-Axis annotations
      const yaxisAnnotations = (data.annotations || []).map((alert) => {
        const isAbove = alert.condition_type === "ABOVE" || alert.condition_type === "PCT_CHANGE_24H_ABOVE";
        const color = isAbove ? "#10b981" : "#ef4444";
        return {
          y: alert.target_price,
          borderColor: color,
          strokeDashArray: 4,
          label: {
            borderColor: color,
            style: {
              color: "#ffffff",
              background: color,
              fontSize: "11px",
              fontWeight: 600,
            },
            text: alert.label || `${alert.condition_type} $${Number(alert.target_price).toLocaleString()}`,
          },
        };
      });

      // Transform historical TRIGGERED events into ApexCharts Point Annotations (Phase 8+ 3.2)
      const pointAnnotations = (data.triggerEvents || []).map((evt) => {
        const dateStr = evt.dateStr || new Date(evt.timestamp).toISOString().slice(0, 10);
        return {
          x: new Date(dateStr).getTime(),
          y: evt.price || evt.metricValue,
          marker: {
            size: 6,
            fillColor: "#ef4444",
            strokeColor: "#ffffff",
            strokeWidth: 2,
            shape: "circle",
          },
          label: {
            borderColor: "#ef4444",
            offsetY: 0,
            style: {
              color: "#ffffff",
              background: "#ef4444",
              fontSize: "10px",
              fontWeight: 700,
            },
            text: `🎯 TRIGGER: $${Number(evt.price).toLocaleString()}`,
          },
        };
      });

      const isDark = getThemeMode() === "dark";

      const chartOptions = {
        series: [
          {
            name: "D1 Candle",
            data: data.series || [],
          },
        ],
        chart: {
          type: "candlestick",
          height: 350,
          toolbar: {
            show: true,
            tools: {
              download: true,
              zoom: true,
              zoomin: true,
              zoomout: true,
              pan: true,
              reset: true,
            },
          },
          background: "transparent",
        },
        plotOptions: {
          candlestick: {
            colors: {
              upward: "#10b981",   // Green for bullish candle
              downward: "#ef4444", // Red for bearish candle
            },
            wick: {
              useFillColor: true,
            },
          },
        },
        title: {
          text: `${data.asset.symbol} on ${data.exchange.display_name} (${days}D Daily Candles)`,
          align: "left",
          style: {
            fontSize: "14px",
            fontWeight: 600,
            color: isDark ? "#f1f5f9" : "#1e293b",
          },
        },
        annotations: {
          yaxis: yaxisAnnotations,
          points: pointAnnotations,
        },
        xaxis: {
          type: "datetime",
          labels: {
            datetimeUTC: false,
            style: {
              colors: isDark ? "#94a3b8" : "#64748b",
            },
          },
        },
        yaxis: {
          tooltip: { enabled: true },
          labels: {
            formatter: (val) => `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            style: {
              colors: isDark ? "#94a3b8" : "#64748b",
            },
          },
        },
        grid: {
          borderColor: isDark ? "#334155" : "#e2e8f0",
        },
        theme: {
          mode: isDark ? "dark" : "light",
        },
        noData: {
          text: "No historical candle data found",
          style: {
            color: isDark ? "#94a3b8" : "#64748b",
            fontSize: "14px",
          },
        },
      };

      if (chartInstance) {
        chartInstance.destroy();
      }

      if (typeof ApexCharts !== "undefined") {
        chartInstance = new ApexCharts(chartContainer, chartOptions);
        await chartInstance.render();
      }
    } catch (err) {
      console.error("Error rendering chart:", err);
    } finally {
      if (loadingIndicator) loadingIndicator.classList.add("d-none");
    }
  }

  // Initial event bindings
  if (assetSelect) {
    currentAssetId = parseInt(assetSelect.value, 10);
    assetSelect.addEventListener("change", (e) => {
      currentAssetId = parseInt(e.target.value, 10);
      loadAndRenderChart(currentAssetId, currentExchangeId, currentDays);
    });
  }

  if (exchangeSelect) {
    currentExchangeId = parseInt(exchangeSelect.value, 10);
    exchangeSelect.addEventListener("change", (e) => {
      currentExchangeId = parseInt(e.target.value, 10);
      loadAndRenderChart(currentAssetId, currentExchangeId, currentDays);
    });
  }

  timeframeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      timeframeButtons.forEach((b) => {
        b.classList.remove("btn-primary", "active");
        b.classList.add("btn-outline-secondary");
      });
      btn.classList.remove("btn-outline-secondary");
      btn.classList.add("btn-primary", "active");

      currentDays = parseInt(btn.getAttribute("data-days"), 10) || 30;
      loadAndRenderChart(currentAssetId, currentExchangeId, currentDays);
    });
  });

  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      loadAndRenderChart(currentAssetId, currentExchangeId, currentDays);
    });
  }

  // Observe theme changes on <html> to update chart palette seamlessly
  const observer = new MutationObserver(() => {
    if (chartInstance) {
      const mode = getThemeMode();
      const isDark = mode === "dark";
      chartInstance.updateOptions({
        theme: { mode },
        grid: { borderColor: isDark ? "#334155" : "#e2e8f0" },
        xaxis: { labels: { style: { colors: isDark ? "#94a3b8" : "#64748b" } } },
        yaxis: { labels: { style: { colors: isDark ? "#94a3b8" : "#64748b" } } },
      });
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-bs-theme"] });

  // Initial render when DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    if (currentAssetId) {
      loadAndRenderChart(currentAssetId, currentExchangeId, currentDays);
    }
  });
})();
