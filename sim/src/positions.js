function toUpper(s) {
  return String(s || "").trim().toUpperCase();
}

export function loadBuckets(rows) {
  const map = new Map();
  for (const r of rows) map.set(toUpper(r.symbol), toUpper(r.bucket));
  return map;
}

function round4(x) {
  return Math.round(Number(x) * 10000) / 10000;
}

function updateAvgCost(avgCost, shares, fillPrice, fillQty) {
  return (avgCost * shares + fillPrice * fillQty) / (shares + fillQty);
}

export function reconstructPositions({ orders, buckets, asOfDate }) {
  const state = new Map(); // symbol -> { shares, avgCost, posIndex, pos }

  const results = [];

  function openNew(symbol, bucket, firstOrder) {
    const prev = state.get(symbol);
    const posIndex = (prev?.posIndex || 0) + 1;
    const position_id = `${symbol}_${String(posIndex).padStart(5, "0")}`;

    return {
      posIndex,
      pos: {
        position_id,
        symbol,
        bucket,
        status_real: "OPEN",
        open_date: firstOrder.date,
        real_exit_date: "",
        real_exit_price: "",
        entry_orders: String(firstOrder.order_id),
        add_orders: "",
        exit_order: "",
        avg_cost_real: 0,
        shares_open: 0,
        as_of_date: asOfDate,

        // --- INTERNAL (not required to write to CSV) ---
        buy_fills: [], // { date, order_id, qty, price }
      },
    };
  }

  for (const o of orders) {
    const symbol = o.symbol;
    const bucket = buckets.get(symbol) || "UNKNOWN";
    const s = state.get(symbol) || { shares: 0, avgCost: 0, posIndex: 0, pos: null };

    if (o.side === "BUY") {
      if (s.shares === 0) {
        const opened = openNew(symbol, bucket, o);
        s.posIndex = opened.posIndex;
        s.pos = opened.pos;
        s.avgCost = 0;
      } else {
        s.pos.add_orders = s.pos.add_orders ? `${s.pos.add_orders};${o.order_id}` : String(o.order_id);
      }

      // record fill
      s.pos.buy_fills.push({ date: o.date, order_id: o.order_id, qty: o.qty, price: o.exec_price });

      s.avgCost = updateAvgCost(s.avgCost, s.shares, o.exec_price, o.qty);
      s.shares += o.qty;

      s.pos.avg_cost_real = s.avgCost;
      s.pos.shares_open = s.shares;

      state.set(symbol, s);
      continue;
    }

    if (o.side === "SELL") {
      if (!s.pos || s.shares <= 0) {
        // orphan sell - ignore for v1
        continue;
      }

      // close
      s.pos.status_real = "CLOSED";
      s.pos.real_exit_date = o.date;
      s.pos.real_exit_price = String(o.exec_price);
      s.pos.exit_order = String(o.order_id);

      results.push({
        ...s.pos,
        avg_cost_real: round4(s.pos.avg_cost_real),
        shares_open: 0,
      });

      // reset
      state.set(symbol, { shares: 0, avgCost: 0, posIndex: s.posIndex, pos: null });
    }
  }

  // flush open positions
  for (const [symbol, s] of state.entries()) {
    if (s.pos && s.shares > 0) {
      results.push({
        ...s.pos,
        avg_cost_real: round4(s.pos.avg_cost_real),
        shares_open: s.shares,
      });
    }
  }

  // Keep stable order
  results.sort((a, b) =>
    a.symbol !== b.symbol ? (a.symbol < b.symbol ? -1 : 1) : a.open_date < b.open_date ? -1 : 1
  );

  return results;
}