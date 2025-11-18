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
- **Realistic Flight Display** - Only shows airborne aircraft (filters out parked/taxiing planes)
- **Altitude Filter** - Displays flights above 100 meters
- **Speed Filter** - Shows flights moving faster than 50 m/s (~100 knots)
- **Stale Data Filter** - Removes positions older than 60 seconds
- **Bounding Box Limit** - Maximum 80° viewing area for optimal performance

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

Create a `.env` file in the backend directory:
```env
OPENSKY_CLIENT_ID=your_opensky_client_id
OPENSKY_CLIENT_SECRET=your_opensky_client_secret
```

Start the backend server:
```bash
npm start
```

The backend will run on `http://localhost:5000`

### 3. Frontend Setup
```bash
cd ../frontend
npm install
```

Create a `.env.local` file in the frontend directory:
```env
VITE_MAPBOX_TOKEN=your_mapbox_token
VITE_API_URL=http://localhost:5000
```

Start the frontend development server:
```bash
npm run dev
```

The frontend will run on `http://localhost:5173`

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

### Backend Endpoints (Cloudflare Worker)

- `GET /api/flights` - Fetch real-time flight data
  - Query parameters: `lat_min`, `lon_min`, `lat_max`, `lon_max` (bounding box)
  - Returns: Array of flight state vectors with all 18 OpenSky fields
  - Caching: 10 seconds

- `GET /api/flight-info?icao24={icao24}` - Get flight route information
  - Returns: Departure/arrival airports, times, and flight duration
  - Caching: 24 hours

- `GET /api/flight-track?icao24={icao24}` - Get flight trajectory
  - Returns: Historical flight path with waypoints
  - Caching: 1 hour

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

### Common Issues

1. **CORS Errors**: The worker includes CORS headers, but if you encounter issues, check the browser console
2. **OpenSky API Rate Limits**: 
   - Free tier: 10 requests/minute
   - Authenticated: 1,000 requests/minute
   - The app uses OAuth2 authentication for higher limits
3. **Mapbox Token**: Ensure your token has the correct scopes for web applications
4. **Environment Variables**: Make sure all required environment variables are set in both local and production environments
5. **502 Errors**: See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed troubleshooting
6. **No Flights Showing**: 
   - Check if viewing area is too large (max 80°)
   - Verify OpenSky API credentials are set
   - Check browser console for error messages

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
