# market-bars

Fetch OHLC bars from Massive.com (formerly Polygon.io).  
The project provides three tools:

1. **CLI fetcher** to download market data and save it to CSV/JSON
2. **HTTP API server** with a simple browser UI to query bars
3. **Backtesting simulator** that runs exit strategies on real trades using cached bar data

The code requires `MASSIVE_API_KEY`.

---

## Project Structure

```
apps/
  cli/        Fetch market bars from Massive
  api/        Express server + simple frontend UI
  sim/        Backtesting / trading simulator

utils/        Shared utilities (Massive client, date helpers, etc)
```

Each app is independent but shares common utilities.

---

## Quick Start

```bash
git clone https://github.com/bobbywillmes/market-bars
cd market-bars

cp .env.example .env
# add your MASSIVE_API_KEY

npm install
```

---

## Commands

Fetch and save market data

```
npm run fetch-bars
```

Start the API server

```
npm run api
```

Run the simulator

```
npm run sim
```

---

## CLI – Fetch Bars

```
npm run fetch-bars
```

Script location:

```
apps/cli/fetch-bars.js
```

Fetches market bars and writes files to:

```
apps/cli/data/
```

Outputs:

```
TICKER_TIMESPAN_FROM_TO.csv
TICKER_TIMESPAN_FROM_TO.json
```

---

## HTTP API

Start the server:

```
npm run api
```

Server file:

```
apps/api/server.js
```

Endpoint:

```
GET /api/bars
```

Query parameters:

| Parameter | Description |
|----------|-------------|
| ticker / tickers | comma-separated list |
| from | YYYY-MM-DD |
| to | YYYY-MM-DD |
| timespan | day, minute, hour |
| multiplier | bar size multiplier |
| adjusted | true/false |
| sort | asc/desc |
| limit | default 50000 |

Example request:

```
curl "http://localhost:3000/api/bars?ticker=AAPL&from=2024-01-01&to=2024-12-31&timespan=day"
```

Example response:

```json
{
  "query": { "tickers": ["AAPL"], "from": "2024-01-01", "to": "2024-12-31" },
  "data": [
    {
      "ticker": "AAPL",
      "count": 252,
      "results": []
    }
  ]
}
```

---

## Simulator

Run the simulator:

```
npm run sim
```

Entry point:

```
apps/sim/run.js
```

The simulator:

- reconstructs positions from real order history
- loads cached OHLC data
- runs exit strategies defined in CSV

Input files:

```
apps/sim/inputs/
  orders.csv
  ticker_buckets.csv
  scenarios.csv
  run_config.csv
```

Generated outputs:

```
apps/sim/outputs/
  positions_reconstructed.csv
  sim_daily_summary.csv
  sim_trades.csv
```

Cached market data:

```
apps/sim/cache/
```

---

## Configuration

Environment variables:

```
MASSIVE_API_KEY
```

---

## Timezones

- Intraday timestamps are stored in **Pacific Time**
- Daily bars emit **exchange date (America/New_York)**

---

## Notes

- Massive pagination via `next_url` is handled automatically
- Retry/backoff logic is built into the API client
- Intraday CSVs include full timestamps
- Daily CSVs emit exchange date only
