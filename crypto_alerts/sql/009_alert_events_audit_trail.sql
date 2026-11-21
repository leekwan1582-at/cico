-- Migration 009: Alert History & Audit Trail (alert_events)
-- Records CREATED / TRIGGERED / RE-ARMED / NOTIFIED / FAILED events with historical prices and metrics

USE crypto_alerts_db;

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
