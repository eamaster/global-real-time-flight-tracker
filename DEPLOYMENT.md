# Deployment Guide for Global Real-Time Flight Tracker

This guide will help you deploy the flight tracker with frontend on GitHub Pages and backend on Cloudflare Workers.

## Prerequisites

1. **GitHub Account** with repository access
2. **Cloudflare Account** (free plan) - https://dash.cloudflare.com/767ce92674d0bd477eef696c995faf16/home/developer-platform
3. **OpenSky Network API Credentials** - Register at https://opensky-network.org/
4. **Mapbox Access Token** - Get from https://account.mapbox.com/

## Backend Deployment (Cloudflare Workers)

### Step 1: Install Wrangler CLI
```bash
npm install -g wrangler
```

### Step 2: Login to Cloudflare
```bash
wrangler login
```

### Step 3: Deploy the Worker
```bash
cd backend
wrangler deploy
```

### Step 4: Set Environment Variables
After deployment, set these environment variables in your Cloudflare dashboard:

1. Go to Workers & Pages > global-flight-tracker-api > Settings > Variables
2. Add the following environment variables:
   - `OPENSKY_CLIENT_ID`: Your OpenSky Network client ID
   - `OPENSKY_CLIENT_SECRET`: Your OpenSky Network client secret

### Step 5: Get Your Worker URL
After deployment, your API will be available at:
`https://global-flight-tracker-api.hesam.workers.dev`

## Frontend Deployment (GitHub Pages)

### Step 1: Repository Setup
1. Push your code to GitHub repository
2. Go to repository Settings > Pages
3. Set Source to "GitHub Actions"

### Step 2: Configure Secrets
In your GitHub repository, go to Settings > Secrets and variables > Actions, and add:

- `VITE_MAPBOX_TOKEN`: Your Mapbox access token
- `VITE_API_URL`: Your Cloudflare Worker URL (e.g., `https://global-flight-tracker-api.hesam.workers.dev`)

### Step 3: Custom Domain Setup
1. In your repository Settings > Pages
2. Set Custom domain to: `hesam.me`
3. Enable "Enforce HTTPS"

### Step 4: DNS Configuration
Add a CNAME record in your DNS settings:
```
CNAME   hesam.me   yourusername.github.io
```

## Testing the Deployment

1. **Backend Test**: Visit `https://global-flight-tracker-api.hesam.workers.dev/api/flights`
2. **Frontend Test**: Visit `https://hesam.me/global-real-time-flight-tracker`

## Environment Variables Summary

### Backend (Cloudflare Workers)
- `OPENSKY_CLIENT_ID`: OpenSky Network OAuth2 client ID
- `OPENSKY_CLIENT_SECRET`: OpenSky Network OAuth2 client secret

### Frontend (GitHub Actions)
- `VITE_MAPBOX_TOKEN`: Mapbox GL JS access token
- `VITE_API_URL`: Cloudflare Worker API URL

## Troubleshooting

### Common Issues

1. **CORS Errors**: The worker includes CORS headers, but if you encounter issues, check the browser console
2. **OpenSky API Rate Limits**: Free tier has limitations; consider upgrading for production use
3. **Mapbox Token**: Ensure your token has the correct scopes for web applications

### Logs and Debugging

- **Cloudflare Workers**: Check logs in Cloudflare dashboard > Workers & Pages > global-flight-tracker-api > Logs
- **GitHub Actions**: Check the Actions tab in your repository for build logs

## Production Considerations

1. **Rate Limiting**: Implement caching to reduce API calls to OpenSky Network
2. **Error Handling**: Add retry logic for failed API requests
3. **Monitoring**: Set up alerts for API failures
4. **Security**: Rotate API keys regularly

## Local Development

For local development, you can still use the original setup:

```bash
# Backend
cd backend
npm install
npm start

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

The frontend will proxy API calls to localhost:5000 during development.
