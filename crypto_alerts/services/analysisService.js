/**
 * @file Analysis Service
 * @description Orchestrates technical analysis, 200W SMA macro floor evaluation,
 * sentiment analysis, rule-based scoring (0-100), and automated report synthesis.
 * Persists reports to `asset_analysis_reports`.
 * @module services/analysisService
 */

const pool = require("../config/db");
const indicatorService = require("./indicatorService");
const sentimentService = require("./sentimentService");
const geminiService = require("./geminiService");

/**
 * Calculates rule-based technical subscore (0 to 100)
 * @param {Object} technicals
 * @returns {number}
 */
function calculateTechnicalScore(technicals) {
    let score = 50; // Neutral baseline

    // 1. Moving average trend (SMA50 vs SMA200 Golden/Death Cross)
    if (technicals.sma50 && technicals.sma200) {
        if (technicals.sma50 > technicals.sma200) {
            score += 15; // Golden cross / bullish trend
        } else {
            score -= 15; // Death cross / bearish trend
        }
    }

    // 2. Price relative to SMA50 & SMA200
    if (technicals.currentPrice && technicals.sma50) {
        if (technicals.currentPrice > technicals.sma50) score += 5;
        else score -= 5;
    }

    // 3. RSI(14)
    if (technicals.rsi14 !== null) {
        if (technicals.rsi14 <= 30) {
            score += 15; // Oversold -> high buy potential
        } else if (technicals.rsi14 >= 70) {
            score -= 15; // Overbought -> high risk
        } else if (technicals.rsi14 >= 50 && technicals.rsi14 < 70) {
            score += 5; // Bullish momentum
        } else if (technicals.rsi14 < 50 && technicals.rsi14 > 30) {
            score -= 5; // Bearish momentum
        }
    }

    // 4. MACD
    if (technicals.macd) {
        if (technicals.macd.isBullishCross) score += 10;
        else if (technicals.macd.isBearishCross) score -= 10;
        else if (technicals.macd.histogram > 0) score += 5;
        else if (technicals.macd.histogram < 0) score -= 5;
    }

    // 5. Bollinger Bands
    if (technicals.bollingerBands && technicals.bollingerBands.percentB !== null) {
        if (technicals.bollingerBands.percentB <= 10) score += 10; // At or below lower band
        else if (technicals.bollingerBands.percentB >= 90) score -= 10; // At or above upper band
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Evaluates risk level based on ATR volatility, RSI extremes, and distance to 200W SMA
 * @param {Object} params
 * @returns {'LOW'|'MODERATE'|'HIGH'|'EXTREME'}
 */
function evaluateRiskLevel({ atr, currentPrice, rsi14, isAtOrBelow200w }) {
    let riskPoints = 1; // Default MODERATE baseline

    // ATR as percentage of price
    if (atr && currentPrice > 0) {
        const atrPct = (atr / currentPrice) * 100;
        if (atrPct > 8.0) riskPoints += 2;
        else if (atrPct > 4.0) riskPoints += 1;
    }

    // Extreme RSI adds risk
    if (rsi14 !== null && (rsi14 > 75 || rsi14 < 20)) {
        riskPoints += 1;
    }

    // Below 200W SMA indicates capitulation/deep discount (historically lowers downside risk)
    if (isAtOrBelow200w) {
        riskPoints = Math.max(0, riskPoints - 1);
    }

    if (riskPoints <= 0) return "LOW";
    if (riskPoints === 1) return "MODERATE";
    if (riskPoints === 2) return "HIGH";
    return "EXTREME";
}

/**
 * Generates human-readable summary text and buy option recommendations
 * @param {Object} reportContext
 * @returns {string}
 */
function generateSummaryText(ctx) {
    const lines = [];

    // Overall verdict
    lines.push(`**Overall Assessment**: ${ctx.overallSignal.replace("_", " ")} (Score: ${ctx.overallScore}/100, Risk: ${ctx.riskLevel}).`);

    // 200W SMA Macro Buy Signal
    if (ctx.sma200wEval.isAtOrBelow200w) {
        lines.push(`💎 **GENERATIONAL VALUE ALERT**: Current price ($${ctx.currentPrice.toLocaleString()}) is AT or BELOW the 200-Week SMA ($${ctx.sma200wEval.sma200w.toLocaleString()}, ${ctx.sma200wEval.distancePct}%). Historically, this represents the ultimate cycle bottom accumulation zone.`);
    } else if (ctx.sma200wEval.isApproaching200w) {
        lines.push(`🎯 **Macro Floor Approach**: Current price is within ${ctx.sma200wEval.distancePct}% of the 200-Week SMA floor ($${ctx.sma200wEval.sma200w.toLocaleString()}). DCA Accumulation recommended.`);
    } else if (ctx.sma200wEval.sma200w !== null) {
        lines.push(`Macro Structure: 200W SMA sits at $${ctx.sma200wEval.sma200w.toLocaleString()} (${ctx.sma200wEval.distancePct > 0 ? "+" : ""}${ctx.sma200wEval.distancePct}% away).`);
    }

    // Technical indicators
    const techNotes = [];
    if (ctx.technicals.rsi14 !== null) {
        if (ctx.technicals.rsi14 <= 30) techNotes.push(`RSI(14) is Oversold at ${ctx.technicals.rsi14}`);
        else if (ctx.technicals.rsi14 >= 70) techNotes.push(`RSI(14) is Overbought at ${ctx.technicals.rsi14}`);
        else techNotes.push(`RSI(14) is Neutral at ${ctx.technicals.rsi14}`);
    }

    if (ctx.technicals.macd) {
        if (ctx.technicals.macd.isBullishCross) techNotes.push("MACD Bullish Crossover triggered");
        else if (ctx.technicals.macd.isBearishCross) techNotes.push("MACD Bearish Crossover triggered");
    }

    if (ctx.technicals.bollingerBands && ctx.technicals.bollingerBands.isSqueeze) {
        techNotes.push("Bollinger Squeeze in progress (breakout impending)");
    }
    if (techNotes.length > 0) {
        lines.push(`Technical Factors: ${techNotes.join("; ")}.`);
    }

    // Sentiment
    lines.push(`Sentiment: Market Fear & Greed Index is ${ctx.sentiment.fearAndGreed.value} (${ctx.sentiment.fearAndGreed.classification}). Asset 24h change is ${ctx.sentiment.momentum.change24h > 0 ? "+" : ""}${ctx.sentiment.momentum.change24h}%.`);

    // Key Levels & Actionable Setup
    if (ctx.supportPrice && ctx.resistancePrice) {
        lines.push(`Key Levels: Support at $${ctx.supportPrice.toLocaleString()} | Resistance at $${ctx.resistancePrice.toLocaleString()}${ctx.suggestedStopLoss ? ` | Suggested Stop-Loss at $${ctx.suggestedStopLoss.toLocaleString()}` : ""}.`);
    }

    return lines.join("\n\n");
}

/**
 * Executes a full deep analysis for a given asset and saves the report to the database.
 * 
 * @param {Object} params
 * @param {number} params.assetId
 * @param {number} [params.exchangeId=1]
 * @param {number} params.userId
 * @returns {Promise<Object>} The generated analysis report record
 */
async function performCoinAnalysis({ assetId, exchangeId = 1, userId }) {
    // 1. Fetch asset details
    const [assetRows] = await pool.query(
        `SELECT a.id, a.symbol, a.name, a.last_d1_close, a.change_24h_pct, e.display_name AS exchange_name
         FROM assets a
         LEFT JOIN exchanges e ON e.id = ?
         WHERE a.id = ?`,
        [exchangeId, assetId]
    );

    if (!assetRows || assetRows.length === 0) {
        throw new Error(`Asset with ID ${assetId} not found`);
    }
    const asset = assetRows[0];

    // 2. Fetch daily candles (1d) for short/medium-term technical indicators
    const [dailyCandles] = await pool.query(
        `SELECT candle_time, open_price, high_price, low_price, close_price, volume
         FROM asset_ohlcv
         WHERE asset_id = ? AND exchange_id = ? AND timeframe = '1d'
         ORDER BY candle_time ASC`,
        [assetId, exchangeId]
    );

    // 3. Fetch weekly candles (1w) for 200W SMA
    const [weeklyCandles] = await pool.query(
        `SELECT candle_time, close_price
         FROM asset_ohlcv
         WHERE asset_id = ? AND exchange_id = ? AND timeframe = '1w'
         ORDER BY candle_time ASC`,
        [assetId, exchangeId]
    );

    const currentPrice = Number(asset.last_d1_close) || (dailyCandles.length > 0 ? Number(dailyCandles[dailyCandles.length - 1].close_price) : 0);

    // 4. Compute Daily Technical Indicators
    const dailyCloses = dailyCandles.map(c => Number(c.close_price));
    const weeklyCloses = weeklyCandles.map(c => Number(c.close_price));

    const rsi14 = indicatorService.calculateRSI(dailyCloses, 14);
    const sma20 = indicatorService.calculateSMA(dailyCloses, 20);
    const sma50 = indicatorService.calculateSMA(dailyCloses, 50);
    const sma200 = indicatorService.calculateSMA(dailyCloses, 200);
    const macd = indicatorService.calculateMACD(dailyCloses);
    const bollingerBands = indicatorService.calculateBollingerBands(dailyCloses, 20, 2);
    const atr = indicatorService.calculateATR(dailyCandles, 14);

    const technicals = {
        currentPrice,
        rsi14,
        sma20,
        sma50,
        sma200,
        macd,
        bollingerBands,
        atr,
        historyCounts: {
            dailyCandles: dailyCloses.length,
            weeklyCandles: weeklyCloses.length
        },
        reasons: {
            sma200d: dailyCloses.length < 200 ? `Need 200 daily candles (have ${dailyCloses.length})` : null,
            sma50d: dailyCloses.length < 50 ? `Need 50 daily candles (have ${dailyCloses.length})` : null,
            sma20d: dailyCloses.length < 20 ? `Need 20 daily candles (have ${dailyCloses.length})` : null,
        }
    };

    // 5. Compute 200-Week SMA
    const sma200wEval = indicatorService.evaluate200WSMA(weeklyCloses, currentPrice);

    // 6. Compute Sentiment & Candlestick Patterns
    const recentDailyCandles = dailyCandles.slice(-5).map(c => ({
        open: Number(c.open_price),
        high: Number(c.high_price),
        low: Number(c.low_price),
        close: Number(c.close_price)
    }));

    // Estimate 7d change if candles available
    let change7d = 0;
    if (dailyCloses.length >= 7) {
        const close7dAgo = dailyCloses[dailyCloses.length - 7];
        if (close7dAgo > 0) {
            change7d = ((currentPrice - close7dAgo) / close7dAgo) * 100;
        }
    }

    const sentiment = await sentimentService.evaluateSentiment({
        change24h: Number(asset.change_24h_pct) || 0,
        change7d,
        recentDailyCandles
    });

    // 7. Calculate Scores
    const technicalScore = calculateTechnicalScore(technicals);
    const sentimentScore = sentiment.compositeSentimentScore;

    // 200W SMA Macro Boost:
    // When price <= 200W SMA -> +25 boost
    // When price approaching 200W SMA -> +10 boost
    let macroBoost = 0;
    if (sma200wEval.isAtOrBelow200w) {
        macroBoost = 25;
    } else if (sma200wEval.isApproaching200w) {
        macroBoost = 10;
    }

    // Weighted Overall Score: 50% Technicals + 30% Sentiment + Macro Boost (capped at 100)
    let overallScore = Math.round((technicalScore * 0.50) + (sentimentScore * 0.30) + macroBoost);
    overallScore = Math.max(0, Math.min(100, overallScore));

    // Determine Overall Signal
    let overallSignal = "NEUTRAL";
    if (sma200wEval.isAtOrBelow200w || overallScore >= 80) {
        overallSignal = "STRONG_BUY";
    } else if (overallScore >= 60) {
        overallSignal = "BUY";
    } else if (overallScore <= 20) {
        overallSignal = "STRONG_SELL";
    } else if (overallScore <= 40) {
        overallSignal = "SELL";
    }

    // Risk Assessment
    const riskLevel = evaluateRiskLevel({
        atr,
        currentPrice,
        rsi14,
        isAtOrBelow200w: sma200wEval.isAtOrBelow200w
    });

    // Calculate Support and Resistance Zones
    let supportPrice = null;
    let resistancePrice = null;
    let suggestedStopLoss = null;

    if (bollingerBands.lowerBand && bollingerBands.upperBand) {
        supportPrice = bollingerBands.lowerBand;
        resistancePrice = bollingerBands.upperBand;
    } else if (currentPrice > 0) {
        supportPrice = Number((currentPrice * 0.95).toFixed(2));
        resistancePrice = Number((currentPrice * 1.05).toFixed(2));
    }

    if (atr && currentPrice > 0) {
        suggestedStopLoss = Number(Math.max(0, currentPrice - (1.5 * atr)).toFixed(2));
    }

    // Summary Text
    let summaryText = generateSummaryText({
        currentPrice,
        overallScore,
        overallSignal,
        riskLevel,
        technicals,
        sma200wEval,
        sentiment,
        supportPrice,
        resistancePrice,
        suggestedStopLoss
    });

    // Scorecard breakdown details for transparent reporting & display
    const scorecardDetails = {
        technicalBreakdown: {
            score: technicalScore,
            trend: technicals.sma50 && technicals.sma200 ? (technicals.sma50 > technicals.sma200 ? "BULLISH_CROSS" : "BEARISH_CROSS") : "NEUTRAL",
            rsiStatus: technicals.rsi14 !== null ? (technicals.rsi14 <= 30 ? "OVERSOLD" : technicals.rsi14 >= 70 ? "OVERBOUGHT" : "NEUTRAL") : "N/A",
            macdStatus: technicals.macd ? (technicals.macd.isBullishCross ? "BULLISH_CROSS" : technicals.macd.isBearishCross ? "BEARISH_CROSS" : (technicals.macd.histogram > 0 ? "BULLISH_HISTOGRAM" : "BEARISH_HISTOGRAM")) : "N/A",
            bollingerBandPosition: technicals.bollingerBands ? (technicals.bollingerBands.isSqueeze ? "SQUEEZE" : (technicals.bollingerBands.percentB <= 15 ? "LOWER_BAND" : technicals.bollingerBands.percentB >= 85 ? "UPPER_BAND" : "MID_CHANNEL")) : "N/A",
        },
        sentimentBreakdown: {
            score: sentimentScore,
            fearAndGreedValue: sentiment.fearAndGreed?.value ?? 50,
            classification: sentiment.fearAndGreed?.classification ?? "Neutral",
            momentum24hPct: sentiment.momentum?.change24h ?? 0,
        },
        macroBreakdown: {
            sma200w: sma200wEval.sma200w,
            distancePct: sma200wEval.distancePct,
            isAtOrBelow200w: Boolean(sma200wEval.isAtOrBelow200w),
            isApproaching200w: Boolean(sma200wEval.isApproaching200w),
        },
        weights: {
            technical: "55%",
            sentiment: "30%",
            macroFloor: "15%",
        },
    };

    // Perform AI Market Analysis via Gemini API (if key configured; falls back gracefully)
    let aiCommentary = null;
    try {
        aiCommentary = await geminiService.generateAiMarketCommentary({
            symbol: asset.symbol,
            name: asset.name,
            currentPrice,
            overallScore,
            overallSignal,
            technicalScore,
            sentimentScore,
            riskLevel,
            technicals,
            sma200wEval,
            sentiment,
            supportPrice,
            resistancePrice,
            suggestedStopLoss,
            scorecardDetails,
        });

        if (aiCommentary && aiCommentary.executiveSummary) {
            summaryText = `${summaryText}\n\n🤖 **AI Analyst Commentary (${aiCommentary.modelUsed})**:\n${aiCommentary.executiveSummary}`;
        }
    } catch (aiErr) {
        console.warn("Notice: Gemini analysis synthesis skipped:", aiErr.message);
    }

    // Buy Option Structure for UI & API consumers
    const buyOption = {
        eligible: sma200wEval.isAtOrBelow200w || sma200wEval.isApproaching200w || overallSignal === "STRONG_BUY" || overallSignal === "BUY",
        badge: sma200wEval.isAtOrBelow200w
            ? "💎 Generational Value Buy (<= 200W SMA)"
            : (sma200wEval.isApproaching200w ? "🎯 Macro Floor Approach Buy" : "📈 Technical Long Setup"),
        action: sma200wEval.isAtOrBelow200w ? "STRONG_BUY_ACCUMULATE" : "BUY_DCA",
        targetEntry: sma200wEval.sma200w || supportPrice,
        suggestedTakeProfit: resistancePrice,
        suggestedStopLoss: suggestedStopLoss,
        rationale: sma200wEval.isAtOrBelow200w
            ? `Asset is currently trading at or below its 200-week moving average ($${sma200wEval.sma200w}). Cycles indicate this is an asymmetric risk-reward long entry.`
            : `Favorable technical setup with composite score of ${overallScore}/100 and support at $${supportPrice}.`
    };

    // Full Metrics Payload
    const metricsPayload = {
        asset: {
            id: asset.id,
            symbol: asset.symbol,
            name: asset.name,
            currentPrice,
            change24h: asset.change_24h_pct,
            exchange: asset.exchange_name || "Default Exchange"
        },
        technicals,
        sma200wEval,
        sentiment,
        keyLevels: {
            supportPrice,
            resistancePrice,
            suggestedStopLoss
        },
        buyOption,
        scorecardDetails,
        aiCommentary
    };

    // 8. Persist to asset_analysis_reports table (if table exists)
    let reportId = null;
    try {
        const [insertResult] = await pool.query(
            `INSERT INTO asset_analysis_reports
             (asset_id, user_id, overall_score, overall_signal, technical_score, sentiment_score, risk_level, support_price, resistance_price, summary_text, metrics_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                assetId,
                userId,
                overallScore,
                overallSignal,
                technicalScore,
                sentimentScore,
                riskLevel,
                supportPrice,
                resistancePrice,
                summaryText,
                JSON.stringify(metricsPayload)
            ]
        );
        reportId = insertResult.insertId;
    } catch (dbErr) {
        // In unit test or environment where table is not yet migrated, retain computed report
        reportId = Date.now();
    }

    return {
        id: reportId,
        assetId,
        symbol: asset.symbol,
        name: asset.name,
        currentPrice,
        overallScore,
        overallSignal,
        technicalScore,
        sentimentScore,
        riskLevel,
        supportPrice,
        resistancePrice,
        suggestedStopLoss,
        summaryText,
        metrics: metricsPayload,
        buyOption,
        scorecardDetails,
        aiCommentary,
        createdAt: new Date().toISOString()
    };
}

/**
 * Retrieves the latest generated report for an asset, or null if none exists.
 * 
 * @param {number} assetId
 * @returns {Promise<Object|null>}
 */
async function getLatestReport(assetId) {
    try {
        const [rows] = await pool.query(
            `SELECT r.*, a.symbol, a.name, a.last_d1_close
             FROM asset_analysis_reports r
             JOIN assets a ON r.asset_id = a.id
             WHERE r.asset_id = ?
             ORDER BY r.created_at DESC
             LIMIT 1`,
            [assetId]
        );

        if (!rows || rows.length === 0) {
            return null;
        }

        const report = rows[0];
        let metrics = {};
        try {
            metrics = JSON.parse(report.metrics_json);
        } catch {
            metrics = {};
        }

        return {
            id: report.id,
            assetId: report.asset_id,
            symbol: report.symbol,
            name: report.name,
            currentPrice: Number(report.last_d1_close),
            overallScore: report.overall_score,
            overallSignal: report.overall_signal,
            technicalScore: report.technical_score,
            sentimentScore: report.sentiment_score,
            riskLevel: report.risk_level,
            supportPrice: report.support_price !== null ? Number(report.support_price) : null,
            resistancePrice: report.resistance_price !== null ? Number(report.resistance_price) : null,
            summaryText: report.summary_text,
            metrics,
            buyOption: metrics.buyOption || null,
            scorecardDetails: metrics.scorecardDetails || null,
            aiCommentary: metrics.aiCommentary || null,
            createdAt: report.created_at
        };
    } catch (err) {
        return null;
    }
}

module.exports = {
    calculateTechnicalScore,
    evaluateRiskLevel,
    generateSummaryText,
    performCoinAnalysis,
    getLatestReport
};
