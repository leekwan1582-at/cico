/**
 * sentimentService.js
 * 
 * Provides market sentiment analysis:
 * 1. Crypto Fear & Greed Index (fetched from public API with caching & offline fallback)
 * 2. Asset-specific price momentum & candlestick sentiment
 * 3. Unified sentiment score computation (0 to 100)
 */

const https = require("https");

// Cache for Fear & Greed index to avoid repeated external network calls
let cachedFnG = {
    value: 52,
    valueClassification: "Neutral",
    timestamp: Date.now(),
    source: "default"
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Fetches the latest Crypto Fear & Greed Index from alternative.me
 * If offline or network error occurs, falls back to cached or default snapshot.
 * 
 * @param {boolean} forceRefresh - If true, ignores TTL
 * @returns {Promise<{ value: number, valueClassification: string, timestamp: number, source: string }>}
 */
async function fetchFearAndGreedIndex(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedFnG && (now - cachedFnG.timestamp < CACHE_TTL_MS) && cachedFnG.source === "api") {
        return cachedFnG;
    }

    return new Promise((resolve) => {
        const req = https.get("https://api.alternative.me/fng/?limit=1", { timeout: 3000 }, (res) => {
            if (res.statusCode !== 200) {
                return resolve(cachedFnG);
            }

            let body = "";
            res.on("data", chunk => body += chunk);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(body);
                    if (parsed && parsed.data && parsed.data.length > 0) {
                        const item = parsed.data[0];
                        cachedFnG = {
                            value: parseInt(item.value, 10) || 50,
                            valueClassification: item.value_classification || "Neutral",
                            timestamp: Date.now(),
                            source: "api"
                        };
                        return resolve(cachedFnG);
                    }
                } catch {
                    // JSON parsing failed, use fallback
                }
                resolve(cachedFnG);
            });
        });

        req.on("error", () => {
            // Offline / timeout / DNS failure
            resolve(cachedFnG);
        });

        req.on("timeout", () => {
            req.destroy();
            resolve(cachedFnG);
        });
    });
}

/**
 * Classifies Fear & Greed raw score into grade and descriptive label
 * @param {number} score (0-100)
 */
function classifyFearAndGreed(score) {
    if (score <= 24) return { grade: "EXTREME_FEAR", label: "Extreme Fear", color: "#dc3545" };
    if (score <= 44) return { grade: "FEAR", label: "Fear", color: "#fd7e14" };
    if (score <= 55) return { grade: "NEUTRAL", label: "Neutral", color: "#ffc107" };
    if (score <= 75) return { grade: "GREED", label: "Greed", color: "#20c997" };
    return { grade: "EXTREME_GREED", label: "Extreme Greed", color: "#198754" };
}

/**
 * Detects basic candlestick patterns from recent daily candles
 * @param {Array<{ open: number, high: number, low: number, close: number }>} recentCandles (last 3-5 daily candles, newest last)
 */
