function qs(id) { return document.getElementById(id); }
function fmtDate(d) { return d.toISOString().slice(0,10); }
function getParamsFromUrl() {
  const sp = new URLSearchParams(location.search);
  const obj = Object.fromEntries(sp.entries());
  if (obj.tickers == null && obj.ticker) obj.tickers = obj.ticker;
  return obj;
}
function setFormFromParams(p) {
  if (p.tickers != null) qs('tickers').value = p.tickers;
  if (p.from != null) qs('from').value = p.from;
  if (p.to != null) qs('to').value = p.to;
  if (p.timespan != null) qs('timespan').value = p.timespan;
  if (p.multiplier != null) qs('multiplier').value = p.multiplier;
  if (p.adjusted != null) qs('adjusted').value = p.adjusted;
  if (p.sort != null) qs('sort').value = p.sort;
  if (p.rthOnly != null) qs('rthOnly').checked = p.rthOnly === 'true' || p.rthOnly === true;
}
function getParamsFromForm() {
  return {
    tickers: qs('tickers').value,
    from: qs('from').value,
    to: qs('to').value,
    timespan: qs('timespan').value,
    multiplier: qs('multiplier').value,
    adjusted: qs('adjusted').value,
    sort: qs('sort').value,
    rthOnly: qs('rthOnly').checked ? 'true' : 'false',
  };
}
function updateUrl(params, { replace = false } = {}) {
  const url = new URL(location.href);
  url.search = new URLSearchParams(params).toString();
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

// default date range: last 90 days
(function initDates(){
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 90);
  qs('from').value = fmtDate(from);
  qs('to').value = fmtDate(to);
})();

const COLORS = [
  '#60a5fa','#f59e0b','#34d399','#f472b6','#f87171','#a78bfa','#22d3ee','#fbbf24','#4ade80','#fb7185'
];

async function fetchBars(params) {
  const url = new URL('/api/bars', window.location.origin);
  Object.entries(params).forEach(([k,v]) => v!=null && v!=='' && url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

function renderTable(el, payload) {
  const rows = [];
  rows.push('<thead><tr><th>Ticker</th><th>Date/Time</th><th>O</th><th>H</th><th>L</th><th>C</th><th>V</th></tr></thead><tbody>');
  for (const item of payload.data) {
    for (const b of item.results) {
      const date = new Date(b.t).toISOString().replace('T',' ').replace('.000Z','Z');
      rows.push(`<tr><td>${item.ticker}</td><td>${date}</td><td>${b.o}</td><td>${b.h}</td><td>${b.l}</td><td>${b.c}</td><td>${b.v}</td></tr>`);
    }
  }
  rows.push('</tbody>');
  el.innerHTML = rows.join('');
}

function renderSummary(el, payload){
  const parts = payload.data.map(d => `${d.ticker}: ${d.count} bars`);
  el.textContent = parts.join('  ·  ');
}

function renderTags(el, q){
  const tags = [];
  for (const [k,v] of Object.entries(q)) {
    if (k==='tickers') { tags.push(`<span class="chip">tickers: ${v.join(',')}</span>`); continue; }
    tags.push(`<span class="chip">${k}: ${v}</span>`);
  }
  el.innerHTML = tags.join('');
}

function renderLineChart(canvas, payload) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width, canvas.height);
  const pad = { l:50, r:20, t:10, b:30 };
  const W = canvas.width, H = canvas.height;
  const drawArea = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };

  // collect all points
  const series = payload.data.map((d, i) => ({
    name: d.ticker,
    color: COLORS[i % COLORS.length],
    points: d.results.map(b => ({ t: b.t, c: b.c }))
  }));

  if (!series.length || !series[0].points.length) return;
  const all = series.flatMap(s => s.points);
  const tMin = Math.min(...all.map(p => p.t));
  const tMax = Math.max(...all.map(p => p.t));
  const cMin = Math.min(...all.map(p => p.c));
  const cMax = Math.max(...all.map(p => p.c));
  const xScale = (t) => drawArea.x + ( (t - tMin) / Math.max(1, (tMax - tMin)) ) * drawArea.w;
  const yScale = (c) => drawArea.y + (1 - ( (c - cMin) / Math.max(1e-9, (cMax - cMin)) )) * drawArea.h;

  // axes
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(drawArea.x, drawArea.y);
  ctx.lineTo(drawArea.x, drawArea.y + drawArea.h);
  ctx.lineTo(drawArea.x + drawArea.w, drawArea.y + drawArea.h);
  ctx.stroke();

  // y labels
  ctx.fillStyle = '#9ca3af';
  ctx.font = '12px system-ui';
  const steps = 4;
  for (let i=0;i<=steps;i++){
    const c = cMin + (i/steps)*(cMax - cMin);
    const y = yScale(c);
    ctx.fillText(c.toFixed(2), 6, y+4);
    ctx.strokeStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(drawArea.x, y);
    ctx.lineTo(drawArea.x + drawArea.w, y);
    ctx.stroke();
  }

  // plot lines
  for (const s of series){
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    s.points.forEach((p, idx) => {
      const x = xScale(p.t), y = yScale(p.c);
      if (idx===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  }
}

function renderCandleChart(canvas, bars) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width, canvas.height);
  const pad = { l:50, r:20, t:10, b:30 };
  const W = canvas.width, H = canvas.height;
  const drawArea = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };

  if (!bars || !bars.length) return;
  const tMin = Math.min(...bars.map(b => b.t));
  const tMax = Math.max(...bars.map(b => b.t));
  const lo = Math.min(...bars.map(b => b.l));
  const hi = Math.max(...bars.map(b => b.h));
  const xScale = (t) => drawArea.x + ((t - tMin) / Math.max(1,(tMax - tMin))) * drawArea.w;
  const yScale = (p) => drawArea.y + (1 - ((p - lo) / Math.max(1e-9,(hi - lo)))) * drawArea.h;

  // axes
  ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(drawArea.x, drawArea.y);
  ctx.lineTo(drawArea.x, drawArea.y + drawArea.h);
  ctx.lineTo(drawArea.x + drawArea.w, drawArea.y + drawArea.h);
  ctx.stroke();

  // y grid/labels
  ctx.fillStyle = '#9ca3af'; ctx.font = '12px system-ui';
  const steps = 4;
  for (let i=0;i<=steps;i++){
    const p = lo + (i/steps)*(hi - lo);
    const y = yScale(p);
    ctx.fillText(p.toFixed(2), 6, y+4);
    ctx.strokeStyle = '#0f172a';
    ctx.beginPath(); ctx.moveTo(drawArea.x, y); ctx.lineTo(drawArea.x + drawArea.w, y); ctx.stroke();
  }

  // candle width
  const pxPerBar = drawArea.w / bars.length;
  const candleW = Math.max(2, Math.min(14, Math.floor(pxPerBar * 0.7)));

  for (let i=0;i<bars.length;i++){
    const b = bars[i];
    const x = xScale(b.t);
    const yO = yScale(b.o), yC = yScale(b.c), yH = yScale(b.h), yL = yScale(b.l);
    const up = b.c >= b.o;
    const color = up ? '#34d399' : '#f87171';
    const bodyTop = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));

    // wick
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
    // body
    ctx.fillStyle = color;
    ctx.fillRect(x - Math.floor(candleW/2), bodyTop, candleW, bodyH);
  }
}

