# Global Real-Time Flight Tracker

A web application to track flights in real-time using the OpenSky Network API.

## Features

- Real-time flight tracking on an interactive map.
- Filtering flights by various criteria.
- Detailed flight information popups.

## Tech Stack

- **Backend:** Node.js, Express
- **Frontend:** React, Mapbox GL JS
- **API:** OpenSky Network REST API

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd global-real-time-flight-tracker
    ```

2.  **Backend Setup:**
    ```bash
    cd backend
    npm install
    ```
    Create a `.env` file and add your OpenSky API credentials:
    ```
    OPENSKY_USERNAME=your_username
    OPENSKY_PASSWORD=your_password
    ```
    Start the backend server:
    ```bash
    npm start
    ```

3.  **Frontend Setup:**
    ```bash
    cd ../frontend
    npm install
    ```
    Create a `.env.local` file and add your Mapbox access token:
    ```
    VITE_MAPBOX_TOKEN=your_mapbox_token
    ```
    Start the frontend development server:
    ```bash
    npm run dev
    ```

## Deployment

The application is configured for production deployment with:
- **Frontend**: GitHub Pages at `hesam.me/global-real-time-flight-tracker`
- **Backend**: Cloudflare Workers

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed deployment instructions.

### Quick Deployment Steps

1. **Deploy Backend to Cloudflare Workers**:
   ```bash
   cd backend
   npm install -g wrangler
   wrangler login
   wrangler deploy
   ```
   Then set environment variables in Cloudflare dashboard.

2. **Deploy Frontend to GitHub Pages**:
   - Push code to GitHub
   - Configure repository secrets (VITE_MAPBOX_TOKEN, VITE_API_URL)
   - GitHub Actions will automatically deploy to Pages

3. **Configure Custom Domain**:
   - Set `hesam.me` as custom domain in GitHub Pages settings
   - Add CNAME DNS record pointing to your GitHub Pages URL
