-- Migration 003: Advanced Alert Types (PCT_CHANGE & TRAILING_STOP)
-- Adds 24h performance tracking to assets and condition metrics, baseline, and peak watermark tracking to price_alerts.

USE crypto_alerts_db;

-- 1. Add 24h percentage change & previous day close to assets table if not exists
SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'assets' AND column_name = 'prev_d1_close');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE assets ADD COLUMN prev_d1_close DECIMAL(18, 8) DEFAULT 0.0 AFTER last_d1_close', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'assets' AND column_name = 'change_24h_pct');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE assets ADD COLUMN change_24h_pct DECIMAL(8, 4) DEFAULT 0.0 AFTER prev_d1_close', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Modify condition_type column in price_alerts to support longer condition identifiers
ALTER TABLE price_alerts MODIFY COLUMN condition_type VARCHAR(30) NOT NULL;

-- 3. Add condition_metric, reference_baseline, and peak_price to price_alerts
SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'price_alerts' AND column_name = 'condition_metric');
SET @sql_stmt = IF(@col_exists = 0, "ALTER TABLE price_alerts ADD COLUMN condition_metric VARCHAR(20) NOT NULL DEFAULT 'PRICE' AFTER condition_type", 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'price_alerts' AND column_name = 'reference_baseline');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE price_alerts ADD COLUMN reference_baseline DECIMAL(18, 8) NULL AFTER target_price', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'price_alerts' AND column_name = 'peak_price');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE price_alerts ADD COLUMN peak_price DECIMAL(18, 8) NULL AFTER reference_baseline', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
