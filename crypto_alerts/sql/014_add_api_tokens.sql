-- Migration 014: Add api_tokens table for Personal Access Tokens (PAT)
-- Supports scoped and revocable tokens for automation and external API integrations

CREATE TABLE IF NOT EXISTS api_tokens (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL COMMENT 'Descriptive token name (e.g. Trading Bot Script)',
    token_prefix VARCHAR(16) NOT NULL COMMENT 'First 10 chars for identification (e.g. cpat_a1b2c3d4)',
    token_hash VARCHAR(64) NOT NULL COMMENT 'SHA-256 hash of secret token string',
    scopes VARCHAR(255) NOT NULL DEFAULT 'read:alerts' COMMENT 'Comma-separated scopes: read:alerts,write:alerts,read:markets',
    last_used_at DATETIME NULL,
    expires_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_api_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_api_tokens_hash (token_hash),
    INDEX idx_api_tokens_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
