// Live observations (NEA via data.gov.sg) + model forecast (Open-Meteo / CAMS).
// Everything here is CORS-enabled and keyless, so it runs straight from GitHub Pages.

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

// NEA 1-hour PM2.5 bands (µg/m³).
export const PM25_BANDS = [
  { max: 55, label: 'Normal', color: '#0ca30c' },
  { max: 150, label: 'Elevated', color: '#fab219' },
  { max: 250, label: 'High', color: '#ec835a' },
  { max: Infinity, label: 'Very high', color: '#d03b3b' },
];

// NEA 24-hour PSI descriptors.
export const PSI_BANDS = [
  { max: 50, label: 'Good' },
  { max: 100, label: 'Moderate' },
  { max: 200, label: 'Unhealthy' },
  { max: 300, label: 'Very unhealthy' },
  { max: Infinity, label: 'Hazardous' },
];

export const bandFor = (bands, v) => bands.find((b) => v <= b.max) ?? bands.at(-1);

async function getJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

const sgDate = (unix) =>
  new Date(unix * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }); // YYYY-MM-DD

const pastDayCache = new Map();

async function fetchNeaPm25Day(date, isToday) {
  if (!isToday && pastDayCache.has(date)) return pastDayCache.get(date);
  const body = await getJson(`${NEA}/pm25?date=${date}`);
  if (body.code !== 0) throw new Error(`NEA PM2.5: ${body.errorMsg || 'error'}`);
  const items = body.data.items.map((it) => ({
    t: Date.parse(it.timestamp) / 1000,
    pm25: it.readings.pm25_one_hourly,
  }));
  if (!isToday) pastDayCache.set(date, items);
  return items;
}

async function fetchObservations() {
  const now = Date.now() / 1000;
  const [today, yesterday, psi] = await Promise.all([
    fetchNeaPm25Day(sgDate(now), true),
    fetchNeaPm25Day(sgDate(now - 86400), false),
    getJson(`${NEA}/psi`),
  ]);
  if (psi.code !== 0) throw new Error(`NEA PSI: ${psi.errorMsg || 'error'}`);
  const psiItem = psi.data.items[0];
  const hours = [...today, ...yesterday]
    .filter((h) => now - h.t <= 24 * HOUR)
    .sort((a, b) => a.t - b.t);
  return {
    hours,
    psi24: psiItem.readings.psi_twenty_four_hourly,
    psiTime: Date.parse(psiItem.timestamp) / 1000,
  };
}

async function fetchModel() {
  const lats = REGIONS.map((r) => REGION_LOCATIONS[r].lat).join(',');
  const lons = REGIONS.map((r) => REGION_LOCATIONS[r].lon).join(',');
  const common = `timeformat=unixtime&past_days=1&forecast_days=${FORECAST_DAYS}`;
  const [aq, wx] = await Promise.all([
    getJson(`${AQ}?latitude=${lats}&longitude=${lons}&hourly=pm2_5&${common}`),
    getJson(`${WX}?latitude=1.35735&longitude=103.82&hourly=wind_speed_10m,wind_direction_10m&${common}`),
  ]);
  const series = Array.isArray(aq) ? aq : [aq];
  const pm25 = new Map(); // t -> {region: value}
  series[0].hourly.time.forEach((t, i) => {
    pm25.set(t, Object.fromEntries(REGIONS.map((r, k) => [r, series[k]?.hourly.pm2_5[i] ?? null])));
  });
  const wind = new Map();
  wx.hourly.time.forEach((t, i) => {
    wind.set(t, { speed: wx.hourly.wind_speed_10m[i], dir: wx.hourly.wind_direction_10m[i] });
  });
  return { pm25, wind };
}

const nearestWind = (wind, t) => {
  const h = Math.round(t / HOUR) * HOUR;
  return wind.get(h) ?? wind.get(h - HOUR) ?? wind.get(h + HOUR) ?? null;
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
    timeline.push({ t: h.t, kind: 'observed', pm25: h.pm25, wind: model ? nearestWind(model.wind, h.t) : null });
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
      timeline.push({ t, kind: 'forecast', pm25, wind: model.wind.get(t) ?? null });
    }
  }

  return {
    timeline,
    nowIndex: latest ? timeline.indexOf(latest) : 0,
    psi24: obs?.psi24 ?? null,
    psiTime: obs?.psiTime ?? null,
    fetchedAt: Date.now(),
    errors,
  };
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
const MAX_CLUSTERS = 10;
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
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_CLUSTERS);

    return {
      generatedAt: file.generatedAt,
      latest: recent.reduce((m, p) => Math.max(m, p[3]), 0) || null,
      total: recent.length,
      clusters,
    };
  } catch {
    return null;
  }
}
