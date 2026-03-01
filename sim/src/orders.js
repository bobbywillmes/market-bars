import { parseISO } from "date-fns";

function normalizeSide(s) {
  const t = String(s || "").toUpperCase();
  if (t === "BUY") return "BUY";
  if (t === "SELL") return "SELL";
  // allow E*TRADE casing
  if (t === "BOUGHT") return "BUY";
  if (t === "SOLD") return "SELL";
  return t;
}

function toNumber(x) {
  if (x === null || x === undefined) return NaN;
  return Number(String(x).replaceAll(",", "").replaceAll("†", "").trim());
}

function normalizeDate(d) {
  // accept 1/13/2026 or 2026-01-13
  const s = String(d).trim();
  if (s.includes("-")) return s;
  const [m, day, y] = s.split("/").map(v => v.trim());
  return `${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function normalizeOrders(rows) {
  const orders = rows
    .filter(r => String(r.status || "").toLowerCase() === "executed")
    .map(r => ({
      date: normalizeDate(r.date),
      order_id: Number(r.order_id),
      asset_type: r.asset_type,
      side: normalizeSide(r.side),
      qty: toNumber(r.qty),
      symbol: String(r.symbol).trim().toUpperCase(),
      price_type: r.price_type,
      term: String(r.term || "").replaceAll(" ", "").toUpperCase(),
      order_price: r.order_price,
      exec_price: toNumber(r.exec_price),
    }))
    .filter(o => o.symbol && (o.side === "BUY" || o.side === "SELL"));

  orders.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.order_id - b.order_id;
  });

  return orders;
}