-- Migration 015: Add asset_analysis_reports table for Coin Deep Analysis Engine
-- Stores multi-dimensional analysis results: composite scores, technical indicators,
-- 200W SMA macro metrics, market sentiment, key support/resistance levels, and report payloads.

CREATE TABLE IF NOT EXISTS asset_analysis_reports (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    asset_id INT UNSIGNED NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    overall_score INT UNSIGNED NOT NULL COMMENT 'Composite score: 0 to 100',
    overall_signal ENUM('STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL') NOT NULL,
    technical_score INT UNSIGNED NOT NULL COMMENT 'Technical sub-score: 0 to 100',
    sentiment_score INT UNSIGNED NOT NULL COMMENT 'Sentiment sub-score: 0 to 100',
    risk_level ENUM('LOW', 'MODERATE', 'HIGH', 'EXTREME') NOT NULL,
    sma_200w DECIMAL(18, 8) NULL COMMENT '200-Week SMA value (Generational Bottom indicator)',
    is_below_200w_sma BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'True when current price <= 200W SMA',
    support_price DECIMAL(18, 8) NULL COMMENT 'Recommended buy/accumulation support zone',
    resistance_price DECIMAL(18, 8) NULL COMMENT 'Recommended take-profit resistance zone',
    stop_loss_price DECIMAL(18, 8) NULL COMMENT 'Recommended risk stop-loss based on ATR',
    summary_text TEXT NOT NULL COMMENT 'Executive summary & market context',
    metrics_json LONGTEXT NOT NULL COMMENT 'Detailed JSON breakdown (RSI, MACD, Bollinger Bands, FearGreed, ATR)',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reports_asset (asset_id, created_at DESC),
    INDEX idx_reports_user (user_id),
    CONSTRAINT fk_reports_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    CONSTRAINT fk_reports_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
