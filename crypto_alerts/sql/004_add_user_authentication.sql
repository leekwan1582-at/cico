-- Migration 004: User Authentication & Password Hashing
-- Adds password_hash and password_salt to users table for secure authentication.

USE crypto_alerts_db;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'users' AND column_name = 'password_hash');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL AFTER email', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'crypto_alerts_db' AND table_name = 'users' AND column_name = 'password_salt');
SET @sql_stmt = IF(@col_exists = 0, 'ALTER TABLE users ADD COLUMN password_salt VARCHAR(64) NULL AFTER password_hash', 'SELECT 1');
PREPARE stmt FROM @sql_stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Populate default baseline password_hash and password_salt for any existing users with NULL passwords
-- Default password: "password123"
UPDATE users
SET 
  password_hash = '75c89040b67d232beb2433dda91fe53fc99fa84b49f13294be1bd263e0b7c0e042f920b95ad4c2a214251f2bdd8997acef67096462a6082c41d5d3a01d1f4ed2',
  password_salt = 'cd2b87a224925d88668641b86d6d33fe'
WHERE password_hash IS NULL OR password_salt IS NULL;