function detectCandlestickPatterns(recentCandles) {
    if (!recentCandles || recentCandles.length < 2) {
        return [];
    }

    const patterns = [];
    const latest = recentCandles[recentCandles.length - 1];
    const prev = recentCandles[recentCandles.length - 2];

    const body = Math.abs(latest.close - latest.open);
    const range = latest.high - latest.low;
    const upperWick = latest.high - Math.max(latest.open, latest.close);
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;

    // Doji: body is very small (< 10% of total range) and not predominantly a hammer or shooting star
    const isHammer = (range > 0 && lowerWick >= 2 * body && upperWick <= Math.max(0.2 * body, 0.1 * range) && prev.close < prev.open);
    const isShootingStar = (range > 0 && upperWick >= 2 * body && lowerWick <= Math.max(0.2 * body, 0.1 * range));

    if (range > 0 && body / range < 0.1 && !isHammer && !isShootingStar) {
        patterns.push({ name: "Doji", sentiment: "NEUTRAL", description: "Market indecision at current price levels" });
    }

    // Hammer: small body, long lower wick (>= 2x body), little/no upper wick, preceded by downtrend
    if (isHammer) {
        patterns.push({ name: "Hammer", sentiment: "BULLISH", description: "Potential bullish reversal after rejection of lower prices" });
    }

    // Shooting Star / Inverted Hammer
    if (isShootingStar) {
        patterns.push({ name: "Shooting Star", sentiment: "BEARISH", description: "Potential bearish rejection of higher prices" });
    }

    // Bullish Engulfing
    if (prev.close < prev.open && latest.close > latest.open && latest.open <= prev.close && latest.close >= prev.open) {
        patterns.push({ name: "Bullish Engulfing", sentiment: "BULLISH", description: "Buyers completely overtook previous day sellers" });
    }

    // Bearish Engulfing
    if (prev.close > prev.open && latest.close < latest.open && latest.open >= prev.close && latest.close <= prev.open) {
        patterns.push({ name: "Bearish Engulfing", sentiment: "BEARISH", description: "Sellers completely overwhelmed previous day buyers" });
    }

    return patterns;
}

/**
 * Evaluates asset sentiment by combining macro Fear & Greed index with asset price action
 * @param {Object} params
 * @param {number} params.change24h - 24-hour price change percentage (e.g. +3.5)
 * @param {number} params.change7d - 7-day price change percentage (e.g. -2.1)
 * @param {Array} params.recentDailyCandles - Recent daily OHLCV candles
 * @param {Object} [params.fngSnapshot] - Optional pre-fetched Fear & Greed object
 * @returns {Promise<Object>} Sentiment evaluation metrics
 */
async function evaluateSentiment({ change24h = 0, change7d = 0, recentDailyCandles = [], fngSnapshot = null }) {
    const fng = fngSnapshot || await fetchFearAndGreedIndex();
    const classification = classifyFearAndGreed(fng.value);
    const patterns = detectCandlestickPatterns(recentDailyCandles);

    // Momentum score (0 to 100) based on 24h & 7d changes
    // Baseline is 50. +5% 24h -> +10 pts; +10% 7d -> +15 pts.
    let momentumScore = 50 + (change24h * 2) + (change7d * 1.5);
    momentumScore = Math.max(0, Math.min(100, Math.round(momentumScore)));

    // Candlestick pattern sentiment adjustment
    let patternAdjustment = 0;
    patterns.forEach(p => {
        if (p.sentiment === "BULLISH") patternAdjustment += 5;
        if (p.sentiment === "BEARISH") patternAdjustment -= 5;
    });

    // Weighted composite sentiment: 40% Fear & Greed index, 50% Asset Momentum, 10% Patterns
    let compositeSentimentScore = Math.round(
        (fng.value * 0.40) +
        (momentumScore * 0.50) +
        (patternAdjustment)
    );
    compositeSentimentScore = Math.max(0, Math.min(100, compositeSentimentScore));

    let sentimentSignal = "NEUTRAL";
    if (compositeSentimentScore >= 70) sentimentSignal = "VERY_BULLISH";
    else if (compositeSentimentScore >= 55) sentimentSignal = "BULLISH";
    else if (compositeSentimentScore <= 30) sentimentSignal = "VERY_BEARISH";
    else if (compositeSentimentScore <= 45) sentimentSignal = "BEARISH";

    return {
        fearAndGreed: {
            value: fng.value,
            classification: classification.label,
            grade: classification.grade,
            color: classification.color,
            source: fng.source
        },
        momentum: {
            change24h: Number(change24h.toFixed(2)),
            change7d: Number(change7d.toFixed(2)),
            score: momentumScore
        },
        candlestickPatterns: patterns,
        compositeSentimentScore,
        sentimentSignal
    };
}

module.exports = {
    fetchFearAndGreedIndex,
    classifyFearAndGreed,
    detectCandlestickPatterns,
    evaluateSentiment
};
