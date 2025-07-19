# Quick Deployment Guide

This guide provides step-by-step instructions to deploy the flight tracker.

## Prerequisites

1. **OpenSky Network API Credentials** - Register at https://opensky-network.org/
2. **Mapbox Access Token** - Get from https://account.mapbox.com/
3. **Cloudflare Account** - https://dash.cloudflare.com/
4. **GitHub Account**

## Step 1: Deploy Backend to Cloudflare Workers

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy the worker
cd backend
wrangler deploy
```

**Set Environment Variables in Cloudflare Dashboard:**
1. Go to Workers & Pages > global-flight-tracker-api > Settings > Variables
2. Add:
   - `OPENSKY_CLIENT_ID`: Your OpenSky Network client ID
   - `OPENSKY_CLIENT_SECRET`: Your OpenSky Network client secret

**Note your Worker URL:** `https://global-flight-tracker-api.your-subdomain.workers.dev`

## Step 2: Deploy Frontend to GitHub Pages

1. **Push code to GitHub:**
   ```bash
   git add .
   git commit -m "Initial deployment"
   git push origin main
   ```

2. **Configure GitHub Secrets:**
   - Go to your repository Settings > Secrets and variables > Actions
   - Add:
     - `VITE_MAPBOX_TOKEN`: Your Mapbox access token
     - `VITE_API_URL`: Your Cloudflare Worker URL

3. **Enable GitHub Pages:**
   - Go to repository Settings > Pages
   - Set Source to "GitHub Actions"
   - The workflow will automatically deploy on push to main

4. **Configure Custom Domain (hesam.me):**
   - In repository Settings > Pages
   - Set Custom domain to: `hesam.me`
   - Enable "Enforce HTTPS"
   - Add CNAME DNS record: `hesam.me` → `eamaster.github.io`
   - The site will be accessible at: `https://hesam.me/global-real-time-flight-tracker`

## Step 3: Test Your Deployment

- **Backend:** Visit `https://global-flight-tracker-api.your-subdomain.workers.dev/api/flights`
- **Frontend:** Visit `https://hesam.me/global-real-time-flight-tracker` (custom domain with project path)
- **Alternative:** Visit `https://eamaster.github.io/global-real-time-flight-tracker` (GitHub Pages)

## Environment Variables Summary

### Backend (Cloudflare Workers)
- `OPENSKY_CLIENT_ID`: OpenSky Network OAuth2 client ID
- `OPENSKY_CLIENT_SECRET`: OpenSky Network OAuth2 client secret

### Frontend (GitHub Actions)
- `VITE_MAPBOX_TOKEN`: Mapbox GL JS access token
- `VITE_API_URL`: Cloudflare Worker API URL

## Troubleshooting

- **CORS Errors:** Check browser console and ensure CORS headers are set
- **API Rate Limits:** OpenSky free tier has limitations
- **Build Failures:** Check GitHub Actions logs for detailed error messages
- **Environment Variables:** Ensure all secrets are properly set in both platforms
