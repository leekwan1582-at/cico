-- Migration 006: Per-User Watchlist Table (S3 Hardening)
-- Creates user_watchlist join table to isolate watchlist ownership per user.
-- Keeps assets as the shared master currency reference without deleting assets or other users' alerts on removal.

USE crypto_alerts_db;

CREATE TABLE IF NOT EXISTS user_watchlist (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    asset_id INT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_asset_watchlist (user_id, asset_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Backfill user_watchlist from existing alerts or assign seeded assets to all existing users
INSERT IGNORE INTO user_watchlist (user_id, asset_id)
SELECT DISTINCT u.id, a.id
FROM users u
CROSS JOIN assets a;
