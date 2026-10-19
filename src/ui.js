import { REGIONS, PM25_BANDS, PSI_BANDS, bandFor, islandMax, isUpwind } from './data.js';

const SVG = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const fmtHour = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', hour: 'numeric' });
const fmtClock = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric' });
const sgHour = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: 'numeric', hourCycle: 'h23' }).format(t * 1000));

export const formatHour = (t) => fmtHour.format(t * 1000).replace(/\s?([ap]m)/i, ' $1').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const formatClock = (ms) => fmtClock.format(ms).toLowerCase();

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const cardinal = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

export function renderLegend() {
  const ranges = ['0–55', '56–150', '151–250', '251+'];
  $('legend').innerHTML = PM25_BANDS.map(
    (b, i) => `<span><i style="background:${b.color}"></i>${b.label} <small>${ranges[i]}</small></span>`,
  ).join('');
}

/** Hero number, region bars, wind compass for the selected hour. */
export function renderPanel(data, index) {
  const h = data.timeline[index];
  if (!h) return;
  const rel = Math.round((h.t - data.timeline[data.nowIndex].t) / 3600);
  const kind = index === data.nowIndex ? 'Now' : h.kind === 'forecast' ? 'Forecast' : 'Observed';
  const kindEl = $('when-kind');
  kindEl.textContent = kind;
  kindEl.className = `kind ${kind.toLowerCase()}`;
  $('when-time').textContent = `${formatHour(h.t)}${rel ? ` · ${rel > 0 ? '+' : ''}${rel} h` : ''}`;

  const max = islandMax(h.pm25);
  const top = REGIONS.reduce((a, r) => ((h.pm25[r] ?? -1) > (h.pm25[a] ?? -1) ? r : a), REGIONS[0]);
  const band = bandFor(PM25_BANDS, max);
  $('hero-value').textContent = Math.round(max);
  $('hero-band').innerHTML = `<i style="background:${band.color}"></i>${band.label}`;
  $('hero-note').textContent = `Highest 1-hr PM2.5 · ${top[0].toUpperCase()}${top.slice(1)}`;

  const scale = Math.max(150, max);
  $('regions').innerHTML = REGIONS.map((r) => {
    const v = h.pm25[r];
    const b = v == null ? null : bandFor(PM25_BANDS, v);
    const w = v == null ? 0 : Math.max(3, (v / scale) * 100);
    return `<li><span>${r}</span><span class="bar"><span style="width:${w}%;background:${b?.color ?? '#ccc'}"></span></span><span class="num">${v == null ? '–' : Math.round(v)}</span></li>`;
  }).join('');

  if (h.wind) {
    $('compass-arrow').style.transform = `rotate(${(h.wind.dir + 180) % 360}deg)`;
    $('wind-text').textContent = `From ${cardinal(h.wind.dir)} · ${Math.round(h.wind.speed)} km/h`;
  } else {
    $('wind-text').textContent = 'No wind data';
  }
}

/** Fire summary; upwind status follows the wind at the selected hour. */
export function renderFires(hotspots, wind) {
  const box = $('fires');
  box.hidden = !hotspots;
  if (!hotspots) return;
  if (!hotspots.total) {
    $('fires-text').textContent = 'No fires detected';
    $('fires-note').textContent = 'NASA FIRMS VIIRS, Sumatra to Borneo';
    return;
  }
  const upwind = hotspots.clusters.filter((c) => isUpwind(c, wind)).length;
  $('fires-text').textContent = `${hotspots.total.toLocaleString('en-SG')} detections`;
  const status = upwind
    ? `<span class="upwind-count">${upwind} cluster${upwind > 1 ? 's' : ''} upwind</span> — smoke may drift here`
    : 'No clusters upwind at this hour';
  const latest = hotspots.latest ? ` · latest ${formatHour(hotspots.latest)}` : '';
  $('fires-note').innerHTML = `${status}<br>NASA FIRMS VIIRS${latest} · map distance compressed`;
}

