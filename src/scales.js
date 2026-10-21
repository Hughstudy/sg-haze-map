// Display scales. Two show the same NEA 1-hr PM2.5 reading (NEA's µg/m³ bands, or the US EPA
// AQI that sites like aqicn.org show); the third is Singapore's own 24-hr PSI. Each scale names
// the timeline field it reads (`key`). Haze particles always use raw PM2.5 µg/m³.

// US EPA PM2.5 AQI breakpoints as used by aqicn.org (the pre-2024 table; the 2024
// revision lowers some ranges, e.g. 73 µg/m³ would read 163 instead of aqicn's 160).
const US_BREAKPOINTS = [
  [0, 12, 0, 50],
  [12.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 150.4, 151, 200],
  [150.5, 250.4, 201, 300],
  [250.5, 350.4, 301, 400],
  [350.5, 500.4, 401, 500],
];

export function usAqi(pm25) {
  if (pm25 == null) return null;
  const c = Math.floor(Math.max(0, pm25) * 10) / 10; // EPA truncates to 0.1 µg/m³
  const row = US_BREAKPOINTS.find(([, hi]) => c <= hi);
  if (!row) return 500;
  const [lo, hi, aLo, aHi] = row;
  return Math.round(((aHi - aLo) / (hi - lo)) * (c - lo) + aLo);
}

// NEA PSI sub-index for 24-hr PM2.5 (µg/m³ → index), from NEA's published breakpoints.
const PSI_PM25_BREAKPOINTS = [
  [0, 12, 0, 50],
  [12, 55, 50, 100],
  [55, 150, 100, 200],
  [150, 250, 200, 300],
  [250, 350, 300, 400],
  [350, 500, 400, 500],
];

export function psiFromPm25(pm25) {
  if (pm25 == null) return null;
  const c = Math.max(0, pm25);
  const row = PSI_PM25_BREAKPOINTS.find(([, hi]) => c <= hi);
  if (!row) return 500;
  const [lo, hi, iLo, iHi] = row;
  return Math.round(iLo + ((iHi - iLo) * (c - lo)) / (hi - lo));
}

export const SCALES = {
  nea: {
    id: 'nea',
    name: 'NEA µg/m³',
    key: 'pm25',
    unit: 'µg/m³',
    metric: '1-hr PM2.5',
    convert: (v) => v,
    // NEA 1-hour PM2.5 bands
    bands: [
      { max: 55, label: 'Normal', range: '0–55', color: '#0ca30c' },
      { max: 150, label: 'Elevated', range: '56–150', color: '#fab219' },
      { max: 250, label: 'High', range: '151–250', color: '#ec835a' },
      { max: Infinity, label: 'Very high', range: '251+', color: '#d03b3b' },
    ],
    ticks: [0, 55, 150, 250],
    chartFloor: 160,
  },
  us: {
    id: 'us',
    name: 'US AQI',
    key: 'pm25',
    unit: 'US AQI',
    metric: 'PM2.5 AQI',
    convert: usAqi,
    // US EPA categories, in aqicn.org's colours
    bands: [
      { max: 50, label: 'Good', range: '0–50', color: '#009966' },
      { max: 100, label: 'Moderate', range: '51–100', color: '#ffde33' },
      { max: 150, label: 'Unhealthy for sensitive groups', short: 'Sensitive', range: '101–150', color: '#ff9933' },
      { max: 200, label: 'Unhealthy', range: '151–200', color: '#cc0033' },
      { max: 300, label: 'Very unhealthy', range: '201–300', color: '#660099' },
      { max: Infinity, label: 'Hazardous', range: '301+', color: '#7e0023' },
    ],
    ticks: [0, 50, 100, 150, 200, 300],
    chartFloor: 200,
  },
  psi: {
    id: 'psi',
    name: 'PSI',
    key: 'psi',
    unit: 'PSI',
    metric: '24-hr PSI',
    convert: (v) => v,
    // NEA PSI descriptors
    bands: [
      { max: 50, label: 'Good', range: '0–50', color: '#0ca30c' },
      { max: 100, label: 'Moderate', range: '51–100', color: '#ffde33' },
      { max: 200, label: 'Unhealthy', range: '101–200', color: '#ff9933' },
      { max: 300, label: 'Very unhealthy', range: '201–300', color: '#cc0033' },
      { max: Infinity, label: 'Hazardous', range: '301+', color: '#7e0023' },
    ],
    ticks: [0, 50, 100, 200, 300],
    chartFloor: 150,
  },
};

const STORAGE_KEY = 'sg-haze-scale';
let current = SCALES.us;

// ?scale=nea|us|psi in the URL wins, then the viewer's last choice, then US AQI.
try {
  const fromUrl = new URLSearchParams(location.search).get('scale');
  const saved = fromUrl || localStorage.getItem(STORAGE_KEY);
  if (SCALES[saved]) current = SCALES[saved];
} catch {
  // storage can be blocked (private mode, previews); the US AQI default is fine
}

export const getScale = () => current;

export function setScale(id) {
  if (!SCALES[id]) return;
  current = SCALES[id];
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
}

// Below, `v` is a value of the current scale's field: PM2.5 µg/m³, or a PSI index.

/** The per-region values the current scale shows for a timeline hour. */
export const valuesOf = (hour) => hour?.[current.key] ?? null;

/** Band for a value on the current scale. */
export function bandOf(v) {
  const shown = current.convert(v);
  return current.bands.find((b) => shown <= b.max) ?? current.bands.at(-1);
}

/** "160 US AQI", "73 µg/m³" or "122 PSI". */
export const formatValue = (v) => (v == null ? '–' : `${Math.round(current.convert(v))} ${current.unit}`);
export const displayValue = (v) => (v == null ? null : Math.round(current.convert(v)));
