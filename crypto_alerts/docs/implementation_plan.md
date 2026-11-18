### Implementation Plan: `crypto_alerts` Web App ([UI](wireframe.md))

#### 1. Project Folder Structure

Organize the codebase cleanly into three tiers (Presentation, Business Logic, Data Storage) to satisfy the BELLS module architecture, maintain separation of concerns, and simplify your GitHub + ZIP submission:

```text
crypto_alerts/
├── config/
│   └── db.js                 # mysql2/promise connection pool
├── data/
│   └── fallback_d1.json      # Offline/geo-block D1 close prices snapshot
├── public/
│   └── css/
│       └── style.css         # Custom flexbox & Bootstrap 5 overrides
├── routes/
│   └── alertRoutes.js        # Express routes for CRUD + CCXT Refresh
├── services/
│   └── priceService.js       # CCXT exchange calls, fallback parser & alert triggers
├── sql/
│   └── schema.sql            # DDL CREATE DATABASE & CREATE TABLE statements
├── views/
│   ├── index.ejs             # Main Split-View UI (KPI strip + Form + Table)
│   └── partials/
│       ├── navbar.ejs        # Top navigation with exchange badge & refresh action
│       └── kpi_strip.ejs     # Ticker cards for BTC/ETH/SOL D1 prices
├── .env                      # DB credentials & PORT (excluded from git via .gitignore)
├── .env example              # Sample environment template for setup
├── .gitignore                # Ignores node_modules, .env
├── index.js                  # Express entry point (binds to 0.0.0.0)
├── package.json
└── seed.js                   # Populates initial users, exchanges, assets & alerts
```

> **Note on Directory Naming**: Ensure the project directory is consistently named `crypto_alerts` (with a `p`) across all scripts, documentation, and the final ZIP submission.

---

#### 2. Step-by-Step Build Phases

##### Phase 1: Environment & Dependencies Setup (LO1)

1. Initialize the Node.js project and install required packages:
```bash
mkdir crypto_alerts && cd crypto_alerts
npm init -y
npm install express ejs mysql2 ccxt dotenv
npm install --save-dev nodemon
```

2. Configure `.env` with your local MySQL credentials (`DB_HOST=127.0.0.1`, `DB_USER=root`, `DB_PASSWORD=...`, `DB_NAME=crypto_alerts_db`, `PORT=3000`). Provide `.env example` for team members and graders.

##### Phase 2: Database DDL & Seeding (LO4)

1. Execute `sql/schema.sql` in MySQL Workbench or CLI to create the 4 normalized tables (`users`, `exchanges`, `assets`, `price_alerts`) with `INT UNSIGNED` primary keys and foreign keys.

2. Run `node seed.js` to insert your baseline users, exchanges (`okx` prioritized first, `binance` second, `local_mock` third), assets (`BTC/USDT`, `ETH/USDT`, `SOL/USDT`), and sample alerts.
3. Create `data/fallback_d1.json` as your offline safety net:
```json
{
  "BTC/USDT": 89200.00,
  "ETH/USDT": 3180.00,
  "SOL/USDT": 192.50
}
```

##### Phase 3: Database Connection & Price Service (LO5 & LO6)

1. **`config/db.js`:** Export a `mysql2/promise` connection pool (`mysql.createPool(...)`) so queries use clean `async/await` syntax.
2. **`services/priceService.js` (CCXT D1 Refresh & Trigger Logic):**
   - Query active exchanges ordered by `priority_order ASC` (`okx` first).
   - Loop through `assets` and call `await exchange.fetchOHLCV(symbol, '1d', undefined, 1)` to extract the latest daily close (`candle[0][4]`).
   - Wrap CCXT calls in `try/catch`: if OKX/Binance throws a network or geo-block error, read the price from `data/fallback_d1.json` and record which source succeeded (`OKX Singapore` vs. `Offline D1 Snapshot`).
   - Run `UPDATE assets SET last_d1_close = ?, last_updated = NOW() WHERE id = ?`.
   - Run `UPDATE price_alerts` to set `is_triggered = TRUE` for any alert where `condition_type = 'ABOVE'` and `last_d1_close >= target_price` (or `'BELOW'` and `last_d1_close <= target_price`).

##### Phase 4: Express CRUD Routes (`routes/alertRoutes.js`) (LO5, LO6, LO7)

Map every UI control in Option 1 directly to your required SQL statements, delegating price refresh tasks to `services/priceService.js`:

| HTTP Route | UI Action | SQL Operation Demonstrated |
| --- | --- | --- |
| `GET /` | Load Split-View dashboard & apply filter dropdowns (`?user_id=1&status=active`) | **SELECT #1 (2+ criteria):** `SELECT ... FROM price_alerts WHERE user_id = ? AND is_triggered = ?` <br><br> **SELECT #2 (Join):** `SELECT pa.*, a.symbol, e.display_name FROM price_alerts pa JOIN assets a ... JOIN exchanges e ...` |
| `POST /alerts` | Submit "Create Alert" in left-column form | **INSERT INTO:** `INSERT INTO price_alerts (user_id, asset_id, exchange_id, target_price, condition_type) VALUES (?, ?, ?, ?, ?)` |
| `GET /?edit_id=:id` | Click **Edit** on a table row (pre-fills left form) | **SELECT (Single record):** `SELECT * FROM price_alerts WHERE id = ?` |
| `POST /alerts/:id/update` | Submit "Save Changes" in left-column form | **UPDATE:** `UPDATE price_alerts SET asset_id = ?, exchange_id = ?, target_price = ?, condition_type = ?, is_triggered = FALSE WHERE id = ?` |
| `POST /alerts/:id/delete` | Click **Delete** on a table row | **DELETE:** `DELETE FROM price_alerts WHERE id = ?` |
| `POST /refresh` | Click **[ Refresh D1 Prices ]** in top navbar | Calls `priceService.refreshAllPrices()` $\rightarrow$ Updates `assets.last_d1_close` and flags triggered `price_alerts` |

##### Phase 5: Option 1 Split-View EJS & Bootstrap 5 UI (`views/index.ejs`)

1. **Top Navbar (`views/partials/navbar.ejs`):** Brand title, active exchange source badge (`OKX Singapore`), user switcher (`leekwan` / `trader_sg`), and `<form action="/refresh" method="POST">` button.
2. **KPI Ticker Strip (`views/partials/kpi_strip.ejs`):** 3 Bootstrap flex cards rendering `BTC/USDT`, `ETH/USDT`, and `SOL/USDT` D1 close prices and sync timestamps.
3. **Left Column (`col-md-4` — Create / Edit Panel):** Single reusable form that switches between `POST /alerts` (Create mode) and `POST /alerts/:id/update` (Edit mode) when an `editAlert` object is passed from Express.
4. **Right Column (`col-md-8` — Watchlist Table & Multi-Criteria Filter):** Filter bar (`GET /` with `user_id` and `is_triggered` dropdowns) above a responsive Bootstrap table displaying alert rows with status badges (`ACTIVE` vs. `TRIGGERED`) and inline `Edit` / `Delete` actions.

##### Phase 6: Final Assessment Verification & Packaging

1. **ER Diagram Export:** Export your 4-table ER diagram (PNG/PDF) and include it in your project repository (`/docs/er-diagram.png`) and PowerPoint slides.
2. **Submission Artifacts:** Push the complete repository to GitHub (excluding `node_modules` and `.env`, including `.env.example` and `sql/schema.sql`) and compress the project folder into a `.zip` file for LMS upload.