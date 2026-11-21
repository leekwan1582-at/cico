-- ==============================================================================
-- Migration: 001_add_asset_ohlcv_table.sql
-- Description: Incremental migration to create the `asset_ohlcv` historical
--              candlestick time-series table partitioned by asset and exchange.
-- Database: crypto_alerts_db
-- ==============================================================================

USE crypto_alerts_db;

-- Table 5: Asset OHLCV Historical Daily Candles (Partitioned by Asset & Exchange)
CREATE TABLE IF NOT EXISTS asset_ohlcv (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    asset_id INT UNSIGNED NOT NULL,
    exchange_id INT UNSIGNED NOT NULL,
    candle_time DATE NOT NULL,
    open_price DECIMAL(18, 8) NOT NULL,
    high_price DECIMAL(18, 8) NOT NULL,
    low_price DECIMAL(18, 8) NOT NULL,
    close_price DECIMAL(18, 8) NOT NULL,
    volume DECIMAL(24, 8) DEFAULT 0.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_asset_exchange_candle (asset_id, exchange_id, candle_time),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
