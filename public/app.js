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

const chartState = {
  mode: null, // 'line' | 'candle'
  drawArea: null,
  tMin: 0,
  tMax: 0,
  yMin: 0,
  yMax: 0,
  series: null, // for line [{ name, color, points: [{t,c}] }]
  bars: null,   // for candle [{t,o,h,l,c,...}]
  hidden: new Set(), // hidden series by name
  payload: null,
  viewTMin: null,
  viewTMax: null,
  isPanning: false,
  panStartX: 0,
  panStartView: null,
  valueFormat: 'price',
  singleType: 'candle', // preferred chart when only one visible: 'line' | 'candle'
};

function prepareCanvas(canvas){
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  let rect = canvas.getBoundingClientRect();
  let cssW = Math.floor(rect.width);
  let cssH = Math.floor(rect.height);
  // Fallbacks if layout hasn't resolved yet
  if (!cssW || !cssH) {
    cssW = Math.max(1, canvas.clientWidth || canvas.parentElement?.clientWidth || 800);
    cssH = Math.max(1, canvas.clientHeight || 360);
  }
  if (canvas.width !== Math.floor(cssW * dpr)) canvas.width = Math.floor(cssW * dpr);
  if (canvas.height !== Math.floor(cssH * dpr)) canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: cssW, height: cssH, dpr };
}

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

function renderLegend(el, payload, mode, seriesColors) {
  const items = [];
  if (mode === 'line') {
    for (let i=0;i<payload.data.length;i++){
      const t = payload.data[i].ticker;
      const color = seriesColors[i % seriesColors.length];
      const disabled = chartState.hidden.has(t) ? ' disabled' : '';
      items.push(`<span class="item${disabled}" data-name="${t}"><span class="swatch" style="background:${color}"></span>${t}</span>`);
    }
  } else if (mode === 'candle' && payload.data.length === 1) {
    const t = payload.data[0].ticker;
    items.push(`<span class="item"><span class="swatch" style="background:#34d399"></span>${t} (candles)</span>`);
  }
  el.innerHTML = items.join('');
}

function renderLineChart(canvas, payload) {
  const { ctx, width: W, height: H } = prepareCanvas(canvas);
  ctx.clearRect(0,0,W, H);
  const pad = { l:50, r:20, t:10, b:30 };
  const drawArea = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };

  // collect all points
  const normMode = (payload.meta && payload.meta.normalize) || 'none';
  const visible = payload.data.filter((d) => !chartState.hidden.has(d.ticker));
  const useNorm = normMode !== 'none' && visible.length > 1;
  const series = visible.map((d, i) => ({
    name: d.ticker,
    color: COLORS[i % COLORS.length],
    points: d.results.map(b => ({
      t: b.t,
      c: useNorm
        ? (normMode === 'percent' ? (b.nr ?? b.c)
           : normMode === 'base100' ? (b.ni ?? b.c)
           : b.c)
        : b.c,
    }))
  }));

  if (!series.length || !series[0].points.length) return;
  const all = series.flatMap(s => s.points);
  const dataTMin = Math.min(...all.map(p => p.t));
  const dataTMax = Math.max(...all.map(p => p.t));
  const viewTMin = chartState.viewTMin ?? dataTMin;
  const viewTMax = chartState.viewTMax ?? dataTMax;
  const ptsInView = all.filter(p => p.t >= viewTMin && p.t <= viewTMax);
  const cMin = ptsInView.length ? Math.min(...ptsInView.map(p => p.c)) : Math.min(...all.map(p => p.c));
  const cMax = ptsInView.length ? Math.max(...ptsInView.map(p => p.c)) : Math.max(...all.map(p => p.c));
  const xScale = (t) => drawArea.x + ( (t - viewTMin) / Math.max(1, (viewTMax - viewTMin)) ) * drawArea.w;
  const yScale = (c) => drawArea.y + (1 - ( (c - cMin) / Math.max(1e-9, (cMax - cMin)) )) * drawArea.h;

  // axes
  ctx.strokeStyle = '#475569';
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
    let label = c.toFixed(2);
    if (useNorm && normMode === 'percent') label = (c*100).toFixed(1) + '%';
    else if (useNorm && normMode === 'base100') label = c.toFixed(1);
    ctx.fillText(label, 6, y+4);
    ctx.strokeStyle = '#1f2937';
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

  // save state for tooltips
  chartState.mode = 'line';
  chartState.drawArea = drawArea;
  chartState.tMin = viewTMin; chartState.tMax = viewTMax;
  chartState.yMin = cMin; chartState.yMax = cMax;
  chartState.series = series; chartState.bars = null;
  chartState.valueFormat = useNorm ? (normMode === 'percent' ? 'percent' : 'index') : 'price';
}

