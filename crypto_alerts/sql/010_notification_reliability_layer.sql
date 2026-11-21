-- Migration 010: Notification Reliability Layer
-- 1. Table: user_notification_preferences (per-user notification channel preferences & quiet hours)
-- 2. Table: notification_log (retry tracking, exponential backoff, delivery status, encrypted target)

USE crypto_alerts_db;

CREATE TABLE IF NOT EXISTS user_notification_preferences (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL UNIQUE,
    default_channel VARCHAR(20) NOT NULL DEFAULT 'IN_APP', -- 'IN_APP', 'EMAIL', 'TELEGRAM', 'DISCORD'
    telegram_target VARCHAR(500) NULL,                    -- Encrypted at rest
    discord_target VARCHAR(500) NULL,                     -- Encrypted at rest
    email_target VARCHAR(255) NULL,
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    quiet_hours_start TIME NULL DEFAULT '22:00:00',       -- e.g. 22:00
    quiet_hours_end TIME NULL DEFAULT '07:00:00',         -- e.g. 07:00
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Singapore',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    alert_id INT UNSIGNED NULL,
    user_id INT UNSIGNED NOT NULL,
    channel VARCHAR(20) NOT NULL,                         -- 'IN_APP', 'EMAIL', 'TELEGRAM', 'DISCORD'
    recipient_target VARCHAR(500) NULL,                   -- Encrypted at rest
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
