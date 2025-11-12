# Global Real-Time Flight Tracker

A web application to track flights in real-time using the OpenSky Network API.

## Features

- Real-time flight tracking on an interactive map
- Filtering flights by various criteria
- Detailed flight information popups
- Responsive design with dark theme
- Automatic data refresh every 10 seconds

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

Create a `.env` file in the frontend directory (copy from `.env.example`):
```env
VITE_MAPBOX_TOKEN=your_mapbox_token
VITE_API_URL=http://localhost:5000
```

**Note:** For local development, you can use the provided Mapbox token. The `.env` file is gitignored and will not be committed to the repository.

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
   - `VITE_MAPBOX_TOKEN`: `pk.eyJ1IjoiZWFtYXN0ZXIiLCJhIjoiY21odnk5ajVlMDB6ejJpcjNsMnEwdHF0OCJ9.5jH7Oi18CkoDe-ua75ijyA`
   - `VITE_API_URL`: Your Cloudflare Worker URL (e.g., `https://global-flight-tracker-api.smah0085.workers.dev`)
   
   **Important:** Make sure the `VITE_MAPBOX_TOKEN` secret matches the token in your `frontend/.env` file.

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

- `GET /api/flights` - Fetch real-time flight data
  - Query parameters: `lat_min`, `lon_min`, `lat_max`, `lon_max` (optional bounding box)

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
└── README.md
```

## Troubleshooting

### Common Issues

1. **CORS Errors**: The worker includes CORS headers, but if you encounter issues, check the browser console
2. **OpenSky API Rate Limits**: Free tier has limitations; consider upgrading for production use
3. **Mapbox Token**: Ensure your token has the correct scopes for web applications
4. **Environment Variables**: Make sure all required environment variables are set in both local and production environments

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
