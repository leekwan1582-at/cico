-- Migration 008: Enforce ENUM('ADMIN', 'TRADER') for users.role
-- Upgrades users.role column to strict ENUM('ADMIN', 'TRADER') and normalizes existing values.

USE crypto_alerts_db;

-- 1. Standardize existing role values to uppercase
UPDATE users SET role = 'ADMIN' WHERE LOWER(role) = 'admin';
UPDATE users SET role = 'TRADER' WHERE LOWER(role) != 'admin' OR role IS NULL;

-- 2. Modify column definition to ENUM('ADMIN', 'TRADER') with default 'TRADER'
ALTER TABLE users MODIFY COLUMN role ENUM('ADMIN', 'TRADER') NOT NULL DEFAULT 'TRADER';
