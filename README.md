# YahooFinScraper

On-demand Yahoo Finance history scraper. A GitHub Pages page triggers a GitHub
Action, the Action runs a Playwright scraper, and the resulting CSVs are
committed straight back into this repo.

**Dashboard: https://evaline8485.github.io/YahooFinScraper/**

There is no server. GitHub Actions is the compute, the repo is the database, and
GitHub Pages is the frontend — all inside the free tier.

```
docs/index.html                        browser: form → dispatch → poll → download
        │  workflow_dispatch REST API (your PAT)
        ▼
.github/workflows/scrape-on-demand.yml  macos runner: resolve dates → scrape → commit
        │
        ▼
scrape_history_page.js                  Playwright: read Yahoo's history table
        │
        ▼
csv/<SYMBOL>_history_daily.csv          committed back to main
csv/<SYMBOL>_history_monthly.csv
```

## Output

For every scrape of `<SYMBOL>`, two files land in `csv/`:

| File | Columns |
|---|---|
| `<SYMBOL>_history_daily.csv` | `date,open,high,low,close,adjClose,volume` — one row per trading day |
| `<SYMBOL>_history_monthly.csv` | `monthEndDate,adjClose` — the last trading day of each month |

Yahoo renders every number with thousands separators — volume always
(`23,011,787`), and prices too once the ticker trades above 1000 (2330.TW shows
`2,440.00`). The scraper strips those separators, so each field is a bare number
that Excel and pandas read as numeric with no import fiddling:

```
date,open,high,low,close,adjClose,volume
2026-08-13,2440.00,2445.00,2425.00,2435.00,2435.00,23011787
```

Cells Yahoo renders as `-` become empty fields.

## Setting up the token

The dashboard talks to the GitHub API as you, so it needs a token. Create a
**fine-grained** one at
[Settings → Developer settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):

| Setting | Value |
|---|---|
| Resource owner | `Evaline8485` |
| Repository access | **Only select repositories** → `YahooFinScraper` |
| Permissions → Actions | **Read and write** |
| Permissions → Contents | **Read-only** |
| Expiration | as short as you can live with |

Contents only needs read access: the commit is made by the workflow's own
`GITHUB_TOKEN`, not by your PAT.

Paste the token into the dashboard once. It is stored in that browser's
`localStorage`, sent only as an `Authorization` header to `api.github.com`, and
never written into the repo. To revoke access, delete the token on GitHub — no
code change needed.

## Running the scraper locally

Skips GitHub Actions entirely and writes into your local `csv/`:

```bash
npm install
npx playwright install chromium
node scrape_history_page.js "https://finance.yahoo.com/quote/2330.TW/history/?period1=1735689600&period2=1755043200"
```

`period1` / `period2` are Unix timestamps for the start and end of the range:

```bash
date -u -jf "%Y-%m-%d" "2025-01-01" +%s
```

A browser window opens on purpose — headed Chromium trips Yahoo's bot detection
far less often than headless. Set `HEADLESS=1` to run without a window (handy
over SSH, less reliable).

## Triggering from the CLI

Instead of the dashboard, with `gh` already authenticated:

```bash
gh workflow run scrape-on-demand.yml -f symbol=2330.TW -f from=2025-01-01 -f run_id=manual
```

## Notes and limits

- **This repo has to stay public.** GitHub Pages on a free account only
  publishes from public repos, and macOS runner minutes are only free for public
  repos (they bill at 10× the Linux rate otherwise). Everything in `csv/` is
  world-readable as a result.
- **Scraping Yahoo Finance is against its terms of service.** This is fine for
  occasional personal use, but Yahoo can change its markup or rate-limit the
  runner at any time. When that happens, the selector to fix is
  `[data-testid="history-table"]` in `scrape_history_page.js`.
- The date column is localised — `finance.yahoo.com` renders `Jun 29, 2026`
  while `hk.finance.yahoo.com` renders `2026年6月29日`. Both are parsed.
- Dividend and split rows render with fewer than 7 cells and are dropped.

## License

MIT — see [LICENSE](LICENSE).
