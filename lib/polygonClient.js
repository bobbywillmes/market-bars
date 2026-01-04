import axios from "axios";
import { DateTime } from "luxon";

// Defaults
const DEFAULT_TIMEOUT_MS = 30_000;
const PACIFIC_TZ = "America/Los_Angeles";
const EXCHANGE_TZ = "America/New_York";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function axiosGetWithRetry(url, { maxRetries = 6, baseDelay = 800, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, {
        timeout: timeoutMs,
        validateStatus: () => true,
        headers: { Accept: "application/json" },
      });
      if (res.status >= 200 && res.status < 300) return res;

      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
        attempt += 1;
        const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        // eslint-disable-next-line no-console
        console.warn(`HTTP ${res.status} -> retry ${attempt}/${maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Request failed (${res.status}): ${JSON.stringify(res.data)}`);
    } catch (err) {
      if (attempt < maxRetries) {
        attempt += 1;
        const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        // eslint-disable-next-line no-console
        console.warn(`Network error -> retry ${attempt}/${maxRetries} in ${delay}ms (${err.message})`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

export async function getAggsPaginated(
  ticker,
  {
    from,
    to,
    multiplier = 1,
    timespan = "day",
    adjusted = true,
    sort = "asc",
    limit = 50000,
    apiKey = process.env.POLYGON_API_KEY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}
) {
  if (!apiKey) throw new Error("Missing POLYGON_API_KEY in environment");
  if (!ticker) throw new Error("ticker is required");
  if (!from || !to) throw new Error("from and to are required (YYYY-MM-DD)");

  let url =
    `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}` +
    `/range/${multiplier}/${timespan}/${from}/${to}` +
    `?adjusted=${adjusted}&sort=${sort}&limit=${limit}&apiKey=${apiKey}`;

  const all = [];
  while (url) {
    const res = await axiosGetWithRetry(url, { timeoutMs });
    const data = res.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    all.push(...results);

    let next = data.next_url || null;
    if (next && !/apiKey=/.test(next)) next += `&apiKey=${apiKey}`;
    url = next;
    if (url) await sleep(100);
  }
  return all;
}

export function isRTHPacific(epochMs, { pacificTz = PACIFIC_TZ } = {}) {
  const dt = DateTime.fromMillis(epochMs, { zone: "utc" }).setZone(pacificTz);
  const h = dt.hour, m = dt.minute;
  if (h > 6 && h < 13) return true; // 7:00..12:59
  if (h === 6 && m >= 30) return true; // 6:30+
  if (h === 13 && m === 0) return false; // exclude 13:00 starts
  return false;
}

export function csvFromIntraday(
  bars,
  { rthOnly = false, pacificTz = PACIFIC_TZ } = {}
) {
  const header = "datetime,open,high,low,close,volume,vwap,transactions,tr,atr14\n";
  const filtered = rthOnly ? bars.filter((b) => isRTHPacific(b.t, { pacificTz })) : bars;
  const rows = filtered.map((b) => {
    const dt = DateTime.fromMillis(b.t, { zone: "utc" })
      .setZone(pacificTz)
      .toFormat("yyyy-MM-dd HH:mm:ss");
    return [dt, b.o, b.h, b.l, b.c, b.v, b.vw ?? "", b.n ?? "", b.tr ?? "", b.atr14 ?? ""].join(",");
  });
  return header + rows.join("\n");
}

export function csvFromDailyish(bars, { exchangeTz = EXCHANGE_TZ } = {}) {
  const header = "date,open,high,low,close,volume,vwap,transactions,tr,atr14\n";
  const rows = bars.map((b) => {
    const d = DateTime.fromMillis(b.t, { zone: "utc" })
      .setZone(exchangeTz)
      .toISODate();
    return [d, b.o, b.h, b.l, b.c, b.v, b.vw ?? "", b.n ?? "", b.tr ?? "", b.atr14 ?? ""].join(",");
  });
  return header + rows.join("\n");
}

export const timezones = { PACIFIC_TZ, EXCHANGE_TZ };
