# Implementation Plan: Coin Deep Analysis Engine & Report Generator

> **Goal**: Empower users to perform on-demand, multi-dimensional **Coin Deep Analysis** (Technical, Market Sentiment, Fundamental/On-Chain & Risk Profile) for any tracked cryptocurrency asset, and generate rich, exportable reports (Interactive UI Modal, Downloadable PDF, and Markdown/JSON export).

---

## 1. Architecture & Analysis Pipeline

```mermaid
flowchart TD
    User["Trader Dashboard / Coin Card"] -->|"Click 'Deep Analysis' 🔍"| Trigger["UI Modal / API Request\nPOST /api/assets/:id/analysis"]
    
    subgraph Analysis Engine ("services/analysisService.js")
        Aggregator["Analysis Orchestrator"]
        
        subgraph Dimension 1: Technical Analysis
            TA_Engine["indicatorService.js"]
            TA_Engine --> RSI["RSI(14) Momentum"]
            TA_Engine --> SMA["SMA 20/50/200 & Crosses"]
            TA_Engine --> MACD["MACD Line, Signal & Histogram"]
            TA_Engine --> BB["Bollinger Bands & Volatility"]
            TA_Engine --> Vol["Volume Profile & Spikes"]
        end
        
        subgraph Dimension 2: Market Sentiment
            Sentiment_Engine["sentimentService.js"]
            Sentiment_Engine --> FGI["Crypto Fear & Greed Index (Live API / Fallback)"]
            Sentiment_Engine --> Vol24["24h Momentum & Volume Drift"]
            Sentiment_Engine --> Social["Community & Social Momentum Score"]
        end
        
        subgraph Dimension 3: Fundamentals & Market Structure
            Fund_Engine["marketProfileService.js"]
            Fund_Engine --> HighLow["52-Week & All-Time High/Low Drawdowns"]
            Fund_Engine --> Spread["Liquidity Depth & Exchange Price Delta"]
            Fund_Engine --> Dominance["Market Cap Category & Relative Strength"]
        end
        
        subgraph Dimension 4: Composite Scoring & Synthesis
            Scorer["Heuristic Scoring Engine (0-100 Bullish/Bearish Index)"]
            Synthesizer["Executive Summary & Key Takeaways Generator\n(Algorithmic Rule Engine + Optional LLM/Gemini Synthesis)"]
        end
        
        Aggregator --> TA_Engine
        Aggregator --> Sentiment_Engine
        Aggregator --> Fund_Engine
        TA_Engine --> Scorer
        Sentiment_Engine --> Scorer
        Fund_Engine --> Scorer
        Scorer --> Synthesizer
    end
    
    Synthesizer --> Persist["Persist to database: asset_analysis_reports"]
    Persist --> OutputModal["Interactive Interactive Analysis Modal (ApexCharts, Gauges, Scorecards)"]
    Persist --> OutputPDF["Downloadable Print-Ready PDF / HTML Report"]
    Persist --> OutputJSON["REST API / JSON / Markdown Export"]
```

---

## 2. Analysis Dimensions & Methodology

### 2.1 Technical Analysis (TA) Dimension
Leverages existing multi-timeframe candles (`1h`, `4h`, `1d`, `1w` from `asset_ohlcv`):
1. **Trend & Moving Averages**:
   - SMA 20, SMA 50, SMA 200 daily calculations.
   - **200-Week SMA (200W SMA - The "Generational Bottom" Metric)**:
     - Computed directly from weekly candles in `asset_ohlcv WHERE timeframe = '1w'` (requiring 200 weekly bars, approx. ~3.8 years of data).
     - **Generational Accumulation Signal**: In crypto market history (especially Bitcoin), the 200-week SMA has served as the ultimate macro bear market bottom / floor.
     - **Dynamic Buy Option Recommendation**:
       - When `Current Price <= 200W SMA`: Highlights a **"Generational Value / Macro Accumulate Zone (Strong Buy)"** option in the report with high conviction scoring.
       - When `Current Price` is within 5% above the 200W SMA: Highlights an **"Approaching Macro Floor / DCA Buy Zone"**.
       - Includes a 1-click **"Create Buy Alert at 200W SMA ($<price>)"** button for the trader.
   - Golden Cross / Death Cross status.
   - Price position relative to moving averages (Bullish Trend vs. Bearish Resistance).
