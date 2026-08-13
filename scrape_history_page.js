// Scrapes a Yahoo Finance /history/ page into a daily OHLCV CSV plus a
// month-end close CSV.
//
// Usage:
//   node scrape_history_page.js "<yahoo finance /history/ URL>"
//
// Example:
//   node scrape_history_page.js \
//     "https://finance.yahoo.com/quote/2330.TW/history/?period1=1735689600&period2=1755043200"
//
// Yahoo paints the whole requested date range into the history table on load,
// so there is no pagination or infinite scroll to drive — wait for the async
// price fetch behind the table to settle, then read the DOM once.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CSV_DIR = path.join(__dirname, 'csv');

const TABLE_ROW_SELECTOR = '[data-testid="history-table"] table tbody tr';
// A normal OHLCV row has 7 cells. Dividend and split event rows render with
// fewer, and are dropped.
const OHLCV_CELL_COUNT = 7;
const ROW_WAIT_MS = 20_000;
// waitForSelector resolves as soon as the first row exists, which is before
// the fetch behind the table has finished filling it in.
const SETTLE_MS = 4_000;

// Headed Chromium trips Yahoo's bot detection far less often than headless,
// and the macOS Actions runner has a window server, so it works in CI too.
// Set HEADLESS=1 to override (e.g. when running over SSH).
const HEADLESS = process.env.HEADLESS === '1';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VIEWPORT = { width: 1280, height: 900 };

const DAILY_HEADER = 'date,open,high,low,close,adjClose,volume';
const MONTHLY_HEADER = 'monthEndDate,adjClose';

const pad2 = (n) => String(n).padStart(2, '0');

/** Pulls the ticker out of a `/quote/<symbol>/history` URL. */
function symbolFromUrl(url) {
  const match = url.match(/\/quote\/([^/]+)\/history/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Ticker symbols reach the filesystem, so keep them to a safe subset. */
function safeFileName(symbol) {
  return symbol.replace(/[^a-zA-Z0-9.]/g, '_');
}

/**
 * Normalises a rendered date cell to YYYY-MM-DD.
 *
 * The date column is localised: hk.finance.yahoo.com renders "2026年6月29日"
 * while finance.yahoo.com renders "Jun 29, 2026".
 */
function parseDateCell(text) {
  const zh = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (zh) {
    const [, year, month, day] = zh;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  // Read back the *local* components rather than going through toISOString().
  // "Jun 29, 2026" parses as local midnight, so in any timezone east of UTC
  // the ISO form lands on the previous day.
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
}

/**
 * Yahoo renders every number with thousands separators — volume always
 * ("23,011,787"), and prices too once the ticker trades above 1000 (2330.TW
 * shows "2,440.00"). Strip them so each field is a bare number that Excel and
 * pandas read as numeric, instead of a quoted string full of commas.
 *
 * Cells with no data render as "-", which becomes an empty CSV field.
 */
function toNumericField(text) {
  const stripped = text.replace(/,/g, '');
  return stripped === '-' ? '' : stripped;
}

/** Turns one row of rendered cell text into a daily record. */
function toDailyRow(cells) {
  const [date, open, high, low, close, adjClose, volume] = cells;
  return {
    date: parseDateCell(date),
    open: toNumericField(open),
    high: toNumericField(high),
    low: toNumericField(low),
    close: toNumericField(close),
    adjClose: toNumericField(adjClose),
    volume: toNumericField(volume),
  };
}

function toDailyRows(rawRows) {
  return rawRows
    .filter((cells) => cells.length >= OHLCV_CELL_COUNT)
    .map(toDailyRow)
    .filter((row) => row.date !== null);
}

/**
 * Collapses daily rows to one row per calendar month: the last trading day of
 * that month. Rows come off the page newest-first, so the first row seen for a
 * given YYYY-MM is that month's latest date.
 */
function toMonthEndCloses(dailyRows) {
  const byMonth = dailyRows.reduce((acc, row) => {
    const month = row.date.slice(0, 7);
    return acc.has(month) ? acc : acc.set(month, row);
  }, new Map());

  return Array.from(byMonth.values())
    .map((row) => ({ monthEndDate: row.date, adjClose: row.adjClose }))
    .sort((a, b) => a.monthEndDate.localeCompare(b.monthEndDate));
}

// Every field is already comma-free by the time it gets here (see
// toNumericField), so no quoting or escaping is needed.
function toCsv(header, rows) {
  return [header, ...rows].join('\n') + '\n';
}

function toDailyCsv(dailyRows) {
  const rows = dailyRows.map(
    (r) => `${r.date},${r.open},${r.high},${r.low},${r.close},${r.adjClose},${r.volume}`
  );
  return toCsv(DAILY_HEADER, rows);
}

function toMonthlyCsv(monthlyRows) {
  const rows = monthlyRows.map((r) => `${r.monthEndDate},${r.adjClose}`);
  return toCsv(MONTHLY_HEADER, rows);
}

function writeCsv(fileName, contents, rowCount, label) {
  const filePath = path.join(CSV_DIR, fileName);
  fs.writeFileSync(filePath, contents);
  console.log(`  Wrote ${rowCount} ${label} rows to csv/${fileName}`);
}

/** Reads every history row's cell text out of the page. */
async function scrapeRawRows(page, url) {
  console.log(`Loading ${url} ...`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TABLE_ROW_SELECTOR, { timeout: ROW_WAIT_MS });
  await page.waitForTimeout(SETTLE_MS);

  return page.evaluate((selector) =>
    Array.from(document.querySelectorAll(selector)).map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())
    )
  , TABLE_ROW_SELECTOR);
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node scrape_history_page.js "<yahoo finance /history/ URL>"');
    process.exit(1);
  }

  const symbol = symbolFromUrl(url);
  if (!symbol) {
    console.error(`Could not find a /quote/<symbol>/history segment in: ${url}`);
    process.exit(1);
  }

  fs.mkdirSync(CSV_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: VIEWPORT });
    const page = await context.newPage();

    const rawRows = await scrapeRawRows(page, url);
    console.log(`  Found ${rawRows.length} rows in table.`);

    const dailyRows = toDailyRows(rawRows);
    if (dailyRows.length === 0) {
      throw new Error(
        'Table rendered but produced no usable OHLCV rows — Yahoo may have ' +
        'changed its markup, or the symbol/date range has no data.'
      );
    }

    const base = safeFileName(symbol);
    writeCsv(`${base}_history_daily.csv`, toDailyCsv(dailyRows), dailyRows.length, 'daily');

    const monthlyRows = toMonthEndCloses(dailyRows);
    writeCsv(`${base}_history_monthly.csv`, toMonthlyCsv(monthlyRows), monthlyRows.length, 'month-end');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[!] Scrape failed: ${err.message}`);
  process.exit(1);
});