function renderCandleChart(canvas, bars) {
  const { ctx, width: W, height: H } = prepareCanvas(canvas);
  ctx.clearRect(0,0,W, H);
  const pad = { l:50, r:20, t:10, b:30 };
  const drawArea = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };

  if (!bars || !bars.length) return;
  const dataTMin = Math.min(...bars.map(b => b.t));
  const dataTMax = Math.max(...bars.map(b => b.t));
  const viewTMin = chartState.viewTMin ?? dataTMin;
  const viewTMax = chartState.viewTMax ?? dataTMax;
  const inView = bars.filter(b => b.t >= viewTMin && b.t <= viewTMax);
  const lo = inView.length ? Math.min(...inView.map(b => b.l)) : Math.min(...bars.map(b => b.l));
  const hi = inView.length ? Math.max(...inView.map(b => b.h)) : Math.max(...bars.map(b => b.h));
  const xScale = (t) => drawArea.x + ((t - viewTMin) / Math.max(1,(viewTMax - viewTMin))) * drawArea.w;
  const yScale = (p) => drawArea.y + (1 - ((p - lo) / Math.max(1e-9,(hi - lo)))) * drawArea.h;

  // axes
  ctx.strokeStyle = '#475569'; ctx.lineWidth = 1;
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
    ctx.strokeStyle = '#1f2937';
    ctx.beginPath(); ctx.moveTo(drawArea.x, y); ctx.lineTo(drawArea.x + drawArea.w, y); ctx.stroke();
  }

  // candle width
  const cnt = Math.max(1, inView.length || bars.length);
  const pxPerBar = drawArea.w / cnt;
  const candleW = Math.max(2, Math.min(14, Math.floor(pxPerBar * 0.7)));

  for (let i=0;i<bars.length;i++){
    const b = bars[i];
    if (b.t < viewTMin || b.t > viewTMax) continue;
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

  // save state for tooltips
  chartState.mode = 'candle';
  chartState.drawArea = drawArea;
  chartState.tMin = viewTMin; chartState.tMax = viewTMax;
  chartState.yMin = lo; chartState.yMax = hi;
  chartState.series = null; chartState.bars = bars;
}

async function onSubmit(e){
  e.preventDefault();
  qs('error').textContent = '';
  const params = getParamsFromForm();
  try {
    updateUrl(params, { replace: false });
    const payload = await fetchBars(params);
    chartState.payload = payload;
    chartState.hidden = new Set(); // reset hidden on new data
    // reset view to full data range
    chartState.viewTMin = null; chartState.viewTMax = null;
    renderTags(qs('tags'), payload.query);
    renderSummary(qs('summary'), payload);
    renderTable(qs('table'), payload);
    const visible = payload.data.filter((d) => !chartState.hidden.has(d.ticker));
    const isSingle = visible.length === 1;
    const legendEl = qs('legend');
    // chart type control enabled state
    qs('chartTypeSingle').disabled = !isSingle;
    if (isSingle && chartState.singleType === 'candle') {
      renderCandleChart(qs('chart'), visible[0].results);
      renderLegend(legendEl, { ...payload, data: [visible[0]] }, 'candle', COLORS);
    } else {
      renderLineChart(qs('chart'), payload);
      renderLegend(legendEl, payload, 'line', COLORS);
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
      chartState.payload = payload;
      chartState.hidden = new Set();
      chartState.viewTMin = null; chartState.viewTMax = null;
      renderTags(qs('tags'), payload.query);
      renderSummary(qs('summary'), payload);
      renderTable(qs('table'), payload);
      const visible = payload.data.filter((d) => !chartState.hidden.has(d.ticker));
      const isSingle = visible.length === 1;
      const legendEl = qs('legend');
      qs('chartTypeSingle').disabled = !isSingle;
      if (isSingle && chartState.singleType === 'candle') {
        renderCandleChart(qs('chart'), visible[0].results);
        renderLegend(legendEl, { ...payload, data: [visible[0]] }, 'candle', COLORS);
      } else {
        renderLineChart(qs('chart'), payload);
        renderLegend(legendEl, payload, 'line', COLORS);
      }
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
    chartState.payload = payload;
    chartState.hidden = new Set();
    chartState.viewTMin = null; chartState.viewTMax = null;
    renderTags(qs('tags'), payload.query);
    renderSummary(qs('summary'), payload);
    renderTable(qs('table'), payload);
    const visible = payload.data.filter((d) => !chartState.hidden.has(d.ticker));
    const isSingle = visible.length === 1;
    const legendEl = qs('legend');
    qs('chartTypeSingle').disabled = !isSingle;
    if (isSingle && chartState.singleType === 'candle') {
      renderCandleChart(qs('chart'), visible[0].results);
      renderLegend(legendEl, { ...payload, data: [visible[0]] }, 'candle', COLORS);
    } else {
      renderLineChart(qs('chart'), payload);
      renderLegend(legendEl, payload, 'line', COLORS);
    }
  } catch (err) {
    qs('error').textContent = err.message || String(err);
  }
});

