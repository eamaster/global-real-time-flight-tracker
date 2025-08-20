# Deployment Guide

## Cloudflare Workers Deployment

### 1. Environment Variables Setup

The Cloudflare Worker requires OpenSky API credentials to avoid rate limiting. Set these in your Cloudflare dashboard:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to Workers & Pages
3. Select your `global-flight-tracker-api` worker
4. Go to Settings → Environment Variables
5. Add the following variables:

```
OPENSKY_CLIENT_ID = "your_opensky_client_id"
OPENSKY_CLIENT_SECRET = "your_opensky_client_secret"
```

**To get OpenSky credentials:**
1. Visit [OpenSky Network](https://opensky-network.org/)
2. Create an account
3. Go to your profile → API Access
4. Create a new application
5. Copy the Client ID and Client Secret

### 2. Deploy the Worker

```bash
cd backend
npm install
npx wrangler deploy
```

### 3. Verify Deployment

Test the API endpoint:
```bash
curl "https://global-flight-tracker-api.smah0085.workers.dev/api/flights?lat_min=40&lon_min=-80&lat_max=50&lon_max=-70"
```

## Troubleshooting 502 Errors

### Common Causes and Solutions

1. **Missing Environment Variables**
   - Ensure `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` are set
   - Check Cloudflare dashboard → Workers → Environment Variables

2. **OpenSky API Issues**
   - OpenSky API can be slow or temporarily unavailable
   - The worker now includes retry logic with exponential backoff
   - Check [OpenSky Status](https://opensky-network.org/) for service status

3. **Large Bounding Boxes**
   - Maximum allowed area is 60° x 60° degrees
   - Zoom in further on the map to reduce the query area
   - The frontend now shows a clear message when area is too large

4. **Rate Limiting**
   - Without credentials: 10 requests per minute
   - With credentials: 1000 requests per minute
   - The worker now handles 429 responses gracefully

5. **Timeout Issues**
   - Increased timeout from 10s to 15s
   - Added proper timeout handling and error messages

### Monitoring and Logs

1. **Cloudflare Logs**
   - View real-time logs in Cloudflare dashboard
   - Look for 502, 429, or timeout errors

2. **Frontend Console**
   - Check browser console for detailed error messages
   - Look for retry attempts and error details

3. **API Response Headers**
   - Check for `Retry-After` headers on rate limit errors
   - Monitor response times and status codes

## Performance Optimizations

1. **Caching**
   - Worker now caches responses for 10 seconds
   - Reduces load on OpenSky API

2. **Bounding Box Validation**
   - Prevents overly large queries
   - Improves response times

3. **Retry Logic**
   - Automatic retry with exponential backoff
   - Handles temporary OpenSky API issues

4. **Timeout Management**
   - Increased timeout to 15 seconds
   - Better handling of slow OpenSky responses

## Frontend Improvements

1. **Better Error Handling**
   - Specific error messages for different HTTP status codes
   - Manual retry button for failed requests
   - Clear indication when area is too large

2. **Retry Logic**
   - Automatic retry for server errors (502, 500)
   - Exponential backoff (1s, 2s, 4s delays)
   - Maximum 3 retry attempts

3. **User Experience**
   - Loading states during retries
   - Disabled retry button during retry attempts
   - Clear feedback on all error conditions

## Testing

Test the following scenarios:

1. **Normal Operation**
   - Zoom to a reasonable area (e.g., city or region)
   - Verify flights load correctly

2. **Large Area**
   - Zoom out to see "Area too large" message
   - Verify zooming in resolves the issue

3. **Error Handling**
   - Temporarily disable environment variables
   - Verify graceful fallback to public API
   - Check retry behavior

4. **Rate Limiting**
   - Make many rapid requests
   - Verify 429 handling and retry logic

## Support

If issues persist:

1. Check Cloudflare Worker logs
2. Verify OpenSky API credentials
3. Test with smaller bounding boxes
4. Monitor OpenSky API status
5. Check network connectivity from Cloudflare edge locations
