-- Migration 005: User Roles
-- Adds role column to users table ('admin', 'trader')

USE crypto_alerts_db;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'users' AND column_name = 'role');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT ''trader'' AFTER password_salt', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Grant admin role to initial admin account 'leekwan'
UPDATE users SET role = 'admin' WHERE username = 'leekwan';
