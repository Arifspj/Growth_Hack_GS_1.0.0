# Growth Hack GS — Chrome Extension

Chrome extension that:
1. Reads the **Settings** tab of a Google Sheet (label in **Column A**, link in **Column B**).
2. Shows a floating icon on the spreadsheet page — hover/click it to open a menu with a
   **Scrape** button next to each item (and **Scrape All**), plus a **Screener login**
   section and **minimize / maximize** buttons.
3. Opens each link, scrapes the Screener.in page, and pastes it into a tab named after the
   label (**creates the tab if it does not exist**).

Tested end-to-end with **Results** → `https://www.screener.in/results/latest/?p=1`
(login-walled → handled by the built-in Screener login + auto-login).

## How it works

- **Auth**: the extension signs a JWT with your Google *service account* key
  (`extension/service_account.json`) using Web Crypto and calls the Sheets API directly.
  No local server needed.
- **Scraping**: Screener pages are fetched through a content script on `screener.in`
  (shares your logged-in session), falling back to a direct fetch for public pages.
  Pages are parsed generically (`table.data-table`, `<thead>` headers).
  - The **Latest quarterly results** page (`/results/latest/`) is a *list* — one small
    table per company — so it is flattened to **one row per company** with the latest
    quarter figures:
    `S.No | Company | Price | M.Cap (Cr) | Sales (JQ) | Sales YoY | EBIDT (JQ) | EBIDT YoY |
    Net Profit (JQ) | Net Profit YoY | EPS (JQ) | EPS YoY | Link | Score (0-100)`.
    S.No is numbered across every scraped page.
  - The **Score (0-100)** column is an automatic rating: 20 pts each for Sales, EBIDT,
    Net Profit and EPS YoY bands (≥25% → 20, ≥15% → 15, ≥5% → 10, ≥0% → 5, −10%…0% → 2,
    worse → 0) plus 20 pts for the current net margin (≥15% → 20, ≥5% → 10, >0 → 5).
    Rating labels: 80+ Excellent, 60+ Good, 40+ Average, 20+ Weak, else Poor.
  - Pagination is followed automatically. Both SSRs are supported: the numbered
    **paginator** layout (`1 2 3 … 187 · 4655 results`, used by Results) and the
    **Next**-link layout (listing/search pages). Set **Pages (0=all)** to 0 to walk
    every page in order (Reports show `Page x/187`, total results, and the URL as it
    goes).
- **Login**: the menu has a **Login to Screener** button (email / password / Remember).
  Credentials are stored in `chrome.storage.local` only when *Remember* is checked.
  If credentials are remembered, auto-login happens before each scrape.
- **Writing**: rows go to the tab named after the setting label. Two modes:
  - **Replace** (default) — clears the tab, writes headers + all scraped rows.
  - **Append** — adds only rows whose first column isn't already present (dedupes).

Each write adds the headers + scraped rows only (no timestamp column). Numeric cells are
normalized: the ₹ symbol and a leading `+` are dropped, and `⇡/⇣` become `+/-`
(e.g. `+ 11%` → `11%`, `₹ 0.06` → `0.06`, `⇣ 52%` → `-52%`).

## Install

1. **Share your Google Sheet with the service account** (Editor):
   `optionchain@ai-stocks-83934.iam.gserviceaccount.com`
   (Open the sheet → Share → paste the email).
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `extension` folder.
3. Open your Google Sheet. At the **bottom-right** you'll see the floating **⇅** icon.
4. **Hover** the icon (or click it to pin it open) — the menu expands:
   - **Login to Screener** → enter email/password once (tick *Remember* to auto-login).
   - Click **Scrape** next to a single item (e.g. only *Results*), or **Scrape All**.
   - **Minimize** collapses back to the icon; **Maximize** re-opens the full menu.
   - The popup (toolbar icon) has the same controls.

## Settings tab format

```
A1: Big Orders:-      B1: https://www.screener.in/full-text-search/?q=...
A2: Open Offers:-     B2: https://www.screener.in/full-text-search/?q=...
...
A8: Results           B8: https://www.screener.in/results/latest/?p=1
```

The trailing `:-` on labels is stripped; the tab is created with the clean label
(e.g. `Results`).

## Files

```
extension/
  manifest.json         MV3 manifest
  background.js         auth (JWT), Sheets API, scraping, writing, login/auto-login
  popup.html/.css/.js   toolbar popup UI (same controls as the floating menu)
  content.js            floating ⇅ menu on Sheets + login/fetch handlers on screener.in
  service_account.json  Google service account credentials
scripts/
  gs_api.mjs            Sheets auth/API helpers (Node)
  test_flow.mjs         end-to-end test harness
  dump_sheet.mjs        dump Settings tab
service_account.json    copy used by the Node test harness
.scratch/               throwaway tests (login flow, results-list parser) — gitignored
```

## Test / development

```bash
# Full pipeline against the sheet (auth, read Settings, scrape public page, write, verify, cleanup)
node scripts/test_flow.mjs
SHEET_ID=... node scripts/test_flow.mjs
MAX_PAGES=5 MODE=append node scripts/test_flow.mjs
```

> The `Results` URL is login-walled for anonymous requests. The Node harness scrapes a
> public page through the same code path; the extension scrapes the real `Results` page
> using the built-in login (validated with the real session in `.scratch/test_results_blocks.mjs`).

## Security

- The service account private key is embedded in the extension. Anyone who installs this
  extension can read/write sheets shared with the service account. Keep it private.
- The Screener password is sent only to screener.in (same-origin POST from a screener.in
  tab) and is persisted to `chrome.storage.local` only when **Remember** is checked.