function nearestIndexByTime(points, targetT){
  if (!points || points.length === 0) return -1;
  let lo=0, hi=points.length-1;
  // binary search for nearest by t
  while (lo < hi) {
    const mid = Math.floor((lo+hi)/2);
    if (points[mid].t < targetT) lo = mid + 1; else hi = mid;
  }
  const idx = lo;
  const prev = Math.max(0, idx-1);
  const choosePrev = Math.abs(points[prev].t - targetT) <= Math.abs(points[idx].t - targetT);
  return choosePrev ? prev : idx;
}

function formatTooltipTime(t){
  try {
    return new Date(t).toLocaleString();
  } catch { return new Date(t).toISOString().replace('T',' ').replace('.000Z','Z'); }
}

function handleMouseMove(evt){
  const canvas = qs('chart');
  const rect = canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  const tt = qs('tooltip');
  const overlay = qs('overlay');
  const { ctx: octx, width: OW, height: OH } = prepareCanvas(overlay);
  octx.clearRect(0,0,OW,OH);
  if (!chartState.drawArea) return;

  const { x:dx, y:dy, w:dw, h:dh } = chartState.drawArea;
  if (x < dx || x > dx+dw || y < dy || y > dy+dh) {
    tt.style.display = 'none';
    // clear overlay when out
    octx.clearRect(0,0,OW,OH);
    return;
  }
  const ratio = (x - dx) / Math.max(1, dw);
  const targetT = chartState.tMin + ratio * (chartState.tMax - chartState.tMin);

  let html = '';
  // draw crosshair (vertical + horizontal)
  octx.strokeStyle = '#334155';
  octx.lineWidth = 1;
  octx.beginPath();
  octx.moveTo(x, dy);
  octx.lineTo(x, dy + dh);
  octx.stroke();
  octx.beginPath();
  octx.moveTo(dx, y);
  octx.lineTo(dx + dw, y);
  octx.stroke();
  // y-value label near axis
  const yVal = chartState.yMin + (1 - ((y - dy) / Math.max(1, dh))) * (chartState.yMax - chartState.yMin);
  const fmt = chartState.valueFormat || 'price';
  const label = fmt === 'percent' ? (yVal*100).toFixed(2) + '%' : yVal.toFixed(2);
  const padding = 4;
  octx.font = '12px system-ui';
  const metrics = octx.measureText(label);
  const boxW = Math.ceil(metrics.width) + padding * 2;
  const boxH = 18;
  const bx = Math.max(0, dx - boxW - 6);
  const by = Math.max(dy, Math.min(dy + dh - boxH, y - boxH/2));
  octx.fillStyle = 'rgba(15,23,42,0.9)';
  octx.strokeStyle = '#374151';
  octx.lineWidth = 1;
  octx.fillRect(bx, by, boxW, boxH);
  octx.strokeRect(bx, by, boxW, boxH);
  octx.fillStyle = '#e5e7eb';
  octx.fillText(label, bx + padding, by + boxH - 5);

  if (chartState.mode === 'line' && chartState.series) {
    let titleT = null;
    const lines = [];
    for (let i=0;i<chartState.series.length;i++){
      const s = chartState.series[i];
      const idx = nearestIndexByTime(s.points, targetT);
      if (idx >= 0) {
        const p = s.points[idx];
        if (titleT == null || Math.abs(p.t - targetT) < Math.abs(titleT - targetT)) titleT = p.t;
        const fmt = chartState.valueFormat || 'price';
        const val = fmt === 'percent' ? (p.c*100).toFixed(2) + '%' : p.c;
        lines.push(`<div><span style="display:inline-block;width:10px;height:10px;background:${s.color};border:1px solid #374151;margin-right:6px"></span>${s.name}: <b>${val}</b></div>`);
        // marker
        const yVal = chartState.yMin + (chartState.yMax - chartState.yMin) * 0; // placeholder
        const yScale = (c) => chartState.drawArea.y + (1 - ( (c - chartState.yMin) / Math.max(1e-9, (chartState.yMax - chartState.yMin)) )) * chartState.drawArea.h;
        const xScale = (t) => chartState.drawArea.x + ( (t - chartState.tMin) / Math.max(1, (chartState.tMax - chartState.tMin)) ) * chartState.drawArea.w;
        const px = xScale(p.t), py = yScale(p.c);
        octx.fillStyle = s.color;
        octx.beginPath(); octx.arc(px, py, 3, 0, Math.PI*2); octx.fill();
      }
    }
    if (titleT != null) html = `<div style="margin-bottom:4px;color:#9ca3af">${formatTooltipTime(titleT)}</div>` + lines.join('');
  } else if (chartState.mode === 'candle' && chartState.bars) {
    // approximate index by proportion
    const bars = chartState.bars;
    const idx = nearestIndexByTime(bars.map(b => ({ t: b.t })), targetT);
    if (idx >= 0) {
      const b = bars[idx];
      html = `
        <div style="margin-bottom:4px;color:#9ca3af">${formatTooltipTime(b.t)}</div>
        <div>O: <b>${b.o}</b> H: <b>${b.h}</b> L: <b>${b.l}</b> C: <b>${b.c}</b></div>
        <div>V: <b>${b.v}</b></div>
      `;
      // candle highlight line at x
      const xScale = (t) => chartState.drawArea.x + ( (t - chartState.tMin) / Math.max(1, (chartState.tMax - chartState.tMin)) ) * chartState.drawArea.w;
      const cx = xScale(b.t);
      octx.strokeStyle = '#334155';
      octx.beginPath(); octx.moveTo(cx, chartState.drawArea.y); octx.lineTo(cx, chartState.drawArea.y + chartState.drawArea.h); octx.stroke();
      // highlight body area
      const yScale = (p) => chartState.drawArea.y + (1 - ((p - chartState.yMin) / Math.max(1e-9,(chartState.yMax - chartState.yMin)))) * chartState.drawArea.h;
      const yO = yScale(b.o), yC = yScale(b.c);
      const bodyTop = Math.min(yO, yC);
      const bodyH = Math.max(1, Math.abs(yC - yO));
      const candleW = Math.max(2, Math.min(14, Math.floor(chartState.drawArea.w / 60)));
      octx.fillStyle = 'rgba(96,165,250,0.15)';
      octx.fillRect(cx - Math.floor(candleW/2), bodyTop, candleW, bodyH);
    }
  }

  if (html) {
    tt.innerHTML = html;
    tt.style.display = 'block';
    let tx = evt.clientX + 12, ty = evt.clientY + 12;
    const vw = window.innerWidth, vh = window.innerHeight;
    const tRect = tt.getBoundingClientRect();
    if (tx + tRect.width > vw - 12) tx = evt.clientX - tRect.width - 12;
    if (ty + tRect.height > vh - 12) ty = evt.clientY - tRect.height - 12;
    tt.style.left = `${tx - rect.left}px`;
    tt.style.top = `${ty - rect.top}px`;
  } else {
    tt.style.display = 'none';
  }
}

