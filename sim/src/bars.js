import fs from "fs/promises";
import path from "path";
import { readCsv } from "./io.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Parse "11/28/2025 6:30" -> { dateKey: "2025-11-28", minuteOfDay: 390 }
 * Assumes local timezone consistently (fine for deterministic comparisons within your dataset).
 */
export function parseBarDateTime(s) {
  const txt = String(s || "").trim();
  // M/D/YYYY H:MM
  const m = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`Unrecognized datetime format: "${txt}"`);
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = Number(m[4]);
  const min = Number(m[5]);

  const dateKey = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const minuteOfDay = hh * 60 + min;
  return { dateKey, minuteOfDay };
}

function toNum(x) {
  return Number(String(x ?? "").replaceAll(",", "").replaceAll("†", "").trim());
}

/**
 * Call your market-bars CLI to create cache files (one per symbol).
 * IMPORTANT: adjust args to match your market-bars CLI interface.
 * This is a stub that preserves the structure.
 */
export async function ensureBarsCache({
  symbols,
  startDate,
  endDate,
  rthOnly,
  multiplier,
  timespan,
  cacheDir,
}) {
  await fs.mkdir(cacheDir, { recursive: true });

  for (const sym of symbols) {
    const outPath = path.join(cacheDir, `${sym}.csv`);
    try {
      await fs.access(outPath);
      continue; // already cached
    } catch {}

    // TODO: update these args to your actual CLI options
    // The shape below is illustrative.
    await execFileAsync("npm", [
      "run",
      "cli",
      "--",
      "--symbol",
      sym,
      "--start",
      startDate,
      "--end",
      endDate,
      "--timespan",
      timespan,
      "--multiplier",
      String(multiplier),
      "--rthOnly",
      rthOnly ? "true" : "false",
      "--out",
      outPath,
    ]);
  }
}

export async function loadBarsBySymbol(symbols, cacheDir) {
  const out = new Map();

  for (const sym of symbols) {
    const rows = await readCsv(path.join(cacheDir, `${sym}.csv`));

    const bars = rows.map((r) => {
      const { dateKey, minuteOfDay } = parseBarDateTime(r.datetime);
      return {
        // keys for fast grouping/ordering:
        dateKey,
        minuteOfDay,
        // raw series:
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
        volume: toNum(r.volume),
      };
    });

    // Build a day index: dateKey -> { startIdx, endIdx } inclusive
    const dayIndex = new Map();
    let currentDay = null;
    let startIdx = 0;

    for (let i = 0; i < bars.length; i++) {
      const d = bars[i].dateKey;
      if (currentDay === null) {
        currentDay = d;
        startIdx = i;
      } else if (d !== currentDay) {
        dayIndex.set(currentDay, { startIdx, endIdx: i - 1 });
        currentDay = d;
        startIdx = i;
      }
    }
    if (currentDay !== null) {
      dayIndex.set(currentDay, { startIdx, endIdx: bars.length - 1 });
    }

    out.set(sym, { bars, dayIndex });
  }

  return out;
}

export function inferAsOfDate(barsBySymbol) {
  // Pick the latest dateKey across all symbols (since all are 30m RTH bars).
  let maxDate = "";
  for (const { bars } of barsBySymbol.values()) {
    if (!bars.length) continue;
    const lastDate = bars[bars.length - 1].dateKey;
    if (lastDate > maxDate) maxDate = lastDate;
  }
  return maxDate;
}

export function findDayRange(dayIndex, dateKey) {
  return dayIndex.get(dateKey) || null;
}