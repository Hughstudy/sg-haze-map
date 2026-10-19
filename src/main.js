import './style.css';
import { createScene } from './scene.js';
import { loadHazeData, loadHotspots } from './data.js';
import { setScale, bandOf, formatValue } from './scales.js';
import { renderLegend, renderPanel, renderPsi, renderFires, renderChart, formatHour, formatClock } from './ui.js';

const REFRESH_MS = 10 * 60 * 1000;
const PLAY_STEP_MS = 350;
const RETRY_MS = 90 * 1000;

const $ = (id) => document.getElementById(id);
const status = $('status');
const slider = $('slider');
const wrap = $('chart-wrap');
const tip = $('chart-tip');
const tooltip = $('tooltip');

let data = null;
let hotspots = null;
let index = 0;
let chart = null;
let scene = null;
let playTimer = null;
let retryTimer = null;

function setStatus(text, kind) {
  status.textContent = text;
  status.className = `status ${kind ?? ''}`;
}

function select(i) {
  if (!data) return;
  index = Math.max(0, Math.min(data.timeline.length - 1, i));
  slider.value = index;
  const h = data.timeline[index];
  scene.setValues(h.pm25, h.wind);
  renderPanel(data, index);
  renderFires(hotspots, h.wind);
  chart = renderChart(data, index);
}

function showChartTip(i) {
  if (!chart || !data) return;
  const h = data.timeline[i];
  const v = chart.pm25(i);
  tip.hidden = false;
  tip.style.left = `${chart.xOf(i)}px`;
  tip.textContent = `${formatHour(h.t)} · ${formatValue(v)} · ${bandOf(v).label}${h.kind === 'forecast' ? ' (forecast)' : ''}`;
}

async function refresh() {
  try {
    const [next, nextHotspots] = await Promise.all([loadHazeData(), loadHotspots()]);
    if (nextHotspots?.generatedAt !== hotspots?.generatedAt) scene.setHotspots(nextHotspots);
    hotspots = nextHotspots;
    const prev = data;
    const followNow = !prev || index === prev.nowIndex;
    const prevT = prev?.timeline[index]?.t;
    data = next;
    slider.max = data.timeline.length - 1;
    const keep = data.timeline.findIndex((h) => h.t === prevT);
    select(followNow || keep === -1 ? data.nowIndex : keep);
    renderPsi(data);

    const latest = data.timeline[data.nowIndex];
    const readingAt = latest?.kind === 'observed' ? `reading ${formatHour(latest.t).split(' ').slice(1).join(' ')}` : 'model only';
    if (data.errors.length) {
      setStatus(`Partial data · ${data.errors[0]}`, 'warn');
      // NEA occasionally rate-limits; try again soon rather than in 10 minutes.
      clearTimeout(retryTimer);
      retryTimer = setTimeout(refresh, RETRY_MS);
    }
    else setStatus(`Live · ${readingAt} · checked ${formatClock(data.fetchedAt)}`, 'live');
  } catch (err) {
    console.error(err);
    setStatus(data ? `Refresh failed · showing ${formatClock(data.fetchedAt)} data` : 'Could not reach data sources · retrying', 'error');
  }
}

function togglePlay(force) {
  const play = force ?? !playTimer;
  clearInterval(playTimer);
  playTimer = null;
  $('play').textContent = play ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', play ? 'Pause' : 'Play forecast');
  if (!play || !data) return;
  if (index >= data.timeline.length - 1) select(data.nowIndex);
  playTimer = setInterval(() => {
    if (index >= data.timeline.length - 1) return togglePlay(false);
    select(index + 1);
  }, PLAY_STEP_MS);
}

async function main() {
  renderLegend();
  const [geo, context] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/planning-areas.json`).then((r) => r.json()),
    // Optional: water bodies and neighbouring coastlines; the map still works without them.
    fetch(`${import.meta.env.BASE_URL}data/context.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const gutter = 16;
  scene = createScene($('map'), geo, {
    context,
    // Screen space taken by the cards, so the camera frames the island in what's left.
    getInsets: () => {
      const wide = window.innerWidth > 900;
      const header = document.querySelector('.brand').offsetHeight + gutter;
      const timeline = document.querySelector('.timeline').offsetHeight + gutter;
      const panel = $('panel').offsetHeight + gutter;
      return wide
        ? { top: header * 0.6, right: $('panel').offsetWidth + 2 * gutter, bottom: timeline + gutter, left: 0 }
        : { top: header, right: 0, bottom: timeline + panel + gutter, left: 0 };
    },
  });

  scene.onHover((area, x, y) => {
    if (!area) return (tooltip.hidden = true);
    const v = area.value;
    tooltip.hidden = false;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.innerHTML = `<b>${area.name}</b><br>${v == null ? 'No data' : `${formatValue(v)} · ${bandOf(v).label}`}<br><span style="opacity:.75">NEA ${area.neaRegion} region</span>`;
  });

  // Scrub the timeline by pointer; the hidden range input handles keyboard
  wrap.addEventListener('pointerdown', (e) => {
    if (!chart) return;
    wrap.setPointerCapture(e.pointerId);
    togglePlay(false);
    select(chart.indexAt(e.clientX));
    slider.focus({ preventScroll: true });
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!chart) return;
    const i = chart.indexAt(e.clientX);
    if (e.buttons) select(i);
    showChartTip(i);
  });
  wrap.addEventListener('pointerleave', () => (tip.hidden = true));
  slider.addEventListener('input', () => {
    togglePlay(false);
    select(Number(slider.value));
    showChartTip(index);
  });
  slider.addEventListener('blur', () => (tip.hidden = true));

  // Same NEA reading, shown on NEA's µg/m³ bands or as US EPA AQI (like aqicn.org)
  for (const btn of document.querySelectorAll('[data-scale]')) {
    btn.addEventListener('click', () => {
      setScale(btn.dataset.scale);
      renderLegend();
      if (data) select(index);
    });
  }

  $('play').addEventListener('click', () => togglePlay());
  $('now').addEventListener('click', () => {
    togglePlay(false);
    if (data) select(data.nowIndex);
    scene.resetView();
  });

  new ResizeObserver(() => data && (chart = renderChart(data, index))).observe(wrap);
  // On phones the panel sits on top of the timeline, whose height depends on wrapping.
  const timelineCard = document.querySelector('.timeline');
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--timeline-h', `${timelineCard.offsetHeight}px`);
  }).observe(timelineCard);

  await refresh();
  scene.refit(); // cards now have their real size
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && data && Date.now() - data.fetchedAt > REFRESH_MS) refresh();
  });
}

main().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`, 'error');
});