function handleMouseLeave(){
  const tt = qs('tooltip');
  tt.style.display = 'none';
}

qs('chart').addEventListener('mousemove', handleMouseMove);
qs('chart').addEventListener('mouseleave', handleMouseLeave);

function redraw() {
  const payload = chartState.payload;
  if (!payload) return;
  const visible = payload.data.filter((d) => !chartState.hidden.has(d.ticker));
  const single = visible.length === 1;
  if (single && chartState.singleType === 'candle') {
    renderCandleChart(qs('chart'), visible[0].results);
  } else {
    renderLineChart(qs('chart'), payload);
  }
  // clear overlay on redraw
  const { ctx, width, height } = prepareCanvas(qs('overlay'));
  ctx.clearRect(0,0,width,height);
}

window.addEventListener('resize', () => {
  redraw();
});

qs('legend').addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  const name = item.getAttribute('data-name');
  if (!name) return; // ignore candle legend
  if (chartState.hidden.has(name)) chartState.hidden.delete(name); else chartState.hidden.add(name);
  // re-render line chart only
  if (chartState.payload) {
    const visible = chartState.payload.data.filter((d) => !chartState.hidden.has(d.ticker));
    const isSingle = visible.length === 1;
    // Toggle chart type control enabled state
    qs('chartTypeSingle').disabled = !isSingle;
    // Redraw appropriate chart
    if (isSingle && chartState.singleType === 'candle') {
      renderCandleChart(qs('chart'), visible[0].results);
      renderLegend(qs('legend'), { ...chartState.payload, data: [visible[0]] }, 'candle', COLORS);
    } else {
      renderLineChart(qs('chart'), chartState.payload);
      renderLegend(qs('legend'), chartState.payload, 'line', COLORS);
    }
    const { ctx, width, height } = prepareCanvas(qs('overlay'));
    ctx.clearRect(0,0,width,height);
  }
});

