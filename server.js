import express from "express";
import dotenv from "dotenv";
dotenv.config();

import { getAggsPaginated, isRTHPacific } from "./lib/massiveClient.js";
import { DateTime } from "luxon";

const app = express();
const PORT = process.env.PORT || 3000;

// lightweight CORS for quick prototyping
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// serve static frontend
app.use(express.static("public"));

app.get("/api/bars", async (req, res) => {
  try {
    const {
      ticker,
      tickers,
      from,
      to,
      multiplier = "1",
      timespan = "day",
      adjusted = "true",
      sort = "asc",
      limit = "50000",
      rthOnly = "false",
      normalize = "auto", // none | percent | base100 | auto
    } = req.query;

    const list = (tickers || ticker || "")
      .toString()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!list.length) {
      return res.status(400).json({ error: "ticker or tickers query param is required" });
    }
    if (!from || !to) {
      return res.status(400).json({ error: "from and to (YYYY-MM-DD) are required" });
    }

    const opts = {
      from,
      to,
      multiplier: Number(multiplier),
      timespan,
      adjusted: adjusted === "true" || adjusted === true,
      sort,
      limit: Number(limit),
    };

    // decide normalization mode
    let normType = "none";
    const allowed = new Set(["none", "percent", "base100", "auto"]);
    const normParam = allowed.has(String(normalize)) ? String(normalize) : "auto";
    if (normParam === "auto") normType = list.length > 1 ? "percent" : "none";
    else normType = normParam;

    const results = await Promise.all(
      list.map(async (t) => {
        let bars = await getAggsPaginated(t, opts);
        const intraday = opts.timespan === "minute" || opts.timespan === "hour";
        const useRth = rthOnly === "true" || rthOnly === true;
        if (intraday && useRth) {
          bars = bars.filter((b) => isRTHPacific(b.t));
        }

        // normalization by earliest close in the returned set
        let outBars = bars;
        if (normType !== "none" && Array.isArray(bars) && bars.length > 0) {
          const baseBar = bars.reduce((m, b) => (m == null || b.t < m.t ? b : m), null);
          const base = baseBar && Number(baseBar.c) > 0 ? Number(baseBar.c) : null;
          if (base) {
            if (normType === "percent") {
              outBars = bars.map((b) => ({ ...b, nr: Number(b.c) / base - 1 }));
            } else if (normType === "base100") {
              outBars = bars.map((b) => ({ ...b, ni: (Number(b.c) / base) * 100 }));
            }
          }
        }

        return { ticker: t, count: outBars.length, results: outBars };
      })
    );

    return res.json({
      query: { tickers: list, rthOnly: rthOnly === "true" || rthOnly === true, ...opts },
      meta: { normalize: normType },
      data: results,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(500).json({ error: msg });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/bars.csv", async (req, res) => {
  try {
    const {
      ticker,
      tickers,
      from,
      to,
      multiplier = "1",
      timespan = "day",
      adjusted = "true",
      sort = "asc",
      limit = "50000",
      rthOnly = "false",
    } = req.query;

    const list = (tickers || ticker || "")
      .toString()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!list.length) return res.status(400).send("ticker or tickers param required");
    if (!from || !to) return res.status(400).send("from and to (YYYY-MM-DD) are required");

    const opts = {
      from,
      to,
      multiplier: Number(multiplier),
      timespan,
      adjusted: adjusted === "true" || adjusted === true,
      sort,
      limit: Number(limit),
    };
    const intraday = opts.timespan === "minute" || opts.timespan === "hour";
    const useRth = rthOnly === "true" || rthOnly === true;

    let header;
    if (intraday) {
      header = "ticker,datetime,open,high,low,close,volume,vwap,transactions\n";
    } else {
      header = "ticker,date,open,high,low,close,volume,vwap,transactions\n";
    }

    const rows = [];
    for (const t of list) {
      let bars = await getAggsPaginated(t, opts);
      if (intraday && useRth) bars = bars.filter((b) => isRTHPacific(b.t));
      for (const b of bars) {
        if (intraday) {
          const dt = DateTime.fromMillis(b.t, { zone: "utc" })
            .setZone("America/Los_Angeles")
            .toFormat("yyyy-MM-dd HH:mm:ss");
          rows.push([t, dt, b.o, b.h, b.l, b.c, b.v, b.vw ?? "", b.n ?? ""].join(","));
        } else {
          const d = DateTime.fromMillis(b.t, { zone: "utc" })
            .setZone("America/New_York")
            .toISODate();
          rows.push([t, d, b.o, b.h, b.l, b.c, b.v, b.vw ?? "", b.n ?? ""].join(","));
        }
      }
    }

    const filename = `bars_${timespan}_${from}_to_${to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    return res.send(header + rows.join("\n"));
  } catch (e) {
    return res.status(500).send(e?.message || String(e));
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});
