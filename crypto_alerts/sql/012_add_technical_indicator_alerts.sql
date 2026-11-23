-- Migration 012: Technical-Indicator Alerts (Phase 8+ 3.5)
-- Extends condition_metric to support technical indicators: RSI_14, SMA_CROSS, and VOLUME_SPIKE
-- All indicators can be computed from the existing asset_ohlcv table.

USE crypto_alerts_db;

-- 1. Ensure condition_metric in price_alerts supports indicators (VARCHAR(30) to allow descriptive indicator names)
ALTER TABLE price_alerts MODIFY COLUMN condition_metric VARCHAR(30) NOT NULL DEFAULT 'PRICE';

-- 2. Ensure condition_type in price_alerts supports indicator conditions (e.g. RSI_ABOVE, RSI_BELOW, SMA_GOLDEN_CROSS, SMA_DEATH_CROSS, VOLUME_SPIKE)
ALTER TABLE price_alerts MODIFY COLUMN condition_type VARCHAR(40) NOT NULL;
