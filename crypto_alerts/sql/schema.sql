CREATE DATABASE IF NOT EXISTS crypto_alerts_db;
USE crypto_alerts_db;

-- Table 1: Users
CREATE TABLE users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(100) NOT NULL UNIQUE,
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
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table 4: Price Alerts (Links Users, Assets, and Exchanges)
CREATE TABLE price_alerts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    asset_id INT UNSIGNED NOT NULL,
    exchange_id INT UNSIGNED NOT NULL,
    target_price DECIMAL(18, 8) NOT NULL,
    condition_type VARCHAR(10) NOT NULL,      -- 'ABOVE' or 'BELOW'
    is_triggered BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (exchange_id) REFERENCES exchanges(id) ON DELETE RESTRICT
);