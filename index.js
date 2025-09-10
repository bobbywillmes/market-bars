import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import { DateTime } from "luxon";

// Local file path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.join(__dirname, "data");
await fs.mkdir(outDir, { recursive: true }); // <-- ensure folder exists

// Polygon API key from .env
const API_KEY = process.env.POLYGON_API_KEY;
if (!API_KEY) {
  console.error("Missing POLYGON_API_KEY in .env");
  process.exit(1);
}

// TICKERS = ["SPY", "QQQ", "DIA", "IWM", "AAPL", "AMZN", "GOOG", "META", "MSFT"]
/** Customize here */
const TICKERS = ["SPY"];
const MULTIPLIER = 1;              // 30-minute bars
const TIMESPAN = "day";          // minute, hour, day, week, month
const ADJUSTED = true;
const SORT = "asc";
const LIMIT = 50000;               // large to reduce pagination
const TIMEOUT_MS = 30_000;         // per-request timeout

// Timezones
const PACIFIC_TZ  = "America/Los_Angeles";
const EXCHANGE_TZ = "America/New_York";   // safer for daily “exchange day”

// RTH_ONLY set TRUE for regular-trading-hours only, else FALSE to include after-hours
// Note: RTH_ONLY only applies to intraday bars (minute/hour). Daily+ bars always include all hours.
const RTH_ONLY  = false;                   // set false to export all intraday bars
const INTRADAY  = (TIMESPAN === "minute" || TIMESPAN === "hour");

// compute last 3 months (inclusive)
function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
const toDate = new Date();
const fromDate = new Date();
fromDate.setMonth(fromDate.getMonth() - 3);
let FROM = ymd(fromDate);
let TO = ymd(toDate);
// set fixed range dates here instead of last 3 months
FROM = '2025-06-01';
TO = '2025-09-11';

console.log('From', FROM, 'to', TO);

/** helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * axios GET with retry/backoff for 429/5xx & error handling
 */
async function axiosGetWithRetry(url, { maxRetries = 6, baseDelay = 800 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        // Let us handle non-2xx ourselves
        validateStatus: () => true,
        headers: { Accept: "application/json" },
      });

      if (res.status >= 200 && res.status < 300) return res;

      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
        attempt += 1;
        const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`HTTP ${res.status} -> retry ${attempt}/${maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      throw new Error(`Request failed (${res.status}): ${JSON.stringify(res.data)}`);
    } catch (err) {
      // network/timeout errors also retry
      if (attempt < maxRetries) {
        attempt += 1;
        const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`Network error -> retry ${attempt}/${maxRetries} in ${delay}ms (${err.message})`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Pull paginated hourly bars via v2/aggs and next_url
 */
async function getHourlyAggsPaginated(ticker, fromYmd, toYmd) {
  let url =
    `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}` +
    `/range/${MULTIPLIER}/${TIMESPAN}/${fromYmd}/${toYmd}` +
    `?adjusted=${ADJUSTED}&sort=${SORT}&limit=${LIMIT}&apiKey=${API_KEY}`;

  const all = [];
  let pages = 0;

  while (url) {
    pages += 1;
    const res = await axiosGetWithRetry(url);
    const data = res.data || {};

    const results = Array.isArray(data.results) ? data.results : [];
    all.push(...results);

    let next = data.next_url || null;
    if (next && !/apiKey=/.test(next)) next += `&apiKey=${API_KEY}`;
    url = next;

    console.log(
      `${ticker}: page ${pages} -> ${results.length} bars (total ${all.length})` +
      (url ? " …" : " ✓")
    );

    // gentle throttle between pages (optional)
    if (url) await sleep(100);
  }

  return all;
}

// ---- helper: is bar start within RTH in Pacific? ----
function isRTHPacific(epochMs) {
  const dt = DateTime.fromMillis(epochMs, { zone: "utc" }).setZone(PACIFIC_TZ);
  const h = dt.hour, m = dt.minute;
  // US RTH 06:30–13:00 PT
  if (h > 6 && h < 13) return true;       // 7:00..12:59
  if (h === 6 && m >= 30) return true;    // 6:30+
  if (h === 13 && m === 0) return false;  // exclude 13:00 starts
  return false;
}

// Intraday CSV (Pacific time). Applies RTH filter only if RTH_ONLY is true.
function csvFromIntraday(bars) {
  const header = "datetime,open,high,low,close,volume,vwap,transactions\n";
  const filtered = (RTH_ONLY ? bars.filter(b => isRTHPacific(b.t)) : bars);

  const rows = filtered.map(b => {
    const dt = DateTime.fromMillis(b.t, { zone: "utc" })
      .setZone(PACIFIC_TZ)
      .toFormat("yyyy-MM-dd HH:mm:ss");
    return [dt, b.o, b.h, b.l, b.c, b.v, b.vw ?? "", b.n ?? ""].join(",");
  });
  return header + rows.join("\n");
}

// Daily/Weekly/Monthly CSV (date only). No RTH filter.
function csvFromDailyish(bars) {
  const header = "date,open,high,low,close,volume,vwap,transactions\n";
  const rows = bars.map(b => {
    // Use exchange (NY) date to avoid off-by-one artifacts
    const d = DateTime.fromMillis(b.t, { zone: "utc" })
      .setZone(EXCHANGE_TZ)
      .toISODate(); // e.g. 2025-06-03
    return [d, b.o, b.h, b.l, b.c, b.v, b.vw ?? "", b.n ?? ""].join(",");
  });
  return header + rows.join("\n");
}

async function main() {
  console.log(`Fetching ${MULTIPLIER}-${TIMESPAN} bars from ${FROM} to ${TO}`);
  const outDir = path.join(__dirname, "data");

  for (const ticker of TICKERS) {
    try {
      const bars = await getHourlyAggsPaginated(ticker, FROM, TO);

      // Write JSON (metadata + raw results)
      const jsonOut = {
        ticker,
        from: FROM,
        to: TO,
        multiplier: MULTIPLIER,
        timespan: TIMESPAN,
        adjusted: ADJUSTED,
        sort: SORT,
        count: bars.length,
        results: bars,
      };
      const jsonPath = path.join(outDir, `${ticker}_${TIMESPAN}_${FROM}_to_${TO}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(jsonOut, null, 2), "utf-8");

      // Write CSV for Excel
      const base = `${ticker}_${TIMESPAN}_${FROM}_to_${TO}`;
      const suffix = (INTRADAY && RTH_ONLY) ? "_RTH" : "";

      const csv = INTRADAY ? csvFromIntraday(bars) : csvFromDailyish(bars);
      const csvPath = path.join(outDir, `${base}${suffix}.csv`);
      await fs.writeFile(csvPath, csv, "utf-8");

      console.log(`CSV : ${path.basename(csvPath)} (${INTRADAY ? "intraday" : "dailyish"})`);
      console.log(`JSON : ${path.basename(jsonPath)} (${INTRADAY ? "intraday" : "dailyish"})`);
    } catch (e) {
      console.error(`Failed for ${ticker}: ${e.message}`);
    }
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
