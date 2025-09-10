# market-bars

Fetch OHLC bars from Polygon.io and write per-ticker JSON + CSV for Excel.

## Quick start

```bash
git  clone  https://github.com/bobbywillmes/market-bars

cd  market-bars

cp  .env.example  .env  # add your POLYGON_API_KEY

npm  install

npm  start  # runs `node index.js`
```

## Config

-   `POLYGON_API_KEY` – required
    
Edit constants at the top of `index.js`:

-   `TICKERS` – array of symbols
    
-   `MULTIPLIER` / `TIMESPAN` – e.g., `1 day`, `30 minute`, `1 hour`
    
-   `RTH_ONLY` – when `TIMESPAN` is minute/hour, keep Regular Trading Hours only (06:30–13:00 PT)
    
-   Time zones: intraday timestamps are Pacific; daily emits date (America/New_York

## Notes

-   Pagination via `next_url` is handled automatically (with retry/backoff).
    
-   Outputs in `./data/`: `TICKER_TIMESPAN_FROM_to_TO.csv` and `.json`
    
-   Daily CSVs are **date-only** (exchange day) by design; intraday CSVs include local datetime (PT).