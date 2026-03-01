import { findDayRange } from "./bars.js";

function toNum(x) {
  if (x === null || x === undefined || x === "") return null;
  return Number(String(x).replaceAll(",", "").replaceAll("†", "").trim());
}

function toUpper(s) {
  return String(s || "").trim().toUpperCase();
}

function safePct(x) {
  const n = toNum(x);
  return n === null || Number.isNaN(n) ? null : n;
}

export function loadScenarios(rows) {
  // Keeps scenario params on each result row (super useful for filtering).
  return rows.map((r) => ({
    scenario_id: String(r.scenario_id).trim(),
    bucket: toUpper(r.bucket),
    dip_model: String(r.dip_model || "rally_peak").trim(),
    pullback_pct: safePct(r.pullback_pct) ?? 0,
    reclaim_pct: safePct(r.reclaim_pct) ?? 0,
    target_model: String(r.target_model).trim(),
    target_pct: safePct(r.target_pct),
    k: safePct(r.k),
    shtf_pct: safePct(r.shtf_pct) ?? 0,
    time_stop_days: safePct(r.time_stop_days),
  }));
}

/**
 * Rally-peak state machine:
 * - candidatePeak tracks highs
 * - when drawdown >= pullback_pct, we enter "pullback" mode, tracking pullbackLow
 * - when we reclaim >= reclaim_pct from pullbackLow, we COMMIT the candidatePeak as anchorPeak
 */
function makeRallyPeakTracker(pullbackPct, reclaimPct) {
  let state = 1; // 1 seeking peak, 2 pullback active
  let candidatePeak = null;
  let pullbackLow = null;
  let anchorPeak = null;

  function onBar(bar) {
    // Update candidate peak
    if (candidatePeak === null || bar.high > candidatePeak) {
      candidatePeak = bar.high;
      if (state === 1) {
        // if we’re seeking peak, keep anchor in sync if not committed yet
        if (anchorPeak === null) anchorPeak = candidatePeak;
      }
    }

    if (candidatePeak === null) return anchorPeak;

    const drawdown = (candidatePeak - bar.low) / candidatePeak;

    if (state === 1) {
      if (drawdown >= pullbackPct) {
        state = 2;
        pullbackLow = bar.low;
      }
    } else if (state === 2) {
      if (bar.low < pullbackLow) pullbackLow = bar.low;

      const reclaim = (bar.close - pullbackLow) / pullbackLow;
      if (reclaim >= reclaimPct) {
        // Commit candidate peak as new anchor peak
        anchorPeak = candidatePeak;
        // reset to seek the next peak
        state = 1;
        pullbackLow = null;
      }
    }

    // If no committed anchor yet, use candidatePeak
    if (anchorPeak === null) anchorPeak = candidatePeak;
    return anchorPeak;
  }

  function getAnchorPeak() {
    return anchorPeak ?? candidatePeak;
  }

  return { onBar, getAnchorPeak };
}

function tradingDayDiffInclusive(startDateKey, endDateKey, tradingDays) {
  // tradingDays = array of dateKeys in ascending order for this symbol
  const sIdx = tradingDays.indexOf(startDateKey);
  const eIdx = tradingDays.indexOf(endDateKey);
  if (sIdx === -1 || eIdx === -1) return null;
  return (eIdx - sIdx) + 1; // inclusive
}

/**
 * Find the trading day list for a symbol from its dayIndex keys.
 * dayIndex is already built from the bar series, so keys are trading days present.
 */
function getTradingDays(dayIndex) {
  return [...dayIndex.keys()].sort(); // dateKey strings sort lexicographically
}

function round4(x) {
  return Math.round(Number(x) * 10000) / 10000;
}

function computeTargetPct(scenario, dipPctAtEntry) {
  if (scenario.target_model === "fixed") return scenario.target_pct ?? 0;
  if (scenario.target_model === "dip_scaled") return (scenario.k ?? 0) * (dipPctAtEntry ?? 0);
  throw new Error(`Unknown target_model: ${scenario.target_model}`);
}

function bucketMatches(scenarioBucket, positionBucket) {
  return scenarioBucket === "ALL" || scenarioBucket === positionBucket;
}

/**
 * Main entry point: runs all scenarios across all positions.
 * barsBySymbol: Map(symbol -> { bars, dayIndex })
 */
