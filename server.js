import express from "express";
import dotenv from "dotenv";
dotenv.config();

import { getAggsPaginated } from "./lib/polygonClient.js";

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

    const results = await Promise.all(
      list.map(async (t) => {
        const bars = await getAggsPaginated(t, opts);
        return { ticker: t, count: bars.length, results: bars };
      })
    );

    return res.json({ query: { tickers: list, ...opts }, data: results });
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(500).json({ error: msg });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});
