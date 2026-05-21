# Global Real-Time Flight Tracker

A web application to track flights in real time on an interactive Mapbox map. Data comes from the [OpenSky Network](https://opensky-network.org/) API locally, and from OpenSky plus [adsb.lol](https://api.adsb.lol/docs) in production on Cloudflare Workers.

**Live site:** [https://hesam.me/global-real-time-flight-tracker/](https://hesam.me/global-real-time-flight-tracker/)  
**Production API:** `https://global-flight-tracker-api.smah0085.workers.dev`

---

## Features

- **Real-time flight tracking** — Thousands of aircraft on an interactive world map
- **Smooth animation** — Interpolated movement at 60 FPS
- **Search** — By callsign (e.g. `UAL123`) or ICAO24 hex code
- **Flight popups** — Altitude, speed, heading, vertical rate, route info, and tracks
- **Smart filtering** — Airborne only, minimum altitude/speed, stale positions removed, 80° bbox limit
- **Auto-refresh** — Polls every 15 seconds; debounced refetch on pan/zoom

---

## Tech Stack

| Layer | Local | Production |
|-------|-------|------------|
| Frontend | React, Vite, Mapbox GL JS | GitHub Pages |
| Backend | Express (`server.js`) | Cloudflare Worker (`worker.js`) |
| Flight data | OpenSky Network | OpenSky + adsb.lol fallback |

---

## Prerequisites

1. **OpenSky Network credentials** — [opensky-network.org](https://opensky-network.org/) → My OpenSky → API Access → create an application
2. **Mapbox access token** — [account.mapbox.com/access-tokens/](https://account.mapbox.com/access-tokens/)
3. **Cloudflare account** — For backend deployment ([dash.cloudflare.com](https://dash.cloudflare.com/))
4. **GitHub account** — For frontend deployment via GitHub Actions

---

## Local Development

Use two terminals — one for the backend, one for the frontend.

### 1. Clone and install

```bash
git clone https://github.com/eamaster/global-real-time-flight-tracker.git
cd global-real-time-flight-tracker
```

### 2. Backend

```bash
cd backend
npm install
```

Create `backend/.env` (never commit — already in `.gitignore`):

```env
PORT=3001
OPENSKY_CLIENT_ID=your_opensky_client_id
OPENSKY_CLIENT_SECRET=your_opensky_client_secret
```

Start the server:

```bash
npm run dev    # auto-restart on changes (Node 18+)
# or
npm start
```

Backend runs at **http://localhost:3001**

Verify:

```bash
curl "http://localhost:3001/"
curl "http://localhost:3001/api/flights?lat_min=45&lon_min=5&lat_max=55&lon_max=15"
```

### 3. Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env.local` (never commit):

```env
VITE_MAPBOX_TOKEN=your_mapbox_token_here

# Leave empty — Vite proxies /api/* → http://localhost:3001
VITE_API_URL=

VITE_BASE_PATH=/
```

Start the dev server:

```bash
npm run dev
```

Open **http://localhost:5173**

### Expected behaviour on localhost

- Map loads centred on Europe (zoom 5)
- Flights appear within a few seconds when OpenSky has coverage
- Panning/zooming triggers a new fetch on `moveend`
- Viewport wider than 80° shows *"Zoom in to load flights"*
- Backend offline → *"Cannot reach the backend"* banner
- Missing Mapbox token → map stays blank with setup instructions

---

## Production Deployment

### Backend — Cloudflare Workers

1. **Install and log in to Wrangler**

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Set OpenSky secrets** (recommended — higher rate limits; use **Secrets**, not plain vars):

   ```bash
   cd backend
   npx wrangler secret put OPENSKY_CLIENT_ID
   npx wrangler secret put OPENSKY_CLIENT_SECRET
   ```

   Or in the Cloudflare dashboard: **Workers & Pages → global-flight-tracker-api → Settings → Variables and Secrets**.

3. **Deploy**

   ```bash
   cd backend
   npm install
   npm run deploy
   ```

   Worker URL: `https://global-flight-tracker-api.smah0085.workers.dev`

4. **Verify**

   ```bash
   curl "https://global-flight-tracker-api.smah0085.workers.dev/"
   curl "https://global-flight-tracker-api.smah0085.workers.dev/api/flights?lat_min=45&lon_min=5&lat_max=55&lon_max=15"
   ```

   Real data: `"_source":"adsb_lol"` or OpenSky hex IDs (e.g. `39e699`). Demo data: `"_source":"enhanced_sample"` with `SAMPLE001`-style IDs.

   Diagnostics: `GET /api/diagnostics` — reports OpenSky vs adsb.lol reachability from the worker.

#### Why adsb.lol in production?

OpenSky (`opensky-network.org` and its auth server) often **times out from Cloudflare Workers edge**. The worker queries OpenSky and adsb.lol **in parallel** and uses whichever responds first. Local dev still uses OpenSky directly via Express.

---

### Frontend — GitHub Pages

1. **Enable Pages** — Repository **Settings → Pages → Source: GitHub Actions**

2. **Add GitHub secret** — **Settings → Secrets and variables → Actions**:
   - `VITE_MAPBOX_TOKEN` — your Mapbox token

   The worker URL and base path are set in `.github/workflows/deploy.yml`:

   ```yaml
   VITE_API_URL: https://global-flight-tracker-api.smah0085.workers.dev
   VITE_BASE_PATH: /global-real-time-flight-tracker/
   ```

3. **Deploy** — Push to `main` or run the workflow manually. The site is served from `frontend/dist` with a `.nojekyll` file and optional `CNAME`.

4. **Custom domain (optional)** — Add `frontend/public/CNAME`, configure DNS, enable HTTPS in Pages settings.

---

## Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `OPENSKY_CLIENT_ID` | `backend/.env`, Cloudflare secret | OpenSky OAuth2 |
| `OPENSKY_CLIENT_SECRET` | `backend/.env`, Cloudflare secret | OpenSky OAuth2 |
| `VITE_MAPBOX_TOKEN` | `frontend/.env.local`, GitHub secret | Mapbox GL JS |
| `VITE_API_URL` | `frontend/.env.local` (prod: workflow) | Backend base URL; empty locally for Vite proxy |
| `VITE_BASE_PATH` | `frontend/.env.local` (prod: workflow) | `/` locally; `/global-real-time-flight-tracker/` on GitHub Pages |

---

## API Endpoints

Both `backend/server.js` (local) and `backend/worker.js` (production) expose the same routes. CORS is enabled on the worker.

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health / API info |
| `GET /api/flights?lat_min&lon_min&lat_max&lon_max` | Real-time flights in bounding box |
| `GET /api/flight-track?icao24=<hex>` | Live trajectory (`time=0` on OpenSky) |
| `GET /api/flight-info?icao24=<hex>` | Recent departure/arrival record |
| `GET /api/diagnostics` | Worker only — upstream connectivity check |

Responses include `_meta` with filter/rejection counts. Fallback responses set `_source` to `adsb_lol` or `enhanced_sample`.

---

## Project Structure

```
global-real-time-flight-tracker/
├── backend/
│   ├── server.js           # Express (local dev)
│   ├── worker.js           # Cloudflare Worker (production)
│   ├── lib/flightUtils.js  # Shared filtering & transforms
│   ├── wrangler.toml
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/FlightMap.jsx
│   │   ├── config/appConfig.js
│   │   ├── App.jsx
│   │   └── main.jsx
│   └── package.json
├── .github/workflows/deploy.yml
└── README.md
```

---

## Troubleshooting

### Demo / sample flights on production

If the live site shows `SAMPLE001`-style flights or a demo-data banner:

1. Hard-refresh the browser (Ctrl+Shift+R)
2. Confirm the API returns real data (see curl commands above)
3. Check `/api/diagnostics` — OpenSky may timeout; adsb.lol should show `"ok":true`
4. Redeploy the worker if needed: `cd backend && npm run deploy`

### Map loads but no flights

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Zoom in to load flights" | Viewport > 80° | Zoom in |
| Zero flights, no message | Backend not running | `npm run dev` in `backend/` |
| Zero flights, count shown | All filtered out | Check Network tab → `api/flights` → `_meta.rejections` |
| Flights disappear | Stale positions (> 5 min) | Normal; wait for next poll |

### Other issues

- **Blank map** — Set `VITE_MAPBOX_TOKEN` in `frontend/.env.local` and restart Vite
- **CORS / cannot reach backend (local)** — Ensure backend is on port 3001; Vite proxies `/api`
- **OpenSky 429** — Add OAuth credentials; anonymous limit is ~10 req/min
- **413 / area too large** — Zoom in (max bbox 80°×80°)
- **502 / timeouts** — OpenSky may be slow; production falls back to adsb.lol automatically

### Logs

- **Cloudflare:** Dashboard → Workers & Pages → global-flight-tracker-api → Logs
- **GitHub Actions:** Repository → Actions tab
- **Local:** Terminal output for both servers; browser DevTools → Network → `api/flights`

---

## Contributing

1. Fork the repository  
2. Create a feature branch  
3. Test locally (backend + frontend)  
4. Open a pull request  

---

## License

MIT License — see [LICENSE](LICENSE).
