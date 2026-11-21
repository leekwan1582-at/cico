# Cryptocurrency Price Alert & Market Tracking Dashboard

An enterprise-ready, multi-tenant cryptocurrency market tracking and automated alerting engine built with Node.js, Express, EJS, and MariaDB / MySQL. Integrates with the [CCXT library](https://github.com/ccxt/ccxt) for multi-exchange synchronization across OKX, Binance, Kraken, and more.

---

## Features

- **Multi-Tenant Architecture & Data Isolation**:
  - Secure PBKDF2/scrypt hashed password authentication with cryptographic salt.
  - Per-user watchlist isolation (`user_watchlist` join table) so multiple traders can track assets and set alerts independently without cross-tenant leakage.
  - Role-Based Access Control (`admin` vs `trader`) protecting sensitive maintenance endpoints.
- **Advanced Alert Engine**:
  - Multi-metric triggers: absolute price levels (`ABOVE`, `BELOW`), 24-hour relative percent change (`PCT_CHANGE_24H_ABOVE`, `PCT_CHANGE_24H_BELOW`), and dynamic trailing stops (`TRAILING_STOP`).
  - Immutable one-way alert state transition (`is_triggered = TRUE`) with persistent trigger timestamp audit trail.
  - Exchange-aware price resolution matching alerts against exchange-specific OHLCV daily closes.
- **Interactive Technical Candlestick Charts**:
  - Daily (D1) candlestick charts rendered with ApexCharts via `/api/assets/:id/chart-data`.
  - In-memory market caching (1-hour TTL) and CCXT prefetching outside database transaction locks.
- **Security Hardened**:
  - Strict HTML escaping on all dynamic modal templates (SweetAlert2) to prevent stored and reflected XSS.
  - Open-redirect mitigation with relative path verification (`/^\/(?!\/|\\)/`).
  - Strict input sanitization preventing XSS injection in asset names.

---

## Relational Architecture

The system uses 6 normalized tables in MariaDB/MySQL:
1. `users`: Credentials, password salts, roles (`admin`, `trader`), and credential rotation flags.
2. `exchanges`: Integrated CCXT exchanges and priority ordering.
3. `assets`: Master cryptocurrency pairs with latest D1 close, prior day close, and 24h percentage change.
4. `price_alerts`: Alert rules referencing users, assets, and exchanges with custom metrics and high watermarks.
5. `asset_ohlcv`: Daily historical open, high, low, close, volume candlestick records.
6. `user_watchlist`: Per-user isolated asset tracking join table.
7. `alert_events`: Audit trail tracking lifecycle transitions (CREATED, TRIGGERED, RE-ARMED, NOTIFIED, FAILED).

See [docs/logical_schema_diagram.md](docs/logical_schema_diagram.md) and [docs/er-diagram.svg](docs/er-diagram.svg) for detailed documentation and diagrams.

---

## Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or later (v20+ recommended)
- **MariaDB** or **MySQL**: 10.5+ / 8.0+

### 2. Environment Configuration
Copy `.env.example` to `.env` and set your credentials:
```bash
cp .env.example .env
```

Default `.env` configuration:
```ini
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=crypto_user
DB_PASSWORD=crypto_secret
DB_NAME=crypto_alerts_db
JWT_SECRET=supersecret_jwt_key_change_in_production
NODE_ENV=development
```

### 3. Database Initialization & Migrations
Run the seed script to create the schema and seed default users, exchanges, assets, and initial alerts:
```bash
npm run migrate
```
*Alternatively, you can manually execute `sql/schema.sql` followed by `sql/seed_data.sql`.*

Incremental migration scripts are located in `sql/`:
- `001_add_auth_and_ohlcv.sql`: User credentials and OHLCV tables.
- `002_add_notification_channel_to_price_alerts.sql`: Notification dispatch metadata.
- `003_add_change_24h_pct_to_assets.sql`: 24-hour return metrics.
- `004_add_advanced_alert_fields.sql`: Relative change baselines and trailing peak watermarks.
- `005_add_role_to_users.sql`: Role-based access control (`admin`, `trader`).
- `006_add_user_watchlist_table.sql`: Multi-tenant watchlist isolation.
- `007_remove_ddl_password_defaults.sql`: DDL security hardening and credential rotation enforcement.
- `008_role_enum_rbac.sql`: Strict `ENUM('ADMIN', 'TRADER')` column upgrade for RBAC.
- `009_alert_events_audit_trail.sql`: Audit trail table tracking CREATED, TRIGGERED, RE-ARMED, NOTIFIED, FAILED events.

### 4. Running the Application
```bash
# Start in production mode
npm start

# Start in development mode with live reload
npm run dev
```
Navigate to `http://localhost:3000` in your browser.

---

## Default Seeded Accounts

| Username | Role | Password | Description |
| :--- | :--- | :--- | :--- |
| `leekwan` | `admin` | `password123` | System administrator with database reset privileges |
| `trader_sg` | `trader` | `password123` | Standard trader account with isolated watchlist |

---

## Testing

The project includes unit tests, route and security tests (IDOR, open-redirect, XSS escaping, auth guard), and real MariaDB integration tests:

```bash
npm test
```

Test Suites:
- `test/unit.test.js`: Core math, indicator calculations, and mock service logic.
- `test/routes.test.js`: Express router endpoints, authentication guards, and IDOR tenancy tests.
- `test/real_db.test.js`: End-to-end integration tests executed against a live MariaDB database.

---

## Key API Endpoints

| Method | Endpoint | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/` | Optional | Any | Main dashboard view (redirects or renders authenticated watchlist) |
| `POST` | `/login` | Public | Any | Authenticates credentials and issues signed JWT session cookie |
| `POST` | `/logout` | Authenticated | Any | Clears session cookie and redirects to `/login` |
| `POST` | `/assets` | Authenticated | Any | Adds a trading pair to user's watchlist; prefetches OHLCV |
| `POST` | `/assets/:id/delete`| Authenticated | Any | Removes asset from user's watchlist (does not wipe other users' data) |
| `POST` | `/alerts` | Authenticated | Any | Creates an alert (absolute, 24h change, or trailing stop) |
| `POST` | `/alerts/:id/delete`| Authenticated | Any | Deletes user's alert rule (guarded against IDOR) |
| `POST` | `/refresh` | Authenticated | Any | Triggers on-demand exchange sync and evaluates alert conditions |
| `GET` | `/api/assets/:id/chart-data` | Authenticated | Any | Retrieves formatted candlestick series for ApexCharts |
| `GET` | `/api/markets/catalog` | Authenticated | Any | Returns active exchange trading symbols from cached CCXT feeds |
| `GET` | `/api/alerts/:id/events` | Authenticated | Owner / Admin | Audit trail timeline of lifecycle events for a specific alert |
| `GET` | `/api/admin/health/detail` | Authenticated | `ADMIN` only | In-depth host, memory, and database connection telemetry |
| `GET` | `/api/admin/exchanges` | Authenticated | `ADMIN` only | Lists all configured exchange providers and status |
| `POST` | `/api/admin/exchanges` | Authenticated | `ADMIN` only | Registers a new CCXT exchange provider |
| `PUT` | `/api/admin/exchanges/:id` | Authenticated | `ADMIN` only | Updates exchange settings (name, priority, active state) |
| `GET` | `/api/admin/assets` | Authenticated | `ADMIN` only | Shared master asset list with total watchers and alert count |
| `DELETE` | `/api/admin/assets/:id` | Authenticated | `ADMIN` only | Permanently removes an asset from master catalog and cascades |
| `POST` | `/reset-db` | Authenticated | `ADMIN` only | Resets and re-seeds database (disabled in `NODE_ENV=production`) |
| `GET` | `/health` | Public | Any | Healthcheck probe returning database and exchange connectivity status |