2. **Momentum Indicators**:
   - **RSI (14)**: Overbought (>70), Oversold (<30), or Neutral (30–70).
   - **MACD (12, 26, 9)**: MACD line, Signal line, and Histogram divergence.
3. **Volatility & Bands**:
   - **Bollinger Bands (20, 2)**: Bandwidth calculation, %B position, Bollinger Squeeze detection (anticipating breakout).
   - **Average True Range (ATR)**: Volatility gauge for stop-loss distance calculation.
4. **Volume & Order Flow**:
   - 20-day Volume moving average.
   - Volume Spike multiplier and volume trend confirmation (volume increasing on up-days vs down-days).

---

### 2.2 Market Sentiment & Emotion Dimension
1. **Crypto Fear & Greed Index**:
   - Integration with Alternative.me free public REST API (`https://api.alternative.me/fng/`) with offline cached snapshot fallback.
   - Rating: Extreme Fear (0–24), Fear (25–44), Neutral (45–55), Greed (56–75), Extreme Greed (76–100).
2. **Price Action Sentiment**:
   - 24h & 7D return acceleration.
   - Bull/Bear candlestick pattern recognition (Hammer, Doji, Bullish/Bearish Engulfing).
3. **Volatility Sentiment**:
   - Trailing stop risk level and downside volatility penalty.

---

### 2.3 Fundamental & Market Structure Dimension
1. **Drawdown & High/Low Levels**:
   - All-time high / 180-day high drawdown percentage.
   - Distance from recent support and resistance levels.
2. **Cross-Exchange Liquidity & Arbitrage**:
   - Cross-exchange spread between OKX and Binance.
   - Order book liquidity depth and exchange reliability score.

---

### 2.4 Composite Synthesis & Scoring Engine (0 to 100)
A rule-based deterministic scoring algorithm outputs a unified **Signal & Sentiment Grade**:
- **80 – 100**: Strong Bullish / High Conviction Long 🟢
- **60 – 79**: Bullish / Accumulate 🟢
- **40 – 59**: Neutral / Rangebound Consolidation 🟡
- **20 – 39**: Bearish / Distribution 🔴
- **0 – 19**: Strong Bearish / High Risk Breakdown 🔴

**Executive Recommendations & Actionable Opportunities**:
- **200W SMA Macro Buy Signal**:
  - When price is $\le$ 200W SMA: Flag as **"💎 Generational Value / Macro Accumulate"** with explicit Buy Option banner.
  - Calculated percentage distance to 200W SMA: `((Current Price - 200W SMA) / 200W SMA) * 100`.
- Suggested Support Level (Buy Zone).
- Suggested Resistance Level (Take Profit Zone).
- Suggested Stop-Loss Zone based on ATR.
- Key Risk Flags (e.g. *"RSI Overbought while volume is declining: Bearish Divergence Warning"*).

---

## 3. Database Schema: `asset_analysis_reports`

Create migration `sql/015_add_asset_analysis_reports.sql`:

