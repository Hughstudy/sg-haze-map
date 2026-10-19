import { REGIONS, REGION_LOCATIONS, PSI_BANDS, bandFor, islandMax, isUpwind } from './data.js';
import { getScale, bandOf, displayValue } from './scales.js';

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
  const scale = getScale();
  $('legend').innerHTML = scale.bands.map(
    (b) => `<span title="${b.label}"><i style="background:${b.color}"></i>${b.short ?? b.label} <small>${b.range}</small></span>`,
  ).join('');
  $('hero-unit').textContent = scale.unit;
  for (const btn of document.querySelectorAll('[data-scale]')) {
    btn.setAttribute('aria-checked', String(btn.dataset.scale === scale.id));
  }
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
  const scale = getScale();
  const band = bandOf(max);
  $('hero-value').textContent = displayValue(max);
  $('hero-band').innerHTML = `<i style="background:${band.color}"></i>${band.label}`;
  $('hero-note').textContent = `${scale.metric} · ${top[0].toUpperCase()}${top.slice(1)}`;

  const barMax = Math.max(scale.chartFloor, displayValue(max));
  $('regions').innerHTML = REGIONS.map((r) => {
    const v = h.pm25[r];
    const shown = displayValue(v);
    const w = v == null ? 0 : Math.max(3, (shown / barMax) * 100);
    const color = v == null ? '#ccc' : bandOf(v).color;
    return `<li><span>${r}</span><span class="bar"><span style="width:${w}%;background:${color}"></span></span><span class="num">${shown ?? '–'}</span></li>`;
  }).join('');

  if (h.wind) {
    $('compass-arrow').style.transform = `rotate(${(h.wind.dir + 180) % 360}deg)`;
    $('wind-text').textContent = `From ${cardinal(h.wind.dir)} · ${Math.round(h.wind.speed)} km/h`;
  } else {
    $('wind-text').textContent = 'No wind data';
  }
}

/** Fire summary; upwind and rain status follow the selected hour. */
export function renderFires(hotspots, wind, fireMm = {}) {
  const box = $('fires');
  box.hidden = !hotspots;
  if (!hotspots) return;
  if (!hotspots.total) {
    $('fires-text').textContent = 'No fires detected';
    $('fires-note').textContent = 'NASA FIRMS VIIRS, Sumatra to Borneo';
    return;
  }
  const n = (v) => v.toLocaleString('en-SG');
  const up = hotspots.sectors.filter((s) => isUpwind(s, wind));
  const upCount = up.reduce((a, s) => a + s.count, 0);
  const wet = hotspots.sectors.filter((s) => (fireMm[s.id] ?? 0) >= 0.5);
  $('fires-text').textContent = `${n(hotspots.total)} detections`;
  const lines = [
    up.length
      ? `<span class="upwind-count">${n(upCount)} upwind (${up.map((s) => s.id).join(', ')})</span> — smoke may drift here`
      : 'None upwind at this hour',
  ];
  if (wet.length) lines.push(`<span class="rain-count">Rain over ${wet.map((s) => s.id).join(', ')} fires</span> in the next 3 h`);
  const latest = hotspots.latest ? ` · latest ${formatHour(hotspots.latest)}` : '';
  lines.push(`NASA FIRMS VIIRS${latest} · map distance compressed`);
  $('fires-note').innerHTML = lines.join('<br>');
}

const RAIN_SPACING_DEG = 0.045; // ~5 km between clouds
const CLOUD_OFFSETS = [[-0.04, 0.022], [0.04, 0.018], [0.004, -0.034]]; // degrees around a region point
const MAX_ISLAND_CLOUDS = 14;

/** Drop rain spots that crowd an earlier (stronger) one. */
function spaced(spots) {
  const out = [];
  for (const s of spots) {
    if (out.length >= MAX_ISLAND_CLOUDS) break;
    if (out.every((o) => Math.hypot(o.lon - s.lon, o.lat - s.lat) >= RAIN_SPACING_DEG)) out.push(s);
  }
  return out;
}

