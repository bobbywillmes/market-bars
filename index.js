import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();
import { getAggsPaginated, csvFromIntraday, csvFromDailyish } from "./lib/polygonClient.js";
import { addATR } from "./lib/atr.js";

// Local file path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.join(__dirname, "data");
await fs.mkdir(outDir, { recursive: true }); // <-- ensure folder exists

// Ensure API key exists for CLI usage
if (!process.env.POLYGON_API_KEY) {
  console.error("Missing POLYGON_API_KEY in .env");
  process.exit(1);
}

// TICKERS = ["SPY", "QQQ", "DIA", "IWM", "AAPL", "AMZN", "GOOG", "META", "MSFT"]
/** Customize here */
const TICKERS = ['GS','MSFT','CAT','HD','SHW','UNH','V','AXP','JPM','MCD','MO','FE','PSX','EVRG','CFG','LMT','COP','CSCO','VZ','CVX','KO','AGPXX','AAPL','RTX','CME','NVDA','GOOGL','MA','META','JNJ','ROST','GOOG','AVGO','COST'];
const MULTIPLIER = 1;              // 30-minute bars
const TIMESPAN = "day";            // minute, hour, day, week, month
const ADJUSTED = true;
const SORT = "asc";
const LIMIT = 50000;               // large to reduce pagination

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
// FROM = '2024-01-01';
// TO = '2025-12-31';

console.log('From', FROM, 'to', TO);

/** helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CSV helpers imported from module

async function main() {
  console.log(`Fetching ${MULTIPLIER}-${TIMESPAN} bars from ${FROM} to ${TO}`);
  const outDir = path.join(__dirname, "data");

  let allTickerData = [];

  for (const ticker of TICKERS) {
    try {
      let bars = await getAggsPaginated(ticker, {
        from: FROM,
        to: TO,
        multiplier: MULTIPLIER,
        timespan: TIMESPAN,
        adjusted: ADJUSTED,
        sort: SORT,
        limit: LIMIT,
      });

      // Calculate ATR
      bars = addATR(bars, 14);

      // Write JSON (metadata + results w/ ATR)
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

      // Write JSON file
      const jsonPath = path.join(outDir, `${ticker}_${TIMESPAN}_${FROM}_to_${TO}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(jsonOut, null, 2), "utf-8");

      // Write CSV for Excel
      const base = `${ticker}_${TIMESPAN}_${FROM}_to_${TO}`;
      const suffix = (INTRADAY && RTH_ONLY) ? "_RTH" : "";

      const csv = INTRADAY
        ? csvFromIntraday(bars, { rthOnly: RTH_ONLY })
        : csvFromDailyish(bars);
      const csvPath = path.join(outDir, `${base}${suffix}.csv`);
      await fs.writeFile(csvPath, csv, "utf-8");

      // append each ticker ohlc data to allTickerData

      console.log(`CSV : ${path.basename(csvPath)} (${INTRADAY ? "intraday" : "dailyish"})`);
      console.log(`JSON : ${path.basename(jsonPath)} (${INTRADAY ? "intraday" : "dailyish"})`);
    } catch (e) {
      console.error(`Failed for ${ticker}: ${e.message}`);
    }
  }

  // after all tickers processed, output a single csv with allTickerData

  console.log("Done.");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
