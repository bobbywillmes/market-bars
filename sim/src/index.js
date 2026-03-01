import { readRunConfig, readCsv, writeCsv } from "./io.js";
import { normalizeOrders } from "./orders.js";
import { loadBuckets } from "./positions.js";
import { loadScenarios } from "./simulate.js";
import { ensureBarsCache, loadBarsBySymbol, inferAsOfDate } from "./bars.js";
import { reconstructPositions } from "./positions.js";
import { runSimulations } from "./simulate.js";

async function main() {
  const cfg = await readRunConfig("../inputs/run_config.csv");

  const ordersRaw = await readCsv("../inputs/orders.csv");
  const bucketsRaw = await readCsv("../inputs/ticker_buckets.csv");
  const scenariosRaw = await readCsv("../inputs/scenarios.csv");

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
  const barsBySymbol = await loadBarsBySymbol(symbols, "../cache/bars/30m");

  // 3) Choose as_of_date
  const asOfDate = cfg.as_of_date?.trim()
    ? cfg.as_of_date.trim()
    : inferAsOfDate(barsBySymbol);

  // 4) Reconstruct positions from orders (ground truth)
  const positions = reconstructPositions({ orders, buckets, asOfDate });

  // Write QA file
  await writeCsv("../outputs/positions_reconstructed.csv", positions);

  // 5) Run scenario simulations
  const simTrades = runSimulations({
    positions,
    scenarios,
    buckets,
    barsBySymbol,
    asOfDate,
  });

  await writeCsv("../outputs/sim_trades.csv", simTrades);

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