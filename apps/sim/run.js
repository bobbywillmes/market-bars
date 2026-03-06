import path from "path";
import { readRunConfig, readCsv, writeCsv } from "./src/io.js";
import { normalizeOrders } from "./src/orders.js";
import { loadBuckets } from "./src/positions.js";
import { loadScenarios } from "./src/simulate.js";
import { ensureBarsCache, loadBarsBySymbol, inferAsOfDate } from "./src/bars.js";
import { reconstructPositions } from "./src/positions.js";
import { runSimulations } from "./src/simulate.js";


// Define paths
const REPO_ROOT = process.cwd();
const SIM_DIR = path.join(REPO_ROOT, "apps", "sim");
const INPUTS_DIR = path.join(SIM_DIR, "inputs");
const CACHE_DIR_30M = path.join(SIM_DIR, "cache", "bars", "30m");
const OUTPUTS_DIR = path.join(SIM_DIR, "outputs");


async function main() {
  const cfg = await readRunConfig(path.join(INPUTS_DIR, "run_config.csv"));
  console.log("Simulator Config:", cfg);

  const ordersRaw = await readCsv(path.join(INPUTS_DIR, "orders.csv"));
  const bucketsRaw = await readCsv(path.join(INPUTS_DIR, "ticker_buckets.csv"));
  const scenariosRaw = await readCsv(path.join(INPUTS_DIR, "scenarios.csv"));

  const buckets = loadBuckets(bucketsRaw);
  const orders = normalizeOrders(ordersRaw); // sorts internally
  const scenarios = loadScenarios(scenariosRaw);

  // Determine tickers we need bars for (from orders)
  const symbols = [...new Set(orders.map(o => o.symbol))];

  // Fix this later: we can optimize by only caching/loading bars for the date range of our positions, not the entire cfg.bars_start_date to cfg.bars_end_date range.
  // 1) Ensure 30m bars are cached for all symbols
  // (This will call market-bars CLI or your internal API wrapper.)
  // await ensureBarsCache({
  //   symbols,
  //   startDate: cfg.bars_start_date,
  //   endDate: cfg.bars_end_date,
  //   rthOnly: cfg.rth_only === "true",
  //   multiplier: Number(cfg.bars_multiplier || 30),
  //   timespan: cfg.bars_timespan || "minute",
  //   cacheDir: "cache/bars/30m",
  // });

  // 2) Load bars into memory maps keyed by symbol
  const barsBySymbol = await loadBarsBySymbol(symbols, CACHE_DIR_30M);

  // 3) Choose as_of_date
  const asOfDate = cfg.as_of_date?.trim()
    ? cfg.as_of_date.trim()
    : inferAsOfDate(barsBySymbol);

  // 4) Reconstruct positions from orders (ground truth)
  const positions = reconstructPositions({ orders, buckets, asOfDate });

  // Write QA file
  await writeCsv(path.join(OUTPUTS_DIR, "positions_reconstructed.csv"), positions);

  // 5) Run scenario simulations
  const simTrades = runSimulations({
    positions,
    scenarios,
    barsBySymbol,
    asOfDate,
  });

  await writeCsv(path.join(OUTPUTS_DIR, "sim_trades.csv"), simTrades);

  console.log("Done:", {
    positions: positions.length,
    simTrades: simTrades.length,
    asOfDate,
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});