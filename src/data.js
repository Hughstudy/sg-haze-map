// Live observations (NEA via data.gov.sg) + model forecast (Open-Meteo / CAMS).
// Everything here is CORS-enabled and keyless, so it runs straight from GitHub Pages.

import { psiFromPm25 } from './scales.js';

const NEA = 'https://api-open.data.gov.sg/v2/real-time/api';
const AQ = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const WX = 'https://api.open-meteo.com/v1/forecast';

const HOUR = 3600;
const FORECAST_DAYS = 4;
// How quickly the forecast hands over from "latest observation" to "pure model".
const BLEND_HOURS = 12;

export const REGIONS = ['north', 'south', 'east', 'west', 'central'];

// NEA's reporting-region label points (also returned by the API; kept as a fallback).
export const REGION_LOCATIONS = {
  north: { lat: 1.41803, lon: 103.82 },
  south: { lat: 1.29587, lon: 103.82 },
  east: { lat: 1.35735, lon: 103.94 },
  west: { lat: 1.35735, lon: 103.7 },
  central: { lat: 1.35735, lon: 103.82 },
};

async function getJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

const sgDate = (unix) =>
  new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); // YYYY-MM-DD

const pastDayCache = new Map();

/** One day of an NEA hourly series, oldest first; past days never change, so they're cached. */
async function fetchNeaDay(endpoint, date, isToday, pick) {
  const key = `${endpoint}/${date}`;
  if (!isToday && pastDayCache.has(key)) return pastDayCache.get(key);
  const body = await getJson(`${NEA}/${endpoint}?date=${date}`);
  if (body.code !== 0) throw new Error(`NEA ${endpoint}: ${body.errorMsg || 'error'}`);
  const items = body.data.items.map((it) => ({ t: Date.parse(it.timestamp) / 1000, ...pick(it.readings) }));
  if (!isToday) pastDayCache.set(key, items);
  return items;
}

/** Last 24 h of a series across today and yesterday (SG dates), oldest first. */
async function fetchNeaLast24h(endpoint, pick) {
  const now = Date.now() / 1000;
  const [today, yesterday] = await Promise.all([
    fetchNeaDay(endpoint, sgDate(now), true, pick),
    fetchNeaDay(endpoint, sgDate(now - 86400), false, pick),
  ]);
  return [...today, ...yesterday].filter((h) => now - h.t <= 24 * HOUR).sort((a, b) => a.t - b.t);
}

async function fetchObservations() {
  const [hours, psi] = await Promise.all([
    fetchNeaLast24h('pm25', (r) => ({ pm25: r.pm25_one_hourly })),
    // PSI is optional: without it the PSI tab estimates every hour from PM2.5.
    fetchNeaLast24h('psi', (r) => ({ psi: r.psi_twenty_four_hourly })).catch(() => []),
  ]);
  return { hours, psi: new Map(psi.map((h) => [h.t, h.psi])) };
}

async function fetchModel() {
  const lats = REGIONS.map((r) => REGION_LOCATIONS[r].lat).join(',');
  const lons = REGIONS.map((r) => REGION_LOCATIONS[r].lon).join(',');
  const common = `timeformat=unixtime&past_days=1&forecast_days=${FORECAST_DAYS}`;
  const [aq, wx] = await Promise.all([
    getJson(`${AQ}?latitude=${lats}&longitude=${lons}&hourly=pm2_5&${common}`),
    getJson(`${WX}?latitude=${lats}&longitude=${lons}&hourly=wind_speed_10m,wind_direction_10m,precipitation&${common}`),
  ]);
  const series = Array.isArray(aq) ? aq : [aq];
  const pm25 = new Map(); // t -> {region: value}
  series[0].hourly.time.forEach((t, i) => {
    pm25.set(t, Object.fromEntries(REGIONS.map((r, k) => [r, series[k]?.hourly.pm2_5[i] ?? null])));
  });
  // Wind from the central point; modelled rain (mm in the hour) at each region point.
  const wxSeries = Array.isArray(wx) ? wx : [wx];
  const centre = wxSeries[REGIONS.indexOf('central')] ?? wxSeries[0];
  const wind = new Map();
  const rain = new Map();
  centre.hourly.time.forEach((t, i) => {
    wind.set(t, { speed: centre.hourly.wind_speed_10m[i], dir: centre.hourly.wind_direction_10m[i] });
    rain.set(t, Object.fromEntries(REGIONS.map((r, k) => [r, wxSeries[k]?.hourly.precipitation[i] ?? null])));
  });
  return { pm25, wind, rain };
}

