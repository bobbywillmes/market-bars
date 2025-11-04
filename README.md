# market-bars

Fetch OHLC bars from Polygon.io and write per-ticker JSON + CSV for Excel. Also provides a simple HTTP API to fetch bars on demand.

## Quick start

```bash
git  clone  https://github.com/bobbywillmes/market-bars

cd  market-bars

cp  .env.example  .env  # add your POLYGON_API_KEY

npm  install

npm  start  # runs `node server.js` (HTTP API)

# optional
npm  run  cli  # runs `node index.js` (writes files)
```

## Config

-   `POLYGON_API_KEY` – required
    
Edit constants at the top of `index.js` (CLI flow):

-   `TICKERS` – array of symbols
    
-   `MULTIPLIER` / `TIMESPAN` – e.g., `1 day`, `30 minute`, `1 hour`
    
-   `RTH_ONLY` – when `TIMESPAN` is minute/hour, keep Regular Trading Hours only (06:30–13:00 PT)
    
-   Time zones: intraday timestamps are Pacific; daily emits date (America/New_York

## HTTP API

- Endpoint: `GET /api/bars`
- Query params:
  - `ticker` or `tickers` (comma‑separated)
  - `from`, `to` (YYYY-MM-DD)
  - optional: `timespan` (default `day`), `multiplier` (default `1`), `adjusted` (`true`), `sort` (`asc`), `limit` (`50000`)
- Example:

```
curl "http://localhost:3000/api/bars?ticker=AAPL&from=2024-01-01&to=2024-12-31&timespan=day"
```

Returns:

```
{
  "query": { "tickers": ["AAPL"], "from": "2024-01-01", "to": "2024-12-31", ... },
  "data": [ { "ticker": "AAPL", "count": 252, "results": [ { /* bars */ } ] } ]
}
```

## Notes

-   Pagination via `next_url` is handled automatically (with retry/backoff).
    
-   CLI outputs in `./data/`: `TICKER_TIMESPAN_FROM_to_TO.csv` and `.json`
    
-   Daily CSVs are **date-only** (exchange day) by design; intraday CSVs include local datetime (PT).
