# Global Real-Time Flight Tracker

A web application to track flights in real-time using the OpenSky Network API.

## Features

### Core Features
- ✈️ **Real-time Flight Tracking** - Track thousands of flights worldwide on an interactive map
- 🎯 **Smooth 60 FPS Animation** - FlightRadar24-style smooth movement with position interpolation
- 🔍 **Aircraft Search** - Search by callsign (e.g., "UAL123") or ICAO24 code with auto-zoom
- 📊 **Accurate Flight Count** - Real-time count of visible flights matching what's displayed on map
- 🛤️ **Flight Path Trails** - Visual flight trajectories showing complete route history
- 📱 **Enhanced Flight Popups** - Detailed information including:
  - Departure and arrival airports
  - Departure time and flight duration
  - Real-time altitude, speed, heading, and vertical rate
  - Compass direction indicators
  - Climbing/descending status
  - Aircraft category information

### Smart Filtering
- **Realistic Flight Display** — Only shows airborne aircraft (filters out parked/taxiing planes)
- **Altitude Filter** — Displays flights above 100 metres
- **Speed Filter** — Shows flights faster than 20 m/s (~39 knots); null velocity is kept
- **Stale Data Filter** — Removes positions older than 5 minutes (300 s)
- **Bounding Box Limit** — Maximum 80° viewing area; shows "Zoom in to load flights" if exceeded

### Technical Features
- **OAuth2 Authentication** - Uses OpenSky Network authenticated API for higher rate limits
- **Smart Caching** - 24-hour cache for flight info, 1-hour cache for flight tracks
- **Error Handling** - Automatic retry with exponential backoff
- **Responsive Design** - Dark theme optimized for all screen sizes
- **Automatic Updates** - Refreshes flight data every 15 seconds

## Tech Stack

- **Backend:** Node.js, Express (local) / Cloudflare Workers (production)
- **Frontend:** React, Vite, Mapbox GL JS
- **API:** OpenSky Network REST API
- **Deployment:** GitHub Pages (frontend), Cloudflare Workers (backend)

## Prerequisites

Before setting up the project, you'll need:

1. **OpenSky Network API Credentials** - Register at https://opensky-network.org/
2. **Mapbox Access Token** - Get from https://account.mapbox.com/
3. **Cloudflare Account** (for backend deployment) - https://dash.cloudflare.com/
4. **GitHub Account** (for frontend deployment)

## Local Development Setup

> **Quick start:** Two terminal windows — one for the backend, one for the frontend.

### 1. Clone the Repository
```bash
git clone <repository-url>
cd global-real-time-flight-tracker
```

### 2. Backend Setup
```bash
cd backend
npm install
```