async function onSubmit(e){
  e.preventDefault();
  qs('error').textContent = '';
  const params = getParamsFromForm();
  try {
    updateUrl(params, { replace: false });
    const payload = await fetchBars(params);
    renderTags(qs('tags'), payload.query);
    renderSummary(qs('summary'), payload);
    renderTable(qs('table'), payload);
    const single = payload.data.length === 1;
    if (single) {
      renderCandleChart(qs('chart'), payload.data[0].results);
    } else {
      renderLineChart(qs('chart'), payload);
    }
  } catch (err) {
    qs('error').textContent = err.message || String(err);
  }
}

qs('form').addEventListener('submit', onSubmit);

qs('download').addEventListener('click', () => {
  const params = new URLSearchParams({
    tickers: qs('tickers').value,
    from: qs('from').value,
    to: qs('to').value,
    timespan: qs('timespan').value,
    multiplier: qs('multiplier').value,
    adjusted: qs('adjusted').value,
    sort: qs('sort').value,
    rthOnly: qs('rthOnly').checked ? 'true' : 'false',
  });
  const url = `/api/bars.csv?${params.toString()}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// Load state from URL on first visit and popstate
window.addEventListener('DOMContentLoaded', async () => {
  const p = getParamsFromUrl();
  const hasQuery = Array.from(Object.keys(p)).length > 0;
  if (hasQuery) setFormFromParams(p);
  // Optionally auto-fetch if we have a complete query
  const filled = qs('tickers').value && qs('from').value && qs('to').value;
  if (hasQuery && filled) {
    try {
      const payload = await fetchBars(getParamsFromForm());
      renderTags(qs('tags'), payload.query);
      renderSummary(qs('summary'), payload);
      renderTable(qs('table'), payload);
      const single = payload.data.length === 1;
      if (single) renderCandleChart(qs('chart'), payload.data[0].results); else renderLineChart(qs('chart'), payload);
    } catch (err) {
      qs('error').textContent = err.message || String(err);
    }
  }
});

window.addEventListener('popstate', async () => {
  const p = getParamsFromUrl();
  setFormFromParams(p);
  try {
    const payload = await fetchBars(getParamsFromForm());
    renderTags(qs('tags'), payload.query);
    renderSummary(qs('summary'), payload);
    renderTable(qs('table'), payload);
    const single = payload.data.length === 1;
    if (single) renderCandleChart(qs('chart'), payload.data[0].results); else renderLineChart(qs('chart'), payload);
  } catch (err) {
    qs('error').textContent = err.message || String(err);
  }
});
