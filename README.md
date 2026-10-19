# Singapore Haze Map

A cartoon 3D map of Singapore showing live PM2.5 haze readings and a 4-day forecast. It is a static site with no backend, so it can be hosted on GitHub Pages. The haze map needs no API keys; the optional fire-hotspot layer needs a free NASA key.

## What it shows

- **Live readings:** NEA hourly PM2.5 and 24-hr PSI for the 5 reporting regions, from data.gov.sg. The page refreshes every 10 minutes and again when you return to the tab.
- **Past 24 h:** observed hourly PM2.5, drawn as a solid line on the timeline.
- **Forecast:** Open-Meteo's air-quality API (the CAMS global model), up to about 4 days, drawn dashed. Forecast values start at the latest NEA reading and blend into the raw model over about 12 h, so the map doesn't jump at "now".
- **Wind:** the Open-Meteo 10 m wind drives the drifting haze particles and the compass.
- **Fire hotspots (optional):** NASA FIRMS VIIRS detections from Sumatra to Borneo over the last 24 h, grouped into clusters and drawn as cartoon flames on the sea. A cluster is marked **upwind** when the wind at the selected hour blows from its direction toward Singapore. Each marker points in the true direction, but distances are log-compressed so 100–800 km fits just beyond the coast.
- **Map:** the 55 URA planning areas as extruded toon tiles. Each area takes the colour of the NEA region whose label point is nearest its centroid. Real reservoirs and Marina Bay are cut in as water, the Johor and Batam coasts frame the view, and cartoon landmarks mark familiar places: Marina Bay Sands, the Singapore Flyer, Gardens by the Bay, the Changi runways and Jewel, the Jurong Island tanks and the Causeway.
- **Scale switch:** NEA µg/m³ bands (default) or US EPA AQI, which matches aqicn.org (for example 73 µg/m³ → 160). Add `?scale=us` to link straight to the US view.

The PM2.5 colour bands follow NEA's 1-hr bands: Normal 0–55, Elevated 56–150, High 151–250, Very high 251+.

### Limitations

- The forecast model works in cells about 40 km wide. It shows an island-wide trend, not a different prediction for each street or region.
- NEA publishes 5 regional values. The 55 planning areas show those values; they are not individual measurements.

## Develop

```bash
npm install
npm run dev
```

`public/data/planning-areas.json` is generated from data.gov.sg and committed to the repo. To regenerate it:

```bash
npm run geo
```

`public/data/context.json` holds the geography that makes the map recognisable: reservoirs and Marina Bay (OpenStreetMap, via Overpass) and the southern Johor and Riau Islands coastlines (Natural Earth 1:10m). It's committed too. To regenerate it:

```bash
npm run context
```

## Fire hotspots (NASA FIRMS)

FIRMS needs a free key and its API can't be called from a browser (no CORS), so the deploy workflow fetches it and bundles `data/hotspots.json` into the site. Without a key, the site still works and just hides the fire layer.

1. Request a free MAP_KEY at <https://firms.modaps.eosdis.nasa.gov/api/map_key/> (just an email address).
2. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add `FIRMS_MAP_KEY`.
3. Run the **Deploy to GitHub Pages** workflow (Actions tab → Run workflow), or wait for the next scheduled run.

The workflow rebuilds every 3 hours (`cron: '17 */3 * * *'`). GitHub pauses scheduled workflows in public repos after 60 days with no commits; re-enable it from the Actions tab if that happens. FIRMS near-real-time data usually lags the satellite pass by about 3 hours.

To try it locally:

```bash
FIRMS_MAP_KEY=your_key npm run hotspots
npm run dev
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo on the `main` branch.
2. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Optionally, add the `FIRMS_MAP_KEY` secret (see above) to enable fire hotspots.
4. Every push to `main` runs `.github/workflows/deploy.yml`, which builds and publishes the site. You can also run it manually from the Actions tab.

`vite.config.js` uses a relative `base: './'`, so the site works at `https://<user>.github.io/<any-repo-name>/` without any changes.

## Data sources

- [NEA real-time PM2.5 and PSI](https://data.gov.sg/datasets?topics=environment) via data.gov.sg (Singapore Open Data Licence)
- [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) (CAMS) and [Forecast API](https://open-meteo.com/en/docs) (CC BY 4.0)
- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) VIIRS active fire detections (S-NPP, NOAA-20, NOAA-21)
- URA Master Plan 2019 Planning Area Boundary (No Sea), via data.gov.sg
- Reservoirs and water bodies © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)
- Neighbouring coastlines from [Natural Earth](https://www.naturalearthdata.com/) (public domain)