export function runSimulations({ positions, scenarios, barsBySymbol, asOfDate }) {
  const rows = [];

  for (const pos of positions) {
    const sym = pos.symbol;
    const bucket = pos.bucket;
    const barPack = barsBySymbol.get(sym);
    if (!barPack) continue;

    for (const sc of scenarios) {
      if (!bucketMatches(sc.bucket, bucket)) continue;

      const res = simulateOne({ pos, scenario: sc, barPack, asOfDate });
      rows.push(res);
    }
  }

  return rows;
}

function simulateOne({ pos, scenario, barPack, asOfDate }) {
  const { bars, dayIndex } = barPack;
  const tradingDays = getTradingDays(dayIndex);

  // ---- Build buy fills map by dateKey (orders only have date, no time) ----
  const buyFills = (pos.buy_fills || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order_id - b.order_id));
  const firstFill = buyFills[0];
  if (!firstFill) {
    throw new Error(`Position ${pos.position_id} has no buy fills`);
  }

  const fillsByDay = new Map();
  for (const f of buyFills) {
    if (!fillsByDay.has(f.date)) fillsByDay.set(f.date, []);
    fillsByDay.get(f.date).push(f);
  }

  // ---- Establish anchor_peak and dipPct at initial entry (using executed price) ----
  const openDay = pos.open_date;
  const openRange = findDayRange(dayIndex, openDay);
  if (!openRange) {
    // No bars for the open day (holiday, missing cache, etc.)
    // Treat as OPEN_ASOF with no meaningful stats.
    return makeNoBarsRow({ pos, scenario, asOfDate });
  }

  const tracker = makeRallyPeakTracker(scenario.pullback_pct, scenario.reclaim_pct);

  // Scan bars strictly BEFORE open day to build anchor context
  for (let i = 0; i < openRange.startIdx; i++) {
    tracker.onBar(bars[i]);
  }

  const dipAnchorPeak = tracker.getAnchorPeak() ?? bars[openRange.startIdx].high;
  const entryPrice = firstFill.price;
  const dipPctAtInitialEntry = dipAnchorPeak ? (dipAnchorPeak - entryPrice) / dipAnchorPeak : 0;

  // ---- Initialize position size / avg cost and apply fills at start of each day ----
  let qty = 0;
  let avgCost = 0;

  // helper to apply any fills that occur on a dateKey
  function applyFillsForDay(dateKey) {
    const todays = fillsByDay.get(dateKey);
    if (!todays) return;
    for (const f of todays) {
      avgCost = (avgCost * qty + f.price * f.qty) / (qty + f.qty);
      qty += f.qty;
    }
  }

  // Apply fills on open day at the start of simulation day
  applyFillsForDay(openDay);

  const avgCostStart = avgCost;

  // Scenario-derived target percent is based on INITIAL dip context (not recalculated after adds)
  const targetPct = computeTargetPct(scenario, dipPctAtInitialEntry);

  // ---- Walk bars from open day to exit or as-of ----
  let targetPrice = avgCost * (1 + targetPct);
  let shtfPrice = avgCost * (1 - (scenario.shtf_pct ?? 0));

  let statusSim = "OPEN_ASOF";
  let exitReason = "NO_EXIT_ASOF";
  let simExitDate = asOfDate;
  let simExitPrice = null;

  // MFE/MAE: compute against current avgCost (updated when adds happen)
  let mfe = -Infinity; // max favorable excursion %
  let mae = Infinity;  // max adverse excursion %

  // time stop logic: interpret as trading-days-held inclusive
  const timeStopDays = scenario.time_stop_days ? Math.floor(scenario.time_stop_days) : null;

  // iterate trading days from openDay forward until asOfDate
  const startDayIdx = tradingDays.indexOf(openDay);
  const endDayIdx = tradingDays.indexOf(asOfDate);
  if (startDayIdx === -1) return makeNoBarsRow({ pos, scenario, asOfDate });
  const finalDayIdx = endDayIdx === -1 ? (tradingDays.length - 1) : endDayIdx;

  for (let dIdx = startDayIdx; dIdx <= finalDayIdx; dIdx++) {
    const dayKey = tradingDays[dIdx];
    const range = findDayRange(dayIndex, dayKey);
    if (!range) continue;

    // Apply fills at start of day (adds/double-downs)
    if (dayKey !== openDay) {
      applyFillsForDay(dayKey);
    }

    // Update exit levels after potential adds
    targetPrice = avgCost * (1 + targetPct);
    shtfPrice = avgCost * (1 - (scenario.shtf_pct ?? 0));

    // Scan bars of the day
    for (let i = range.startIdx; i <= range.endIdx; i++) {
      const b = bars[i];

      // Update excursion stats
      const favorable = (b.high - avgCost) / avgCost;
      const adverse = (b.low - avgCost) / avgCost;
      if (favorable > mfe) mfe = favorable;
      if (adverse < mae) mae = adverse;

      // Trigger checks (priority: SHTF then TARGET)
      if (b.low <= shtfPrice) {
        statusSim = "CLOSED";
        exitReason = "SHTF";
        simExitDate = dayKey;
        simExitPrice = shtfPrice;
        dIdx = finalDayIdx + 1; // break outer day loop
        break;
      }

      if (b.high >= targetPrice) {
        statusSim = "CLOSED";
        exitReason = "TARGET";
        simExitDate = dayKey;
        simExitPrice = targetPrice;
        dIdx = finalDayIdx + 1; // break outer day loop
        break;
      }
    }

    if (statusSim === "CLOSED") break;

    // Time stop: exit at CLOSE of the day when hold_days reaches N
    if (timeStopDays && (dIdx - startDayIdx + 1) >= timeStopDays) {
      const lastBar = bars[range.endIdx];
      statusSim = "CLOSED";
      exitReason = "TIME_STOP";
      simExitDate = dayKey;
      simExitPrice = lastBar.close;
      break;
    }
  }

  // If still OPEN_ASOF, exit price is last close of asOfDate
  const asOfRange = findDayRange(dayIndex, asOfDate) || findDayRange(dayIndex, tradingDays[finalDayIdx]);
  const asOfPrice = asOfRange ? bars[asOfRange.endIdx].close : null;

  if (statusSim === "OPEN_ASOF") {
    simExitPrice = asOfPrice;
  }

  const holdDays = tradingDayDiffInclusive(openDay, simExitDate, tradingDays) ?? "";
  const returnPct = simExitPrice !== null ? (simExitPrice - avgCost) / avgCost : "";

  // Real exit fields (blank if open)
  const realExitDate = pos.real_exit_date || "";
  const realExitPrice = pos.real_exit_price || "";

  return {
    scenario_id: scenario.scenario_id,
    position_id: pos.position_id,
    symbol: pos.symbol,
    bucket: pos.bucket,

    status_real: pos.status_real,
    open_date: pos.open_date,
    real_exit_date: realExitDate,
    real_exit_price: realExitPrice,

    status_sim: statusSim,
    sim_exit_date: simExitDate,
    sim_exit_price: simExitPrice !== null ? round4(simExitPrice) : "",
    exit_reason: exitReason,

    target_model: scenario.target_model,
    target_pct: scenario.target_pct ?? "",
    k: scenario.k ?? "",
    shtf_pct: scenario.shtf_pct ?? "",
    time_stop_days: scenario.time_stop_days ?? "",

    avg_cost_start: round4(avgCostStart),
    avg_cost_final: round4(avgCost),
    qty_final: qty,

    target_price: round4(targetPrice),
    shtf_price: round4(shtfPrice),

    hold_days: holdDays,
    return_pct: returnPct === "" ? "" : round4(returnPct),

    mfe_pct: Number.isFinite(mfe) ? round4(mfe) : "",
    mae_pct: Number.isFinite(mae) ? round4(mae) : "",

    dip_anchor_peak: dipAnchorPeak ? round4(dipAnchorPeak) : "",
    dip_pct_at_initial_entry: dipPctAtInitialEntry ? round4(dipPctAtInitialEntry) : "",

    as_of_date: asOfDate,
    as_of_price: asOfPrice !== null ? round4(asOfPrice) : "",
  };
}

function makeNoBarsRow({ pos, scenario, asOfDate }) {
  return {
    scenario_id: scenario.scenario_id,
    position_id: pos.position_id,
    symbol: pos.symbol,
    bucket: pos.bucket,

    status_real: pos.status_real,
    open_date: pos.open_date,
    real_exit_date: pos.real_exit_date || "",
    real_exit_price: pos.real_exit_price || "",

    status_sim: "OPEN_ASOF",
    sim_exit_date: asOfDate,
    sim_exit_price: "",
    exit_reason: "NO_BARS",

    target_model: scenario.target_model,
    target_pct: scenario.target_pct ?? "",
    k: scenario.k ?? "",
    shtf_pct: scenario.shtf_pct ?? "",
    time_stop_days: scenario.time_stop_days ?? "",

    avg_cost_start: "",
    avg_cost_final: "",
    qty_final: "",

    target_price: "",
    shtf_price: "",

    hold_days: "",
    return_pct: "",

    mfe_pct: "",
    mae_pct: "",

    dip_anchor_peak: "",
    dip_pct_at_initial_entry: "",

    as_of_date: asOfDate,
    as_of_price: "",
  };
}