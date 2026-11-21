-- ==============================================================================
-- Migration: 002_add_notifications_to_price_alerts.sql
-- Description: Adds notification_channel and recipient_target to price_alerts table
--              to support multi-channel alerts (EMAIL, TELEGRAM, DISCORD, IN_APP).
-- Database: crypto_alerts_db
-- ==============================================================================

USE crypto_alerts_db;

ALTER TABLE price_alerts
ADD COLUMN notification_channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP',
ADD COLUMN recipient_target VARCHAR(255) NULL,
ADD COLUMN triggered_at DATETIME NULL;