Create `backend/.env` (never commit this file — it's in `.gitignore`):
```env
PORT=3001
OPENSKY_CLIENT_ID=your_opensky_client_id
OPENSKY_CLIENT_SECRET=your_opensky_client_secret
```

Start the backend:
```bash
npm run dev        # auto-restarts on file changes (Node 18+)
# or
npm start          # single run
```

The backend runs on **http://localhost:3001**

Verify it works:
```bash
curl "http://localhost:3001/"
curl "http://localhost:3001/api/flights?lat_min=45&lon_min=5&lat_max=55&lon_max=15"
```

### 3. Frontend Setup
```bash
cd ../frontend
npm install
```

Create `frontend/.env.local` (never commit this file — it's in `.gitignore`):
```env
VITE_MAPBOX_TOKEN=your_mapbox_token_here

# Leave VITE_API_URL empty for local dev.
# The Vite proxy will forward /api/* to http://localhost:3001.
VITE_API_URL=

VITE_BASE_PATH=/
```

Start the frontend:
```bash
npm run dev
```

Open **http://localhost:5173** in your browser.

### 4. Expected Behaviour on Localhost

- Map loads centred on Europe at zoom 5 (bbox ~35°×25°, well within the 80° limit)
- Flights appear within a few seconds if OpenSky returns data for that region
- Panning / zooming triggers a new fetch on `moveend`
- Zooming out past the 80° limit shows: *"Zoom in to load flights"*
- If zero flights are returned the UI shows how many were rejected and why
- If the backend is not running a clear "Cannot reach backend" error is shown

## Production Deployment

### Backend Deployment (Cloudflare Workers)

1. **Install Wrangler CLI**:
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare**:
   ```bash
   wrangler login
   ```

3. **Deploy the Worker**:
   ```bash
   cd backend
   wrangler deploy
   ```

4. **Set Environment Variables** in Cloudflare Dashboard:
   - Go to Workers & Pages > global-flight-tracker-api > Settings > Variables
   - Add:
     - `OPENSKY_CLIENT_ID`: Your OpenSky Network client ID
     - `OPENSKY_CLIENT_SECRET`: Your OpenSky Network client secret

5. **Get Your Worker URL**:
   After deployment, your API will be available at:
   `https://global-flight-tracker-api.your-subdomain.workers.dev`

### Frontend Deployment (GitHub Pages)

1. **Push Code to GitHub**:
   ```bash
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```

2. **Configure Repository Secrets**:
   In your GitHub repository, go to Settings > Secrets and variables > Actions, and add:
   - `VITE_MAPBOX_TOKEN`: Your Mapbox access token
   - `VITE_API_URL`: Your Cloudflare Worker URL

3. **Enable GitHub Pages**:
   - Go to repository Settings > Pages
   - Set Source to "GitHub Actions"
   - The workflow will automatically deploy on push to main branch

4. **Custom Domain (Optional)**:
   - In repository Settings > Pages
   - Set Custom domain to your desired domain
   - Enable "Enforce HTTPS"
   - Add CNAME DNS record pointing to your GitHub Pages URL

## Environment Variables

### Backend (Cloudflare Workers)
- `OPENSKY_CLIENT_ID`: OpenSky Network OAuth2 client ID
- `OPENSKY_CLIENT_SECRET`: OpenSky Network OAuth2 client secret

### Frontend (GitHub Actions)
- `VITE_MAPBOX_TOKEN`: Mapbox GL JS access token
- `VITE_API_URL`: Cloudflare Worker API URL

## API Endpoints

Both the local Express server (`server.js`) and the Cloudflare Worker (`worker.js`) expose the **same three endpoints**. All three proxy authenticated requests to OpenSky.

### `GET /api/flights`
Real-time state vectors for a geographic bounding box.
- **Query:** `lat_min`, `lon_min`, `lat_max`, `lon_max` (all required)
- **OpenSky source:** `GET /api/states/all?lamin=...&lomin=...&lamax=...&lomax=...&extended=1`
- **Returns:** Filtered/transformed flight array + `_meta` diagnostic object

### `GET /api/flight-track?icao24=<hex>`
Live trajectory waypoints for a single aircraft.
- **Query:** `icao24` — 6-character lowercase hex ICAO24 address
- **OpenSky source:** `GET /api/tracks/all?icao24=<hex>&time=0` (`time=0` = live/current track)
- **Response:** `{ icao24, callsign, startTime, endTime, path[] }`
  - Each `path` entry: `[time, lat, lon, baro_altitude, true_track, on_ground]`
- **Note:** OpenSky returns 404 when no track exists — backend returns `{ path: [] }` gracefully

### `GET /api/flight-info?icao24=<hex>`
Most recent flight record (departure/arrival airports, times).
- **Query:** `icao24` — 6-character lowercase hex ICAO24 address
- **OpenSky source:** `GET /api/flights/aircraft?icao24=<hex>&begin=<24h_ago>&end=<now>`
- **Returns:** Most recent flight record or `null` if none found

## Project Structure

```
global-real-time-flight-tracker/
├── backend/
│   ├── server.js          # Express server for local development
│   ├── worker.js          # Cloudflare Workers script
│   ├── wrangler.toml      # Cloudflare Workers configuration
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   └── FlightMap.jsx
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   └── package.json
├── .github/workflows/
│   └── deploy.yml         # GitHub Actions deployment workflow
├── README.md              # This file
└── DEPLOYMENT.md          # Detailed deployment guide
```

## Performance

### API Usage
- **Real-time positions**: ~7,000 requests/day
- **Flight info popups**: ~50 requests/day (90% cache hit rate)
- **Flight tracks**: ~150 requests/day (80% cache hit rate)
- **Total**: ~10,200 API credits/day (within OpenSky contributor limits)

### Browser Performance
- **Frame Rate**: Consistent 60 FPS
- **Memory Usage**: ~2MB per 1,000 flights
- **CPU Usage**: ~5-10% per core during animation
- **Scalability**: Handles 1,000+ flights smoothly

## Troubleshooting

### Map loads but no flights appear

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Zoom in to load flights" message | Viewport > 80° | Zoom in — map starts at zoom 5 which is fine |
| Zero flights, no message | Backend not running | Start `npm run dev` in `backend/` |
| Zero flights, count shown | All filtered out | Check console `[Flight Filter]` log for rejection counts |
| Flights appear then vanish | Position age > 5 min | OpenSky feed delay — normal, wait for next update |

### Missing Mapbox token

The map will be blank. Add `VITE_MAPBOX_TOKEN=...` to `frontend/.env.local` and restart `npm run dev`.

### Backend not running / CORS error

Open http://localhost:3001/ in the browser — you should see the API health JSON. If not, the backend is not running. Start it with `npm run dev` in `backend/`.

### OpenSky credentials missing

The backend logs `[Auth] OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set`. It will fall back to the anonymous public API which has stricter rate limits. Add credentials to `backend/.env`.

### OpenSky rate limit (429)

The app shows a banner and waits. Anonymous API: ~10 req/min. Authenticated: much higher. Use OAuth2 credentials.

### Area too large (413 / "Zoom in" message)

The bounding box exceeds 80°×80°. Zoom in on the map — the default zoom of 5 always fits.

### CORS errors in browser console

Make sure the backend is running. The Vite proxy (`/api → localhost:3001`) handles CORS in local dev. In production, CORS headers are set in the Cloudflare Worker.

### Diagnostic metadata

Every API response includes `_meta.rejections` showing exactly how many flights were filtered and why. Check the browser Network tab → `api/flights` response body.

### Logs and Debugging

- **Cloudflare Workers**: Check logs in Cloudflare dashboard > Workers & Pages > global-flight-tracker-api > Logs
- **GitHub Actions**: Check the Actions tab in your repository for build logs
- **Local Development**: Check terminal output for both frontend and backend servers

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Submit a pull request

## License

This project is open source and available under the [MIT License](LICENSE).
