-- Migration 013: Multi-Timeframe Candles (Phase 8+ 3.6)
-- Adds timeframe ('1h', '4h', '1d', '1w') to asset_ohlcv, modifies candle_time to DATETIME,
-- and updates unique key to (asset_id, exchange_id, timeframe, candle_time).

USE crypto_alerts_db;

-- 1. Modify candle_time from DATE to DATETIME to support intraday timestamps (1h, 4h)
ALTER TABLE asset_ohlcv MODIFY COLUMN candle_time DATETIME NOT NULL;

-- 2. Add timeframe column if not already present
SET @col_exists = (
    SELECT COUNT(*) 
    FROM information_schema.columns 
    WHERE table_schema = 'crypto_alerts_db' 
      AND table_name = 'asset_ohlcv' 
      AND column_name = 'timeframe'
);
SET @sql_stmt = IF(@col_exists = 0, 
    "ALTER TABLE asset_ohlcv ADD COLUMN timeframe VARCHAR(10) NOT NULL DEFAULT '1d' AFTER exchange_id", 
    "SELECT 1"
);
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Add explicit foreign key index for asset_id and new unique constraint
-- We add idx_asset_ohlcv_asset first so dropping uq_asset_exchange_candle won't fail with ERROR 1553
ALTER TABLE asset_ohlcv ADD INDEX idx_asset_ohlcv_asset (asset_id);

-- Drop old unique key if present
SET @index_exists = (
    SELECT COUNT(*) 
    FROM information_schema.statistics 
    WHERE table_schema = 'crypto_alerts_db' 
      AND table_name = 'asset_ohlcv' 
      AND index_name = 'uq_asset_exchange_candle'
);
SET @sql_stmt = IF(@index_exists > 0, 
    "ALTER TABLE asset_ohlcv DROP INDEX uq_asset_exchange_candle", 
    "SELECT 1"
);
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add updated unique constraint if not already added
SET @uq_exists = (
    SELECT COUNT(*) 
    FROM information_schema.statistics 
    WHERE table_schema = 'crypto_alerts_db' 
      AND table_name = 'asset_ohlcv' 
      AND index_name = 'uq_asset_exchange_tf_candle'
);
SET @sql_stmt = IF(@uq_exists = 0, 
    "ALTER TABLE asset_ohlcv ADD UNIQUE KEY uq_asset_exchange_tf_candle (asset_id, exchange_id, timeframe, candle_time)", 
    "SELECT 1"
);
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
