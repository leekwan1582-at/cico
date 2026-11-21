-- Migration 011: Per-User Watchlist Customization & Portfolio View (Phase 8+ 3.4)
-- Adds sort_order, is_pinned, holding_qty, and avg_cost to user_watchlist.
-- Enables custom watchlist curation, pinning favorite pairs, and portfolio tracking with unrealised P/L.

USE crypto_alerts_db;

-- Add customization and portfolio tracking columns to user_watchlist
ALTER TABLE user_watchlist
    ADD COLUMN sort_order INT UNSIGNED NOT NULL DEFAULT 0 AFTER asset_id,
    ADD COLUMN is_pinned BOOLEAN NOT NULL DEFAULT FALSE AFTER sort_order,
    ADD COLUMN holding_qty DECIMAL(18, 8) NULL DEFAULT NULL AFTER is_pinned,
    ADD COLUMN avg_cost DECIMAL(18, 8) NULL DEFAULT NULL AFTER holding_qty;

-- Add index on user_id, is_pinned, sort_order for efficient sorted retrieval
CREATE INDEX idx_user_watchlist_order ON user_watchlist (user_id, is_pinned DESC, sort_order ASC);