qs('chartTypeSingle').addEventListener('change', (e) => {
  chartState.singleType = e.target.value === 'candle' ? 'candle' : 'line';
  redraw();
});

function resetViewToData(){
  const p = chartState.payload;
  if (!p || !p.data || !p.data.length) { chartState.viewTMin = null; chartState.viewTMax = null; return; }
  const times = p.data.flatMap(d => d.results.map(b => b.t));
  if (!times.length) { chartState.viewTMin = null; chartState.viewTMax = null; return; }
  chartState.viewTMin = Math.min(...times);
  chartState.viewTMax = Math.max(...times);
}

// Zoom with wheel
qs('chart').addEventListener('wheel', (e) => {
  if (!chartState.drawArea || !chartState.payload) return;
  e.preventDefault();
  const rect = qs('chart').getBoundingClientRect();
  const x = e.clientX - rect.left;
  const { x:dx, w:dw } = chartState.drawArea;
  const ratio = Math.max(0, Math.min(1, (x - dx) / Math.max(1, dw)));
  const dataMin = chartState.payload.data.reduce((m, d) => Math.min(m, ...d.results.map(b => b.t)), Infinity);
  const dataMax = chartState.payload.data.reduce((m, d) => Math.max(m, ...d.results.map(b => b.t)), -Infinity);
  const currentMin = chartState.viewTMin ?? dataMin;
  const currentMax = chartState.viewTMax ?? dataMax;
  const span = Math.max(1, currentMax - currentMin);
  const direction = e.deltaY > 0 ? 1 : -1;
  const factor = direction > 0 ? 1.2 : (1/1.2);
  const newSpan = Math.max((dataMax - dataMin) / 200, Math.min((dataMax - dataMin), span * factor));
  const centerT = currentMin + ratio * span;
  let newMin = Math.round(centerT - ratio * newSpan);
  let newMax = Math.round(centerT + (1 - ratio) * newSpan);
  if (newMin < dataMin) { const shift = dataMin - newMin; newMin += shift; newMax += shift; }
  if (newMax > dataMax) { const shift = newMax - dataMax; newMin -= shift; newMax -= shift; }
  chartState.viewTMin = Math.max(dataMin, newMin);
  chartState.viewTMax = Math.min(dataMax, newMax);
  redraw();
}, { passive: false });

// Pan with drag
qs('chart').addEventListener('mousedown', (e) => {
  if (!chartState.drawArea || !chartState.payload) return;
  chartState.isPanning = true;
  chartState.panStartX = e.clientX;
  const dataMin = chartState.payload.data.reduce((m, d) => Math.min(m, ...d.results.map(b => b.t)), Infinity);
  const dataMax = chartState.payload.data.reduce((m, d) => Math.max(m, ...d.results.map(b => b.t)), -Infinity);
  chartState.panStartView = [chartState.viewTMin ?? dataMin, chartState.viewTMax ?? dataMax];
});

window.addEventListener('mouseup', () => { chartState.isPanning = false; });

window.addEventListener('mousemove', (e) => {
  if (!chartState.isPanning || !chartState.drawArea || !chartState.payload) return;
  const [startMin, startMax] = chartState.panStartView;
  const dxPx = e.clientX - chartState.panStartX;
  const span = Math.max(1, startMax - startMin);
  const msPerPx = span / Math.max(1, chartState.drawArea.w);
  const dataMin = chartState.payload.data.reduce((m, d) => Math.min(m, ...d.results.map(b => b.t)), Infinity);
  const dataMax = chartState.payload.data.reduce((m, d) => Math.max(m, ...d.results.map(b => b.t)), -Infinity);
  let newMin = startMin - Math.round(dxPx * msPerPx);
  let newMax = startMax - Math.round(dxPx * msPerPx);
  const viewSpan = newMax - newMin;
  if (newMin < dataMin) { newMin = dataMin; newMax = dataMin + viewSpan; }
  if (newMax > dataMax) { newMax = dataMax; newMin = dataMax - viewSpan; }
  chartState.viewTMin = newMin; chartState.viewTMax = newMax;
  // hide tooltip while panning
  qs('tooltip').style.display = 'none';
  const { ctx, width, height } = prepareCanvas(qs('overlay'));
  ctx.clearRect(0,0,width,height);
  redraw();
});