const mostCommon = (list) => {
  const counts = new Map();
  for (const v of list) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * Rain for the selected hour, as map spots plus panel text. "Now" uses NEA's live gauges
 * and 2-hour forecast; other hours use the Open-Meteo model at the five region points.
 */
export function rainSummary(data, index, nea) {
  const h = data.timeline[index];
  if (index === data.nowIndex && (nea?.stations || nea?.forecast)) {
    const wet = (nea.stations?.list ?? []).filter((s) => s.mm > 0).sort((a, b) => b.mm - a.mm);
    const rainy = (nea.forecast?.areas ?? []).filter((a) => a.rainy && a.lat != null);
    const island = spaced([
      ...wet.map((s) => ({ lon: s.lon, lat: s.lat, mmPerHour: s.mm * 12 })), // 5-min total → hourly rate
      ...rainy.map((a) => ({ lon: a.lon, lat: a.lat, mmPerHour: /heavy/i.test(a.text) ? 6 : /thunder/i.test(a.text) ? 3 : 1 })),
    ]);
    const live = nea.stations
      ? wet.length
        ? `Raining at ${wet.length} NEA gauge${wet.length > 1 ? 's' : ''}, up to ${wet[0].mm} mm in 5 min`
        : 'Dry at all NEA rain gauges'
      : 'Live gauges unavailable';
    const when = nea.forecast?.validText ? ` (${nea.forecast.validText})` : '';
    const next = nea.forecast
      ? rainy.length
        ? `Next 2 h${when}: ${mostCommon(rainy.map((a) => a.text))} in ${rainy.slice(0, 2).map((a) => a.name).join(', ')}${rainy.length > 2 ? ` +${rainy.length - 2} more` : ''}`
        : `Next 2 h${when}: no rain forecast`
      : '';
    return { island, text: live, note: next };
  }
  const rain = h?.rain ?? {};
  const wettest = REGIONS.reduce((a, r) => ((rain[r] ?? 0) > (rain[a] ?? 0) ? r : a), REGIONS[0]);
  const max = rain[wettest] ?? 0;
  // A few clouds around each rainy region point, not on it: the region badge sits there.
  const island = REGIONS.filter((r) => (rain[r] ?? 0) >= 0.1).flatMap((r) =>
    CLOUD_OFFSETS.map(([dLon, dLat]) => ({
      lon: REGION_LOCATIONS[r].lon + dLon,
      lat: REGION_LOCATIONS[r].lat + dLat,
      mmPerHour: rain[r],
    })),
  );
  return {
    island,
    text: max >= 0.1 ? `${max.toFixed(1)} mm in the hour, most in the ${wettest}` : 'No rain modelled for this hour',
    note: 'Open-Meteo model',
  };
}

export function renderRain(summary) {
  $('rain-text').textContent = summary.text;
  $('rain-note').textContent = summary.note;
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
 * Single-series line: highest regional PM2.5 per hour on the current scale. Observed is
 * solid, forecast dashed. Band thresholds are the only y gridlines because they're what people act on.
 */
export function renderChart(data, index) {
  const svg = $('chart');
  const { width, height } = svg.getBoundingClientRect();
  if (!width) return null;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();

  const pad = { l: 30, r: 10, t: 14, b: 32 };
  const tl = data.timeline;
  const scale = getScale();
  const raw = tl.map((h) => islandMax(h.pm25)); // µg/m³
  const vals = raw.map((v) => scale.convert(v)); // display units
  const yMax = Math.max(scale.chartFloor, Math.ceil(Math.max(...vals) * 1.15));
  const rainVals = tl.map((h) => {
    const v = REGIONS.map((r) => h.rain?.[r]).filter((r) => r != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  });
  const x = (i) => pad.l + (i / Math.max(1, tl.length - 1)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / yMax) * (height - pad.t - pad.b);

  // Recessive band tint + threshold gridlines
  let lo = 0;
  for (const b of scale.bands) {
    const hi = Math.min(b.max, yMax);
    if (lo < yMax) {
      el('rect', { x: pad.l, width: width - pad.l - pad.r, y: y(hi), height: y(lo) - y(hi), fill: b.color, opacity: 0.08 }, svg);
    }
    lo = b.max;
  }
  for (const v of scale.ticks.filter((v) => v < yMax)) {
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

  // Rain strip: island-mean modelled rain per hour, on its own small scale under the plot.
  const stripTop = height - pad.b + 3;
  const stripH = 10;
  const rainMax = Math.max(2, ...rainVals);
  const barW = Math.max(1, ((width - pad.l - pad.r) / tl.length) * 0.8);
  el('line', { x1: pad.l, x2: width - pad.r, y1: stripTop + stripH, y2: stripTop + stripH, class: 'grid' }, svg);
  el('text', { x: pad.l - 5, y: stripTop + stripH, 'text-anchor': 'end', class: 'rain-label' }, svg).textContent = 'rain';
  rainVals.forEach((v, i) => {
    if (v < 0.05) return;
    const bh = Math.max(1.5, (v / rainMax) * stripH);
    el('rect', { x: x(i) - barW / 2, y: stripTop + stripH - bh, width: barW, height: bh, rx: 1, class: 'rain-bar' }, svg);
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
  el('circle', { cx: x(index), cy: y(v), r: 6, fill: bandOf(raw[index]).color, class: 'sel-dot' }, svg);
  el('circle', { cx: x(index), cy: y(v), r: 7.5, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5 }, svg);

  return {
    indexAt(clientX) {
      const rect = svg.getBoundingClientRect();
      const f = (clientX - rect.left - pad.l) / (rect.width - pad.l - pad.r);
      return Math.round(Math.min(1, Math.max(0, f)) * (tl.length - 1));
    },
    xOf: x,
    pm25: (i) => raw[i],
    rain: (i) => rainVals[i],
  };
}