const nearestHour = (map, t) => {
  const h = Math.round(t / HOUR) * HOUR;
  return map.get(h) ?? map.get(h - HOUR) ?? map.get(h + HOUR) ?? null;
};

/**
 * Returns a single hourly timeline: up to 24 observed hours, then forecast hours.
 * Forecast values are nudged toward the latest observation and relax to the raw
 * model over BLEND_HOURS, so the map doesn't jump at the "now" boundary.
 */
export async function loadHazeData() {
  const [obsRes, modelRes] = await Promise.allSettled([fetchObservations(), fetchModel()]);
  const errors = [];
  const obs = obsRes.status === 'fulfilled' ? obsRes.value : (errors.push(`Live readings: ${obsRes.reason.message}`), null);
  const model = modelRes.status === 'fulfilled' ? modelRes.value : (errors.push(`Forecast: ${modelRes.reason.message}`), null);
  if (!obs && !model) throw new Error(errors.join(' · '));

  const timeline = [];
  for (const h of obs?.hours ?? []) {
    timeline.push({
      t: h.t,
      kind: 'observed',
      pm25: h.pm25,
      psi: obs.psi.get(h.t) ?? null,
      wind: model ? nearestHour(model.wind, h.t) : null,
      rain: model ? nearestHour(model.rain, h.t) : null,
    });
  }

  const latest = timeline.at(-1);
  const startT = latest ? latest.t : Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  if (model) {
    const bias = {};
    const modelAtStart = model.pm25.get(startT);
    for (const r of REGIONS) {
      const o = latest?.pm25?.[r];
      const m = modelAtStart?.[r];
      bias[r] = o != null && m != null ? o - m : 0;
    }
    for (const [t, values] of [...model.pm25].sort((a, b) => a[0] - b[0])) {
      if (t <= startT) continue;
      const w = Math.exp(-(t - startT) / HOUR / BLEND_HOURS);
      const pm25 = {};
      for (const r of REGIONS) {
        pm25[r] = values[r] == null ? null : Math.max(0, Math.round(values[r] + bias[r] * w));
      }
      timeline.push({ t, kind: 'forecast', pm25, wind: model.wind.get(t) ?? null, rain: model.rain.get(t) ?? null });
    }
  }

  addPsi(timeline, latest ? timeline.indexOf(latest) : -1);
  const psiNow = [...timeline].reverse().find((h) => h.kind === 'observed' && h.psiObserved);

  return {
    timeline,
    nowIndex: latest ? timeline.indexOf(latest) : 0,
    psi24: psiNow?.psi ?? null,
    psiTime: psiNow?.t ?? null,
    fetchedAt: Date.now(),
    errors,
  };
}

/**
 * Fills h.psi for every hour. Observed hours keep NEA's published 24-hr PSI; the rest are
 * estimated from the trailing 24-h mean PM2.5 (PM2.5 drives PSI in haze), nudged toward
 * the last published value the same way the PM2.5 forecast is.
 */
