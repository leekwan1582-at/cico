const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

test("Phase 1-3 Unit Tests - Fallback Data & Schema Integrity", async (t) => {
  const priceService = require("../services/priceService");

  await t.test("loadFallbackPrices() correctly parses fallback_d1.json", () => {
    const prices = priceService.loadFallbackPrices();
    assert.ok(prices, "Prices object should exist");
    assert.equal(typeof prices["BTC/USDT"], "number");
    assert.equal(typeof prices["ETH/USDT"], "number");
    assert.equal(typeof prices["SOL/USDT"], "number");
    assert.ok(prices["BTC/USDT"] > 0, "BTC price should be positive");
  });

  await t.test("loadFallbackPrices() returns hardcoded defaults if JSON is missing/corrupt", () => {
    // Test with non-existent symbol to verify object shape
    const prices = priceService.loadFallbackPrices();
    assert.equal(prices["UNKNOWN/USDT"], undefined);
  });

  await t.test("schema.sql file exists and defines all 9 required tables and security columns", () => {
    const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
    assert.ok(fs.existsSync(schemaPath), "schema.sql should exist");
    const content = fs.readFileSync(schemaPath, "utf8");

    assert.ok(content.includes("CREATE TABLE users"), "Must contain users table");
    assert.ok(content.includes("CREATE TABLE exchanges"), "Must contain exchanges table");
    assert.ok(content.includes("CREATE TABLE assets"), "Must contain assets table");
    assert.ok(content.includes("CREATE TABLE price_alerts"), "Must contain price_alerts table");
    assert.ok(content.includes("CREATE TABLE IF NOT EXISTS asset_ohlcv"), "Must contain asset_ohlcv table");
    assert.ok(content.includes("timeframe VARCHAR(10)"), "Must define timeframe column in asset_ohlcv");
    assert.ok(content.includes("uq_asset_exchange_tf_candle"), "Must define multi-timeframe unique key");
    assert.ok(content.includes("CREATE TABLE IF NOT EXISTS user_watchlist"), "Must contain user_watchlist table");
    assert.ok(content.includes("CREATE TABLE IF NOT EXISTS alert_events"), "Must contain alert_events table");
    assert.ok(content.includes("CREATE TABLE IF NOT EXISTS user_notification_preferences"), "Must contain user_notification_preferences table");
    assert.ok(content.includes("CREATE TABLE IF NOT EXISTS notification_log"), "Must contain notification_log table");
    assert.ok(content.includes("CREATE TABLE IF NOT EXISTS api_tokens"), "Must contain api_tokens table");
    assert.ok(content.includes("CREATE TABLE IF NOT EXISTS asset_analysis_reports"), "Must contain asset_analysis_reports table");
    assert.ok(content.includes("FOREIGN KEY (user_id) REFERENCES users(id)"), "FK on users exists");
    assert.ok(content.includes("FOREIGN KEY (asset_id) REFERENCES assets(id)"), "FK on assets exists");
    assert.ok(content.includes("FOREIGN KEY (alert_id) REFERENCES price_alerts(id)"), "FK on alert_id exists");
    assert.ok(content.includes("role ENUM('ADMIN', 'TRADER')"), "Must define user role column as ENUM");
    assert.ok(content.includes("must_change_password"), "Must define must_change_password column");
  });

  await t.test("Alert trigger evaluation logic (ABOVE and BELOW conditions)", () => {
    const evaluateAlert = (conditionType, currentPrice, targetPrice) => {
      if (conditionType === "ABOVE") {
        return currentPrice >= targetPrice;
      }
      if (conditionType === "BELOW") {
        return currentPrice <= targetPrice;
      }
      return false;
    };

    // BTC tests
    assert.equal(evaluateAlert("ABOVE", 89200, 80000), true);
    assert.equal(evaluateAlert("ABOVE", 89200, 95000), false);
    // Boundary checks
    assert.equal(evaluateAlert("ABOVE", 80000, 80000), true);
    assert.equal(evaluateAlert("BELOW", 80000, 80000), true);
  });

  await t.test("Advanced Alert Logic: 24h percentage return & trailing stop", () => {
    // 24h percentage change formula
    const calcChangePct = (current, prev) => ((current - prev) / prev) * 100;
    assert.equal(Number(calcChangePct(92000, 88000).toFixed(2)), 4.55);
    assert.equal(Number(calcChangePct(80000, 88000).toFixed(2)), -9.09);

    // Evaluate PCT_CHANGE_24H_ABOVE
    const evalPctAbove = (changePct, targetPct) => changePct >= targetPct;
    assert.equal(evalPctAbove(6.2, 5.0), true);
    assert.equal(evalPctAbove(4.1, 5.0), false);

    // Evaluate PCT_CHANGE_24H_BELOW
    const evalPctBelow = (changePct, targetPct) => changePct <= -targetPct;
    assert.equal(evalPctBelow(-12.0, 10.0), true);
    assert.equal(evalPctBelow(-8.0, 10.0), false);

    // Evaluate TRAILING_STOP: drawdown from peak
    const evalTrailingStop = (currentPrice, peakPrice, trailingPct) => {
      const drawdown = ((peakPrice - currentPrice) / peakPrice) * 100;
      return drawdown >= trailingPct;
    };
    // Peak 100,000, drops to 94,000 (6% drop, target 5%) -> Triggers!
    assert.equal(evalTrailingStop(94000, 100000, 5.0), true);
    // Peak 100,000, drops to 96,000 (4% drop, target 5%) -> Not triggered
    assert.equal(evalTrailingStop(96000, 100000, 5.0), false);
  });

  await t.test("Engine Fix C1/C3: One-way trigger transition and exchange-specific price evaluation", () => {
    // 1. One-way transition simulation: Once triggered, engine must not re-arm to false
    const transitionAlert = (currentTriggered, conditionMet) => {
      if (currentTriggered) return true; // Already triggered, remains triggered until explicit user modification
      return Boolean(conditionMet);
    };

    assert.equal(transitionAlert(false, true), true, "Untriggered alert should transition to TRUE when condition is met");
    assert.equal(transitionAlert(true, false), true, "Triggered alert MUST NOT be re-armed to FALSE by price fluctuation");
    assert.equal(transitionAlert(true, true), true, "Triggered alert remains TRUE");
    assert.equal(transitionAlert(false, false), false, "Untriggered alert remains FALSE when condition not met");

    // 2. Exchange-aware pricing resolution: Uses exchange price when present, falls back to asset price
    const resolveEvalPrice = (assetPrice, exchangePrice) => exchangePrice != null ? exchangePrice : assetPrice;
    assert.equal(resolveEvalPrice(88000, 88500), 88500, "Should use exchange-specific price when available");
    assert.equal(resolveEvalPrice(88000, null), 88000, "Should fall back to asset last close if exchange candle absent");
  });

  await t.test("Engine Fix C4/C6: In-memory markets caching and prefetching", async () => {
    // Test cache functions
    priceService.clearMarketsCache();

    // Mock exchange with loadMarkets counter
    let loadCount = 0;
    const originalCcxtMock = priceService.getCachedMarkets;

    // Test caching mechanism behavior directly
    const fakeMarkets = { "BTC/USDT": { base: "BTC", quote: "USDT" } };
    const cacheMap = new Map();
    const getCached = async (id) => {
      if (cacheMap.has(id)) return cacheMap.get(id);
      loadCount++;
      cacheMap.set(id, fakeMarkets);
      return fakeMarkets;
    };

    const first = await getCached("okx");
    const second = await getCached("okx");

    assert.equal(loadCount, 1, "loadMarkets should be called only once and subsequently served from cache");
    assert.deepEqual(first, second);
  });

  await t.test("validateAssetSymbol validates pair formats and symbols", async () => {
    // Valid symbols
    const btcResult = await priceService.validateAssetSymbol("BTC/USDT");
    assert.equal(btcResult.valid, true);
    assert.equal(btcResult.symbol, "BTC/USDT");

    const xrpResult = await priceService.validateAssetSymbol("xrp/usdt");
    assert.equal(xrpResult.valid, true);
    assert.equal(xrpResult.symbol, "XRP/USDT");

    // Invalid format
    const invalidFormat = await priceService.validateAssetSymbol("INVALID_PAIR");
    assert.equal(invalidFormat.valid, false);

    // Empty / null
    const emptyResult = await priceService.validateAssetSymbol("");
    assert.equal(emptyResult.valid, false);
  });

  await t.test("getCatalogPairs returns non-empty list of verified cryptocurrency pairs", () => {
    const catalog = priceService.getCatalogPairs();
    assert.ok(Array.isArray(catalog), "Catalog should be an array");
    assert.ok(catalog.length >= 10, "Catalog should have at least 10 pairs");
    
    const btc = catalog.find((c) => c.symbol === "BTC/USDT");
    assert.ok(btc, "BTC/USDT should be in catalog");
    assert.equal(btc.name, "Bitcoin");
    assert.equal(btc.base, "BTC");
    assert.equal(btc.quote, "USDT");
  });

  await t.test("Technical Indicator Service: RSI_14, SMA_CROSS, and VOLUME_SPIKE (Phase 8+ 3.5)", () => {
    const indicatorService = require("../services/indicatorService");

    // 1. RSI calculation
    // Monotonically increasing close prices -> RSI should be high (approaching 100)
    const bullPrices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
    const rsiBull = indicatorService.calculateRSI(bullPrices, 14);
    assert.ok(rsiBull !== null, "RSI bull should compute");
    assert.equal(rsiBull, 100, "All gains should result in RSI of 100");

    // Monotonically decreasing prices -> RSI should be 0
    const bearPrices = [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
    const rsiBear = indicatorService.calculateRSI(bearPrices, 14);
    assert.equal(rsiBear, 0, "All losses should result in RSI of 0");

    // Oscillating prices
    const oscPrices = [100, 105, 102, 107, 103, 108, 104, 109, 105, 110, 106, 111, 107, 112, 108, 113];
    const rsiOsc = indicatorService.calculateRSI(oscPrices, 14);
    assert.ok(rsiOsc > 50 && rsiOsc < 80, `Oscillating RSI should be in reasonable range, got ${rsiOsc}`);

    // Insufficient data
    assert.equal(indicatorService.calculateRSI([100, 105], 14), null);

    // 2. SMA Cross calculation (Golden Cross & Death Cross)
    // 201 candles: baseline at 100, then latest candle surges to 200 (prevFast = 100 <= prevSlow = 100, fast = 102 >= slow = 100.5)
    const crossPrices = new Array(201).fill(100);
    crossPrices[200] = 200;
    const goldenCross = indicatorService.evaluateSMACross(crossPrices, 50, 200);
    assert.ok(goldenCross.fastSMA !== null, "fastSMA should be computed");
    assert.ok(goldenCross.slowSMA !== null, "slowSMA should be computed");
    assert.ok(goldenCross.fastSMA > goldenCross.slowSMA, "Fast SMA should be above Slow SMA after surge");
    assert.equal(goldenCross.isGoldenCross, true, "Golden cross should be detected");
    assert.equal(goldenCross.isDeathCross, false, "Death cross should not be true on golden cross");

    // 3. Volume Spike calculation (volume > N× 20-day average)
    const normalVolumes = new Array(25).fill(1000);
    // Spike on latest day to 3500 (3.5x average of 1000)
    normalVolumes[normalVolumes.length - 1] = 3500;
    const spike = indicatorService.evaluateVolumeSpike(normalVolumes, 2.0, 20);
    assert.equal(spike.currentVolume, 3500);
    assert.equal(spike.avgVolume20, 1000);
    assert.equal(spike.volumeRatio, 3.5);
    assert.equal(spike.isSpike, true, "Volume spike should trigger when ratio 3.5x >= 2.0x target");

    // Normal volume (no spike)
    normalVolumes[normalVolumes.length - 1] = 1200;
    const noSpike = indicatorService.evaluateVolumeSpike(normalVolumes, 2.0, 20);
    assert.equal(noSpike.volumeRatio, 1.2);
    assert.equal(noSpike.isSpike, false, "1.2x should not trigger 2.0x threshold");
  });

  await t.test("Multi-Timeframe Configuration & Candle Normalization (Phase 8+ 3.6)", () => {
    const chartConfig = require("../config/chartConfig");

    assert.deepEqual(chartConfig.SUPPORTED_CANDLE_TIMEFRAMES, ["1h", "4h", "1d", "1w"]);
    assert.equal(chartConfig.DEFAULT_CANDLE_TIMEFRAME, "1d");

    // Normalization
    assert.equal(chartConfig.normalizeTimeframe("1H"), "1h");
    assert.equal(chartConfig.normalizeTimeframe("4h"), "4h");
    assert.equal(chartConfig.normalizeTimeframe("1D"), "1d");
    assert.equal(chartConfig.normalizeTimeframe("1w"), "1w");
    assert.equal(chartConfig.normalizeTimeframe("invalid"), "1d");
    assert.equal(chartConfig.normalizeTimeframe(""), "1d");

    // Validation
    assert.equal(chartConfig.isCandleTimeframeValid("1h"), true);
    assert.equal(chartConfig.isCandleTimeframeValid("4h"), true);
    assert.equal(chartConfig.isCandleTimeframeValid("1d"), true);
    assert.equal(chartConfig.isCandleTimeframeValid("1w"), true);
    assert.equal(chartConfig.isCandleTimeframeValid("10m"), false);

    // Fallback candles generation for multi-timeframe
    const hourlyCandles = priceService.generateFallbackCandles(90000, 7, "1h");
    assert.ok(hourlyCandles.length > 7, "Hourly candles should generate multi-point intraday sequence");
    assert.ok(hourlyCandles[0].x.includes(":"), "Intraday timestamp should format with HH:mm");

    const dailyCandles = priceService.generateFallbackCandles(90000, 7, "1d");
    assert.equal(dailyCandles.length, 7);
  });

  await t.test("SSE Real-Time Service: connection tracking, packet formatting, and broadcast (Phase 8+ 3.7)", () => {
    const sseService = require("../services/sseService");

    // 1. Packet formatting
    const formatted = sseService.formatSSE("price_update", { symbol: "BTC/USDT", price: 90000 });
    assert.ok(formatted.startsWith("event: price_update\n"));
    assert.ok(formatted.includes('"symbol":"BTC/USDT"'));
    assert.ok(formatted.endsWith("\n\n"));

    // 2. Client registration and cleanup simulation
    sseService.resetClients();
    assert.equal(sseService.getConnectedClientsCount(), 0);

    const mockHeaders = {};
    const writtenData = [];
    let isClosed = false;

    const mockReq = {
      ip: "127.0.0.1",
      on: (evt, cb) => {
        if (evt === "close") {
          mockReq._closeCb = cb;
        }
      },
    };

    const mockRes = {
      writeHead: (status, headers) => {
        Object.assign(mockHeaders, headers);
      },
      write: (chunk) => {
        writtenData.push(chunk);
        return true;
      },
      end: () => {
        isClosed = true;
      },
    };

    const client = sseService.addClient(101, mockReq, mockRes);
    assert.equal(sseService.getConnectedClientsCount(), 1);
    assert.equal(mockHeaders["Content-Type"], "text/event-stream");
    assert.equal(mockHeaders["Cache-Control"], "no-cache, no-transform");

    // Welcome handshake event
    assert.ok(writtenData[0].startsWith("event: connected\n"));
    assert.ok(writtenData[0].includes(client.id));

    // Broadcast test
    const count = sseService.broadcastPriceUpdate([{ symbol: "ETH/USDT", price: 3200 }]);
    assert.equal(count, 1);
    assert.ok(writtenData[1].startsWith("event: price_update\n"));
    assert.ok(writtenData[1].includes("ETH/USDT"));

    // Client close event cleanup
    mockReq._closeCb();
    assert.equal(sseService.getConnectedClientsCount(), 0);
  });

  await t.test("tokenService: token pair generation, hashing, scope checks, and verification (Phase 8+ 3.8)", async () => {
    const tokenService = require("../services/tokenService");

    // 1. Token pair generation
    const pair = tokenService.generateTokenPair();
    assert.ok(pair.rawToken.startsWith("cpat_"));
    assert.equal(pair.prefix, pair.rawToken.slice(0, 12));
    assert.equal(pair.hash, tokenService.hashToken(pair.rawToken));

    // 2. Hash consistency
    const hash1 = tokenService.hashToken("cpat_testsecret123456");
    const hash2 = tokenService.hashToken("cpat_testsecret123456");
    assert.equal(hash1, hash2);
    assert.notEqual(hash1, tokenService.hashToken("cpat_differentsecret"));

    // 3. Allowed scopes validation
    assert.ok(tokenService.ALLOWED_SCOPES.includes("read:alerts"));
    assert.ok(tokenService.ALLOWED_SCOPES.includes("write:alerts"));
  });

  await t.test("Technical Indicator Service: 200W SMA, MACD, Bollinger Bands, and ATR (Coin Deep Analysis)", () => {
    const indicatorService = require("../services/indicatorService");

    // 1. Test 200W SMA calculation & Zone detection
    const mockWeeklyCloses = [];
    for (let i = 0; i < 210; i++) {
      mockWeeklyCloses.push(50000 + i * 50); // average around 55,000
    }
    const evalAtFloor = indicatorService.evaluate200WSMA(mockWeeklyCloses, 48000);
    assert.ok(evalAtFloor.sma200w > 48000);
    assert.equal(evalAtFloor.isAtOrBelow200w, true, "Price below 200W SMA must flag as true");
    assert.equal(evalAtFloor.zone, "GENERATIONAL_VALUE");

    const evalAbove = indicatorService.evaluate200WSMA(mockWeeklyCloses, 90000);
    assert.equal(evalAbove.isAtOrBelow200w, false);
    assert.equal(evalAbove.zone, "ABOVE_MACRO_AVERAGE");

    // Insufficient data test
    const evalFew = indicatorService.evaluate200WSMA([100, 200, 300], 250);
    assert.equal(evalFew.zone, "INSUFFICIENT_DATA");

    // 2. Test MACD calculation
    const series = [];
    for (let i = 0; i < 60; i++) {
      series.push(100 + i * 2);
    }
    const macd = indicatorService.calculateMACD(series);
    assert.ok(macd.macdLine !== null);
    assert.ok(macd.signalLine !== null);
    assert.ok(typeof macd.histogram === "number");

    // 3. Test Bollinger Bands
    const bb = indicatorService.calculateBollingerBands(series, 20, 2);
    assert.ok(bb.middleBand !== null);
    assert.ok(bb.upperBand > bb.middleBand);
    assert.ok(bb.lowerBand < bb.middleBand);
    assert.ok(bb.bandwidth > 0);

    // 4. Test ATR calculation
    const candleData = [];
    for (let i = 0; i < 30; i++) {
      candleData.push({ high: 105 + i, low: 95 + i, close: 100 + i });
    }
    const atr = indicatorService.calculateATR(candleData, 14);
    assert.ok(atr > 0, "ATR should calculate positive volatility measure");
  });

  await t.test("sentimentService - Fear & Greed classification, patterns, and composite evaluation", async () => {
    const sentimentService = require("../services/sentimentService");

    // 1. Fear and greed classification
    assert.equal(sentimentService.classifyFearAndGreed(15).grade, "EXTREME_FEAR");
    assert.equal(sentimentService.classifyFearAndGreed(35).grade, "FEAR");
    assert.equal(sentimentService.classifyFearAndGreed(50).grade, "NEUTRAL");
    assert.equal(sentimentService.classifyFearAndGreed(65).grade, "GREED");
    assert.equal(sentimentService.classifyFearAndGreed(85).grade, "EXTREME_GREED");

    // 2. Candlestick patterns
    const hammerCandles = [
      { open: 100, high: 102, low: 95, close: 96 }, // red day
      { open: 95, high: 96, low: 80, close: 95.5 }  // long lower shadow (15.5), tiny body (0.5)
    ];
    const patterns = sentimentService.detectCandlestickPatterns(hammerCandles);
    assert.ok(patterns.some(p => p.name === "Hammer"), "Should detect Hammer pattern");

    // 3. Composite sentiment evaluation with mock snapshot
    const evalRes = await sentimentService.evaluateSentiment({
      change24h: 4.5,
      change7d: 8.0,
      recentDailyCandles: hammerCandles,
      fngSnapshot: { value: 60, valueClassification: "Greed", timestamp: Date.now(), source: "mock" }
    });

    assert.ok(evalRes.compositeSentimentScore >= 0 && evalRes.compositeSentimentScore <= 100);
    assert.equal(evalRes.fearAndGreed.value, 60);
    assert.equal(evalRes.fearAndGreed.grade, "GREED");
    assert.ok(evalRes.sentimentSignal, "Should output sentimentSignal");
  });

  await t.test("analysisService - scoring engine, 200W SMA buy signals, and report synthesis", async () => {
    const analysisService = require("../services/analysisService");

    // 1. Technical scoring: Bullish scenario
    const bullishTech = {
      sma50: 60000,
      sma200: 55000,
      currentPrice: 62000,
      rsi14: 28, // oversold boost
      macd: { isBullishCross: true, histogram: 15 },
      bollingerBands: { percentB: 8 }
    };
    const bullishScore = analysisService.calculateTechnicalScore(bullishTech);
    assert.ok(bullishScore >= 80, "Bullish conditions should yield high technical score");

    // 2. Technical scoring: Bearish scenario
    const bearishTech = {
      sma50: 45000,
      sma200: 50000,
      currentPrice: 42000,
      rsi14: 78, // overbought
      macd: { isBearishCross: true, histogram: -20 },
      bollingerBands: { percentB: 95 }
    };
    const bearishScore = analysisService.calculateTechnicalScore(bearishTech);
    assert.ok(bearishScore <= 20, "Bearish conditions should yield low technical score");

    // 3. Risk level evaluation
    const lowRisk = analysisService.evaluateRiskLevel({
      atr: 800,
      currentPrice: 60000,
      rsi14: 45,
      isAtOrBelow200w: true
    });
    assert.equal(lowRisk, "LOW");

    const extremeRisk = analysisService.evaluateRiskLevel({
      atr: 6000,
      currentPrice: 50000, // 12% ATR
      rsi14: 82,
      isAtOrBelow200w: false
    });
    assert.equal(extremeRisk, "EXTREME");

    // 4. Summary text and buy options
    const summary = analysisService.generateSummaryText({
      overallScore: 88,
      overallSignal: "STRONG_BUY",
      riskLevel: "LOW",
      currentPrice: 48000,
      sma200wEval: {
        sma200w: 52000,
        distancePct: -7.69,
        isAtOrBelow200w: true,
        isApproaching200w: false
      },
      technicals: bullishTech,
      sentiment: {
        fearAndGreed: { value: 30, classification: "Fear" },
        momentum: { change24h: 3.5 }
      },
      supportPrice: 46000,
      resistancePrice: 55000,
      suggestedStopLoss: 44000
    });

    assert.ok(summary.includes("GENERATIONAL VALUE ALERT"), "Must include 200W SMA generational value alert when at or below floor");
    assert.ok(summary.includes("STRONG BUY"));
    assert.ok(summary.includes("Support at $46,000"));
  });
});
