-- Migration 007: DDL Password Default Removal & Must-Change-Password Flag (S6 Hardening)
-- Removes dangerous default hash/salt from users table definition and adds must_change_password flag.

USE crypto_alerts_db;

-- 1. Alter password_hash and password_salt to drop DEFAULT
ALTER TABLE users 
  MODIFY COLUMN password_hash VARCHAR(255) NOT NULL,
  MODIFY COLUMN password_salt VARCHAR(64) NOT NULL;

-- 2. Add must_change_password boolean flag to users table
SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'users' AND column_name = 'must_change_password');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER role', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Mark seeded demo accounts with must_change_password = TRUE if they still have baseline credentials
UPDATE users 
SET must_change_password = TRUE 
WHERE username IN ('leekwan', 'trader_sg');