function addPsi(timeline, nowIndex) {
  const estimate = timeline.map((_, i) => {
    const window = timeline.slice(Math.max(0, i - 23), i + 1);
    return Object.fromEntries(REGIONS.map((r) => {
      const vals = window.map((h) => h.pm25?.[r]).filter((v) => v != null);
      return [r, vals.length ? psiFromPm25(vals.reduce((a, b) => a + b, 0) / vals.length) : null];
    }));
  });
  const anchor = timeline[nowIndex]?.psi;
  const bias = Object.fromEntries(REGIONS.map((r) => {
    const o = anchor?.[r];
    const e = estimate[nowIndex]?.[r];
    return [r, o != null && e != null ? o - e : 0];
  }));
  timeline.forEach((h, i) => {
    h.psiObserved = h.psi != null;
    if (h.psiObserved) return;
    const w = nowIndex >= 0 && i > nowIndex ? Math.exp(-(h.t - timeline[nowIndex].t) / HOUR / BLEND_HOURS) : 0;
    h.psi = Object.fromEntries(REGIONS.map((r) => {
      const e = estimate[i][r];
      return [r, e == null ? null : Math.max(0, Math.round(e + bias[r] * w))];
    }));
  });
}

export const islandMax = (pm25) => Math.max(...REGIONS.map((r) => pm25?.[r] ?? 0));
export const islandMean = (pm25) => {
  const vals = REGIONS.map((r) => pm25?.[r]).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
};

// ---- Fire hotspots (NASA FIRMS, fetched at deploy time into data/hotspots.json) ----

const SG = { lat: 1.3521, lon: 103.8198 };
const STALE_AFTER_S = 48 * HOUR;
const CLUSTER_DEG = 0.8; // detections within this many degrees of a cluster centre join it
const MIN_CLUSTER = 3;
const SECTOR_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const UPWIND_DEG = 45;

const toRad = (d) => (d * Math.PI) / 180;