```sql
CREATE TABLE IF NOT EXISTS asset_analysis_reports (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    asset_id INT UNSIGNED NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    overall_score INT UNSIGNED NOT NULL COMMENT 'Composite score: 0 to 100',
    overall_signal ENUM('STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL') NOT NULL,
    technical_score INT UNSIGNED NOT NULL,
    sentiment_score INT UNSIGNED NOT NULL,
    risk_level ENUM('LOW', 'MODERATE', 'HIGH', 'EXTREME') NOT NULL,
    support_price DECIMAL(18, 8) NULL,
    resistance_price DECIMAL(18, 8) NULL,
    summary_text TEXT NOT NULL,
    metrics_json LONGTEXT NOT NULL COMMENT 'Full JSON payload of computed indicators, MACD, RSI, FearGreed, etc.',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reports_asset (asset_id, created_at DESC),
    INDEX idx_reports_user (user_id),
    CONSTRAINT fk_reports_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    CONSTRAINT fk_reports_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## 4. Proposed REST API Endpoints

1. **`POST /api/assets/:id/analysis`**:
   - Triggers analysis pipeline for asset `:id`.
   - Returns `{ success: true, report: { ... } }`.
2. **`GET /api/assets/:id/analysis/latest`**:
   - Retrieves the most recent generated analysis report for the asset (cached for 15 minutes to prevent redundant compute).
3. **`GET /api/reports/:id/pdf`** or **`GET /reports/:id/print`**:
   - Clean, print-styled HTML report optimized for **Save as PDF** or print export, with charts, metrics tables, and executive summary.
4. **`GET /api/reports/:id.json`**:
   - Clean JSON export of the complete analysis report for programmatic consumers.

---

## 5. Frontend UI & Report Presentation

1. **Trigger Buttons**:
   - Add a **🔍 Analyze** button on each asset ticker card in the KPI strip and in the Watchlist table.
2. **Interactive SweetAlert2 / Bootstrap Modal**:
   - **Scorecard Header**: Circular/Radial gauge showing Composite Score (0–100) and Signal badge (`STRONG BUY`, `NEUTRAL`, etc.).
   - **Tabbed Layout**:
     - **Tab 1: Executive Summary**: Summary text, Key Takeaways, Support/Resistance zones, Stop-loss recommendation.
     - **Tab 2: Technical Indicators**: Table of RSI, MACD, SMA 20/50/200, Bollinger Bands, Volume spikes with Bullish/Bearish status chips.
     - **Tab 3: Sentiment & Risk**: Fear & Greed gauge meter, 24h momentum, volatility metrics.
   - **Action Bar**:
     - `🖨️ Print / Save as PDF`
     - `📥 Download JSON`
     - `🔔 Create Alert from Recommendations` (pre-fills alert modal with recommended target/stop-loss).

---

## 6. Implementation Steps Summary

| Step | Action | Files |
|---|---|---|
| **1** | Create database migration for `asset_analysis_reports` | `crypto_alerts/sql/015_add_asset_analysis_reports.sql`, `sql/schema.sql` |
| **2** | Expand `priceService.js` to ingest 200+ weekly candles (`1w` lookback ~1400 days) | `crypto_alerts/services/priceService.js`, `crypto_alerts/seed.js` |
| **3** | Expand `indicatorService.js` with 200W SMA, MACD, Bollinger Bands, and ATR | `crypto_alerts/services/indicatorService.js` |
| **4** | Implement `sentimentService.js` (Fear & Greed Index API fetch + cached fallback) | `crypto_alerts/services/sentimentService.js` |
| **5** | Build `analysisService.js` (orchestrates 200W SMA buy signals, technicals, sentiment, scoring, and report synthesis) | `crypto_alerts/services/analysisService.js` |
| **6** | Add routes for report generation, retrieval, and printable PDF export | `crypto_alerts/routes/alertRoutes.js` |
| **7** | Build interactive UI modal with 200W SMA Buy Option alert shortcut and printable report template | `crypto_alerts/views/partials/kpi_strip.ejs`, `views/index.ejs`, `views/report_print.ejs` |
| **8** | Document in OpenAPI 3.0 specification | `crypto_alerts/docs/openapi.json` |
| **9** | Add unit and route integration tests | `crypto_alerts/test/unit.test.js`, `test/routes.test.js` |
