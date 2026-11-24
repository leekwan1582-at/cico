/**
 * @file Gemini AI Analysis Service
 * @description Provides generative AI market commentary, score breakdown evaluation,
 * and trade scenario synthesis for Coin Deep Analysis Reports using Google Gemini API.
 * Defaults to `gemini-3.8-flash` if `GEMINI_MODEL` is unset.
 * @module services/geminiService
 */

const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

/**
 * Returns the configured Gemini API Key.
 * @returns {string|null}
 */
function getApiKey() {
  return process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
}

/**
 * Returns the configured Gemini model name, falling back to 'gemini-3.8-flash'.
 * @returns {string}
 */
function getModelName() {
  return (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) || "gemini-3.8-flash";
}

/**
 * Generates institutional-grade cryptocurrency market commentary and trade scenarios
 * using Gemini API based on computed quantitative scorecard metrics.
 *
 * @async
 * @param {Object} reportContext - Computed quantitative analysis data.
 * @returns {Promise<{
 *   executiveSummary: string,
 *   scorecardSummary: string,
 *   bullScenario: string,
 *   bearScenario: string,
 *   recommendation: string,
 *   modelUsed: string,
 *   isAiGenerated: boolean
 * } | null>}
 */
async function generateAiMarketCommentary(reportContext) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return null;
  }

  const model = getModelName();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = `You are a Senior Quantitative Crypto Analyst & Portfolio Risk Strategist.
Analyze the following multi-factor crypto scorecard and provide an institutional-grade, actionable market synthesis.

ASSET & PRICE:
- Symbol: ${reportContext.symbol} (${reportContext.name || ""})
- Current Price: $${Number(reportContext.currentPrice || 0).toLocaleString()}
- 24h Change: ${reportContext.sentiment?.momentum?.change24h || 0}%

SCORECARD METRICS:
- Overall Score: ${reportContext.overallScore}/100
- Signal: ${reportContext.overallSignal}
- Technical Subscore: ${reportContext.technicalScore}/100
- Sentiment Subscore: ${reportContext.sentimentScore}/100
- Risk Rating: ${reportContext.riskLevel}

KEY INDICATORS:
- 200-Week SMA (Macro Cycle Floor): ${reportContext.sma200wEval?.sma200w ? `$${Number(reportContext.sma200wEval.sma200w).toLocaleString()} (${reportContext.sma200wEval.distancePct}% distance)` : "Insufficient historical data"}
- 50-Day SMA: ${reportContext.technicals?.sma50 ? `$${Number(Number(reportContext.technicals.sma50).toFixed(2)).toLocaleString()}` : "N/A"}
- 200-Day SMA: ${reportContext.technicals?.sma200 ? `$${Number(Number(reportContext.technicals.sma200).toFixed(2)).toLocaleString()}` : "N/A"}
- RSI (14): ${reportContext.technicals?.rsi14 ?? "N/A"}
- MACD Histogram: ${reportContext.technicals?.macd?.histogram ?? "N/A"} (Bullish Cross: ${Boolean(reportContext.technicals?.macd?.isBullishCross)})
- Bollinger Bands Squeeze: ${Boolean(reportContext.technicals?.bollingerBands?.isSqueeze)}
- Average True Range (ATR Volatility): $${reportContext.technicals?.atr ?? "N/A"}
- Fear & Greed Index: ${reportContext.sentiment?.fearAndGreed?.value ?? "N/A"} (${reportContext.sentiment?.fearAndGreed?.classification ?? "N/A"})
- Support Level: ${reportContext.supportPrice ? `$${Number(reportContext.supportPrice).toLocaleString()}` : "N/A"}
- Resistance Level: ${reportContext.resistancePrice ? `$${Number(reportContext.resistancePrice).toLocaleString()}` : "N/A"}
- Stop Loss: ${reportContext.suggestedStopLoss ? `$${Number(reportContext.suggestedStopLoss).toLocaleString()}` : "N/A"}

Please respond STRICTLY in JSON format with exactly the following keys:
{
  "executiveSummary": "2-3 crisp sentences highlighting current momentum, macro position, and key risk profile.",
  "scorecardSummary": "Detailed breakdown of the 0-100 scorecard components: Technicals (${reportContext.technicalScore}/100), Sentiment (${reportContext.sentimentScore}/100), and Macro alignment (${reportContext.overallScore}/100).",
  "bullScenario": "Key catalysts, price targets, and validation levels for an upside continuation.",
  "bearScenario": "Key invalidation thresholds, breakdown risks, and defensive stop-loss considerations.",
  "recommendation": "Direct, actionable tactical recommendation for spot traders and alert setting."
}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200,
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.warn(`Notice: Gemini API returned status ${resp.status} (${errText.slice(0, 120)}). Falling back to rule-based commentary.`);
      return null;
    }

    const data = await resp.json();
    const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText) {
      return null;
    }

    // Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(candidateText.trim());
    } catch {
      // In case wrapped in markdown code fence
      const cleaned = candidateText.replace(/```json/gi, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    }

    return {
      executiveSummary: parsed.executiveSummary || "",
      scorecardSummary: parsed.scorecardSummary || "",
      bullScenario: parsed.bullScenario || "",
      bearScenario: parsed.bearScenario || "",
      recommendation: parsed.recommendation || "",
      modelUsed: model,
      isAiGenerated: true,
    };
  } catch (err) {
    console.warn(`Notice: Gemini analysis call bypassed (${err.message}). Using deterministic fallback.`);
    return null;
  }
}

module.exports = {
  getApiKey,
  getModelName,
  generateAiMarketCommentary,
};