function distanceKm(lat, lon) {
  const dLat = toRad(lat - SG.lat);
  const dLon = toRad(lon - SG.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(SG.lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function bearingFromSg(lat, lon) {
  const y = Math.sin(toRad(lon - SG.lon)) * Math.cos(toRad(lat));
  const x = Math.cos(toRad(SG.lat)) * Math.sin(toRad(lat)) - Math.sin(toRad(SG.lat)) * Math.cos(toRad(lat)) * Math.cos(toRad(lon - SG.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * One marker per compass direction (45° sectors). Fire seasons often put thousands of
 * detections in the same direction, and separate markers there just pile on top of each other.
 */
function toSectors(clusters) {
  const bySector = new Map();
  for (const c of clusters) {
    const id = SECTOR_NAMES[Math.round(c.bearing / 45) % 8];
    const s = bySector.get(id) ?? { id, count: 0, sx: 0, sy: 0, km: 0, minKm: Infinity, maxKm: 0, main: c };
    s.count += c.count;
    // count-weighted circular mean of bearings
    s.sx += Math.sin(toRad(c.bearing)) * c.count;
    s.sy += Math.cos(toRad(c.bearing)) * c.count;
    s.km += c.distanceKm * c.count;
    s.minKm = Math.min(s.minKm, c.distanceKm);
    s.maxKm = Math.max(s.maxKm, c.distanceKm);
    if (c.count > s.main.count) s.main = c;
    bySector.set(id, s);
  }
  return [...bySector.values()]
    .map((s) => ({
      id: s.id,
      count: s.count,
      bearing: ((Math.atan2(s.sx, s.sy) * 180) / Math.PI + 360) % 360,
      distanceKm: s.km / s.count,
      minKm: s.minKm,
      maxKm: s.maxKm,
      // the biggest cluster stands in for the sector when looking up rain over the fires
      lat: s.main.lat,
      lon: s.main.lon,
    }))
    .sort((a, b) => b.count - a.count);
}

/** A cluster is upwind when the wind blows from roughly its direction toward Singapore. */
export function isUpwind(cluster, wind) {
  if (!wind || wind.speed < 3) return false;
  const diff = Math.abs(((cluster.bearing - wind.dir + 540) % 360) - 180);
  return diff <= UPWIND_DEG;
}

/** Returns null when there is no file, it's stale, or it can't be read; the UI then hides the layer. */
export async function loadHotspots() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/hotspots.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const file = await res.json();
    const now = Date.now() / 1000;
    if (!file.generatedAt || now - file.generatedAt > STALE_AFTER_S) return null;

    const recent = file.points.filter(([, , , t]) => now - t <= 24 * HOUR);
    // Greedy grouping: strongest fires seed clusters, nearby detections join the closest one.
    const groups = [];
    for (const [lon, lat, frp] of [...recent].sort((a, b) => b[2] - a[2])) {
      let best = null;
      let bestD = CLUSTER_DEG ** 2;
      for (const g of groups) {
        const d = (g.lon / g.n - lon) ** 2 + (g.lat / g.n - lat) ** 2;
        if (d < bestD) { bestD = d; best = g; }
      }
      if (!best) groups.push((best = { n: 0, lon: 0, lat: 0, frp: 0 }));
      best.n += 1;
      best.lon += lon;
      best.lat += lat;
      best.frp += frp;
    }
    const clusters = groups
      .filter((c) => c.n >= MIN_CLUSTER)
      .map((c) => {
        const lat = c.lat / c.n;
        const lon = c.lon / c.n;
        return { count: c.n, frp: c.frp, lat, lon, distanceKm: distanceKm(lat, lon), bearing: bearingFromSg(lat, lon) };
      })
      .sort((a, b) => b.count - a.count);

    return {
      generatedAt: file.generatedAt,
      latest: recent.reduce((m, p) => Math.max(m, p[3]), 0) || null,
      total: recent.length,
      sectors: toSectors(clusters),
    };
  } catch {
    return null;
  }
}

// ---- Rain (context only: it never changes the PM2.5 values) ----

const RAINY = /rain|shower|thunder|drizzle/i;

/**
 * NEA live rain: 5-minute totals at ~90 gauges, plus the 2-hour area forecast.
 * Either half may be null if its request fails.
 */
export async function loadNeaRain() {
  const [gauges, nowcast] = await Promise.allSettled([getJson(`${NEA}/rainfall`), getJson(`${NEA}/two-hr-forecast`)]);
  let stations = null;
  if (gauges.status === 'fulfilled' && gauges.value.code === 0) {
    const d = gauges.value.data;
    const reading = d.readings[0];
    const byId = new Map(reading.data.map((r) => [r.stationId, r.value]));
    stations = {
      time: Date.parse(reading.timestamp) / 1000,
      list: d.stations.map((s) => ({ name: s.name, lat: s.location.latitude, lon: s.location.longitude, mm: byId.get(s.id) ?? 0 })),
    };
  }
  let forecast = null;
  if (nowcast.status === 'fulfilled' && nowcast.value.code === 0) {
    const d = nowcast.value.data;
    const item = d.items[0];
    const where = new Map(d.area_metadata.map((a) => [a.name, a.label_location]));
    forecast = {
      validText: item.valid_period?.text ?? '',
      areas: item.forecasts.map((f) => ({
        name: f.area,
        text: f.forecast,
        rainy: RAINY.test(f.forecast),
        lat: where.get(f.area)?.latitude,
        lon: where.get(f.area)?.longitude,
      })),
    };
  }
  return { stations, forecast };
}

/** Modelled hourly rain (mm) at each fire sector's main cluster: Map<sectorId, Map<t, mm>>. */
export async function loadFireRain(sectors) {
  if (!sectors?.length) return null;
  try {
    const lats = sectors.map((s) => s.lat.toFixed(3)).join(',');
    const lons = sectors.map((s) => s.lon.toFixed(3)).join(',');
    const body = await getJson(`${WX}?latitude=${lats}&longitude=${lons}&hourly=precipitation&timeformat=unixtime&past_days=1&forecast_days=${FORECAST_DAYS}`);
    const series = Array.isArray(body) ? body : [body];
    return new Map(sectors.map((s, k) => [s.id, new Map(series[k].hourly.time.map((t, i) => [t, series[k].hourly.precipitation[i] ?? 0]))]));
  } catch {
    return null;
  }
}

/** Rain total over `hours` starting at t from a Map<t, mm>. */
export function rainWindow(series, t, hours = 3) {
  if (!series) return null;
  let sum = 0;
  for (let h = 0; h < hours; h++) sum += series.get(Math.round(t / HOUR) * HOUR + h * HOUR) ?? 0;
  return sum;
}
