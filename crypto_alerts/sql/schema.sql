CREATE DATABASE IF NOT EXISTS crypto_alerts_db;
USE crypto_alerts_db;

-- Table 1: Users
CREATE TABLE users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    password_salt VARCHAR(64) NOT NULL,
    role ENUM('ADMIN', 'TRADER') NOT NULL DEFAULT 'TRADER',
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table 2: Exchanges (e.g., OKX, Binance, Kraken)
CREATE TABLE exchanges (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ccxt_id VARCHAR(30) NOT NULL UNIQUE,      -- e.g., 'okx', 'binance'
    display_name VARCHAR(50) NOT NULL,        -- e.g., 'OKX Singapore', 'Binance'
    is_active BOOLEAN DEFAULT TRUE,
    priority_order INT UNSIGNED DEFAULT 1
);

-- Table 3: Crypto Assets
CREATE TABLE assets (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,       -- e.g., 'BTC/USDT', 'ETH/USDT'
    name VARCHAR(50) NOT NULL,                -- e.g., 'Bitcoin', 'Ethereum'
    last_d1_close DECIMAL(18, 8) DEFAULT 0.0,
    prev_d1_close DECIMAL(18, 8) DEFAULT 0.0,
    change_24h_pct DECIMAL(8, 4) DEFAULT 0.0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table 4: Price Alerts (Links Users, Assets, and Exchanges)
CREATE TABLE price_alerts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    asset_id INT UNSIGNED NOT NULL,
    exchange_id INT UNSIGNED NOT NULL,
    target_price DECIMAL(18, 8) NOT NULL,
    reference_baseline DECIMAL(18, 8) NULL,   -- Initial entry price for relative metrics
    peak_price DECIMAL(18, 8) NULL,           -- High watermark for trailing stops
    condition_type VARCHAR(30) NOT NULL,      -- 'ABOVE', 'BELOW', 'PCT_CHANGE_24H_ABOVE', 'PCT_CHANGE_24H_BELOW', 'TRAILING_STOP'
    condition_metric VARCHAR(20) NOT NULL DEFAULT 'PRICE', -- 'PRICE', 'PCT_CHANGE_24H', 'TRAILING_STOP'
    is_triggered BOOLEAN DEFAULT FALSE,
    notification_channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP', -- 'EMAIL', 'TELEGRAM', 'DISCORD', 'IN_APP'
    recipient_target VARCHAR(255) NULL,       -- Email address, Telegram chat ID, Discord webhook URL, or user handle
    triggered_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE RESTRICT
);

-- Table 5: Asset OHLCV Historical Candles (Partitioned by Asset & Exchange)
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
);

-- Table 6: Per-User Watchlist & Portfolio Holdings (Isolates watchlist membership, pinning, ordering, and portfolio per user)
CREATE TABLE IF NOT EXISTS user_watchlist (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    asset_id INT UNSIGNED NOT NULL,
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    holding_qty DECIMAL(18, 8) NULL DEFAULT NULL,
    avg_cost DECIMAL(18, 8) NULL DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_asset_watchlist (user_id, asset_id),
    INDEX idx_user_watchlist_order (user_id, is_pinned DESC, sort_order ASC),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Table 7: Alert Events & Audit Trail (Solves C1 / C9 visibility)
CREATE TABLE IF NOT EXISTS alert_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    alert_id INT UNSIGNED NOT NULL,
    event_type ENUM('CREATED', 'TRIGGERED', 'RE-ARMED', 'NOTIFIED', 'FAILED') NOT NULL,
    price_at_event DECIMAL(18, 8) NULL,
    metric_value DECIMAL(18, 8) NULL,
    message VARCHAR(255) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_alert_events_alert_id (alert_id),
    INDEX idx_alert_events_created_at (created_at),
    FOREIGN KEY (alert_id) REFERENCES price_alerts(id) ON DELETE CASCADE
);

-- Table 8: Per-User Notification Preferences (Default channel, quiet hours, encrypted targets)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL UNIQUE,
    default_channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP',
    telegram_target VARCHAR(500) NULL,
    discord_target VARCHAR(500) NULL,
    email_target VARCHAR(255) NULL,
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_hours_start TIME NULL DEFAULT '22:00:00',
    quiet_hours_end TIME NULL DEFAULT '07:00:00',
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Singapore',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table 9: Notification Delivery Log & Retry Tracking (Backoff retry, delivery status, encrypted target)
CREATE TABLE IF NOT EXISTS notification_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    alert_id INT UNSIGNED NULL,
    user_id INT UNSIGNED NOT NULL,
    channel VARCHAR(20) NOT NULL,
    recipient_target VARCHAR(500) NULL,
    status ENUM('PENDING', 'SENT', 'FAILED', 'RETRYING', 'SUPPRESSED') NOT NULL DEFAULT 'PENDING',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
    next_retry_at DATETIME NULL,
    last_error TEXT NULL,
    message_payload TEXT NULL,
    sent_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notif_user_status (user_id, status),
    INDEX idx_notif_retry (status, next_retry_at),
    FOREIGN KEY (alert_id) REFERENCES price_alerts(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