export function renderPsi(data) {
  const list = $('psi');
  if (!data.psi24) {
    list.innerHTML = '<li style="grid-column:1/-1">Unavailable</li>';
    return;
  }
  list.innerHTML = REGIONS.map((r) => `<li><b>${data.psi24[r] ?? '–'}</b><span>${r}</span></li>`).join('');
  const max = Math.max(...REGIONS.map((r) => data.psi24[r] ?? 0));
  $('psi-time').textContent = `· ${formatHour(data.psiTime)} · ${bandFor(PSI_BANDS, max).label}`;
}

/**
 * Single-series line: highest regional PM2.5 per hour. Observed is solid, forecast dashed.
 * Band thresholds (55/150/250) are the only y gridlines because they're what people act on.
 */
export function renderChart(data, index) {
  const svg = $('chart');
  const { width, height } = svg.getBoundingClientRect();
  if (!width) return null;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();

  const pad = { l: 30, r: 10, t: 14, b: 18 };
  const tl = data.timeline;
  const vals = tl.map((h) => islandMax(h.pm25));
  const yMax = Math.max(160, Math.ceil(Math.max(...vals) * 1.15));
  const x = (i) => pad.l + (i / Math.max(1, tl.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / yMax) * (height - pad.t - pad.b);

  // Recessive band tint + threshold gridlines
  let lo = 0;
  for (const b of PM25_BANDS) {
    const hi = Math.min(b.max, yMax);
    if (lo < yMax) {
      el('rect', { x: pad.l, width: width - pad.l - pad.r, y: y(hi), height: y(lo) - y(hi), fill: b.color, opacity: 0.08 }, svg);
    }
    lo = b.max;
  }
  for (const v of [0, 55, 150, 250].filter((v) => v < yMax)) {
    el('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: 'grid' }, svg);
    el('text', { x: pad.l - 5, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' }, svg).textContent = v;
  }

  // Day ticks at local midnight
  tl.forEach((h, i) => {
    if (sgHour(h.t) === 0 && i > 0) {
      el('line', { x1: x(i), x2: x(i), y1: pad.t, y2: height - pad.b, class: 'grid' }, svg);
      el('text', { x: x(i) + 3, y: height - 4, class: 'axis-label' }, svg).textContent = fmtDay.format(h.t * 1000);
    }
  });

  const path = (from, to) =>
    vals.slice(from, to + 1).map((v, k) => `${k ? 'L' : 'M'}${x(from + k).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const n = data.nowIndex;
  if (n > 0) el('path', { d: path(0, n), class: 'line' }, svg);
  if (n < tl.length - 1) el('path', { d: path(n, tl.length - 1), class: 'line forecast' }, svg);

  el('line', { x1: x(n), x2: x(n), y1: pad.t - 6, y2: height - pad.b, class: 'now-line' }, svg);
  el('text', { x: x(n) + 4, y: pad.t - 4, class: 'now-label' }, svg).textContent = 'Now';
  if (n < tl.length - 1) {
    el('text', { x: width - pad.r, y: pad.t - 4, 'text-anchor': 'end', class: 'axis-label' }, svg).textContent = 'Forecast →';
  }

  const v = vals[index];
  el('line', { x1: x(index), x2: x(index), y1: pad.t, y2: height - pad.b, class: 'sel-line' }, svg);
  el('circle', { cx: x(index), cy: y(v), r: 6, fill: bandFor(PM25_BANDS, v).color, class: 'sel-dot' }, svg);
  el('circle', { cx: x(index), cy: y(v), r: 7.5, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5 }, svg);

  return {
    indexAt(clientX) {
      const rect = svg.getBoundingClientRect();
      const f = (clientX - rect.left - pad.l) / (rect.width - pad.l - pad.r);
      return Math.round(Math.min(1, Math.max(0, f)) * (tl.length - 1));
    },
    xOf: x,
    value: (i) => vals[i],
  };
}
