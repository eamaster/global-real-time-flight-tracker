// Cloudflare Workers version of the flight tracker backend
// This replaces the Express.js server for deployment on Cloudflare

let accessToken = null;
let tokenExpiry = 0;

// Cache for flight info and tracks (24h and 1h TTL respectively)
const flightInfoCache = new Map();
const flightTrackCache = new Map();

// ---------------------------------------------------------------------------
// Filter constants — keep in sync with frontend/src/config/appConfig.js
// ---------------------------------------------------------------------------
const flightUtils = require('./lib/flightUtils');
const { MAX_BBOX_DEGREES } = flightUtils;

// Function to get OAuth2 token from OpenSky Network
const getOpenSkyToken = async () => {
    // Check if we have a valid token
    if (accessToken && Date.now() < tokenExpiry) {
        return accessToken;
    }

    const clientId = OPENSKY_CLIENT_ID;
    const clientSecret = OPENSKY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.log('No OpenSky credentials configured, using public API (rate limited)');
        return null;
    }

    // Add a strict timeout for token fetch so we don't hang the worker
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), 3000);

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        console.log('Getting OAuth2 token from OpenSky...');
        
        const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Token request failed:', response.status, errorText);
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        accessToken = data.access_token;
        // Set token expiry to 25 minutes from now (with 5 minute buffer for 30 min expiry)
        tokenExpiry = Date.now() + (25 * 60 * 1000);
        console.log('Successfully obtained OpenSky OAuth2 access token.');
        return accessToken;

    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Error getting OpenSky token:', error.message || error);
        accessToken = null;
        tokenExpiry = 0;
        return null;
    }
};

// Function to fetch flight data from OpenSky API with fast-failover to simulation
const fetchFlightData = async (request) => {
    // Try to get a token, but continue without authentication if credentials are missing
    if (!accessToken) {
        await getOpenSkyToken();
    }

    const url = new URL(request.url);
    const lat_min = url.searchParams.get('lat_min');
    const lon_min = url.searchParams.get('lon_min');
    const lat_max = url.searchParams.get('lat_max');
    const lon_max = url.searchParams.get('lon_max');

    // Require a bounding box to avoid fetching the entire planet
    if (!(lat_min && lon_min && lat_max && lon_max)) {
        return new Response(
            JSON.stringify({
                message: 'Bounding box required',
                hint: 'Pass lat_min, lon_min, lat_max, lon_max query params to reduce payload'
            }),
            {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                }
            }
        );
    }

    const minLatParsed = parseFloat(lat_min);
    const minLonParsed = parseFloat(lon_min);
    const maxLatParsed = parseFloat(lat_max);
    const maxLonParsed = parseFloat(lon_max);

    if (!Number.isFinite(minLatParsed) || !Number.isFinite(minLonParsed) ||
        !Number.isFinite(maxLatParsed) || !Number.isFinite(maxLonParsed)) {
        return new Response(
            JSON.stringify({
                message: 'Invalid bbox parameters — must be finite numbers.'
            }),
            {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                }
            }
        );
    }

    // Clamp coordinates to valid ranges
    const minLat = Math.max(-90, Math.min(90, minLatParsed));
    const maxLat = Math.max(-90, Math.min(90, maxLatParsed));
    const minLon = Math.max(-180, Math.min(180, minLonParsed));
    const maxLon = Math.max(-180, Math.min(180, maxLonParsed));

    const bboxWidth  = Math.abs(maxLon - minLon);
    const bboxHeight = Math.abs(maxLat - minLat);

    // Reject huge boxes
    if (bboxWidth > MAX_BBOX_DEGREES || bboxHeight > MAX_BBOX_DEGREES) {
        return new Response(
            JSON.stringify({ 
                message: `Bounding box too large (${bboxWidth.toFixed(1)}°×${bboxHeight.toFixed(1)}°). Maximum is ${MAX_BBOX_DEGREES}°×${MAX_BBOX_DEGREES}°. Please zoom in.`,
                maxAllowed: MAX_BBOX_DEGREES
            }),
            {
                status: 413,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                }
            }
        );
    }

    try {
        let apiUrl = `https://opensky-network.org/api/states/all?lamin=${minLat}&lomin=${minLon}&lamax=${maxLat}&lomax=${maxLon}&extended=1`;

        // Make request with or without authentication
        const headers = {};
        if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }

        // Add timeout and small caching to ease pressure
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('timeout'), 4000); // Strict 4s timeout
        
        let response;
        try {
            response = await fetch(apiUrl, {
                headers,
                signal: controller.signal,
                cf: { 
                    cacheTtl: 10,
                    cacheEverything: true 
                }
            });
            clearTimeout(timeout);
        } catch (fetchError) {
            clearTimeout(timeout);
            throw fetchError;
        }

        if (!response.ok) {
            if (response.status === 401) {
                // Token might be expired, try to refresh and retry ONCE
                accessToken = null;
                tokenExpiry = 0;
                const newToken = await getOpenSkyToken();
                if (newToken) {
                    const retryController = new AbortController();
                    const retryTimeout = setTimeout(() => retryController.abort('timeout'), 4000);
                    try {
                        const retryResponse = await fetch(apiUrl, {
                            headers: {
                                'Authorization': `Bearer ${newToken}`
                            },
                            signal: retryController.signal,
                            cf: { 
                                cacheTtl: 10,
                                cacheEverything: true 
                            }
                        });
                        clearTimeout(retryTimeout);
                        if (retryResponse.ok) {
                            const retryData = await retryResponse.json();
                            return processFlightData(retryData);
                        }
                    } catch (retryError) {
                        clearTimeout(retryTimeout);
                    }
                }
            }
            throw new Error(`Upstream error status: ${response.status}`);
        }

        const data = await response.json();
        return processFlightData(data);

    } catch (error) {
        console.error('Error fetching flight data from OpenSky, using fallback:', error.message);
        return await getFallbackFlightData(minLat, maxLat, minLon, maxLon);
    }
};

// Function to generate fallback flight data when OpenSky is down
const getFallbackFlightData = async (minLat, maxLat, minLon, maxLon) => {
    console.log('OpenSky API is down, using enhanced sample data fallback...');
    const fallbackData = flightUtils.generateFallbackFlights(minLat, maxLat, minLon, maxLon);
    return new Response(
        JSON.stringify(fallbackData),
        {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
            }
        }
    );
};

// Function to process and structure flight data
const processFlightData = (data) => {
    const rawStates = data.states ?? [];
    const now = Math.floor(Date.now() / 1000);
    const { flights, stats } = flightUtils.processFlightStates(rawStates, now);

    return new Response(
        JSON.stringify({
            flights,
            _fallback: data._fallback || false,
            _source:   data._source   || null,
            _message:  data._message  || null,
            _meta: {
                rawStateCount: rawStates.length,
                validCoordinateCount: rawStates.length - stats.invalidCoord,
                filteredCount: flights.length,
                rejections: stats,
                serverTimestamp: Date.now(),
            },
            timestamp: Date.now(),
        }),
        {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
            }
        }
    );
};

// Handle CORS preflight requests
const handleCORS = () => {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
        }
    });
};

// Function to fetch flight info (departure/arrival airports)
const fetchFlightInfo = async (icao24) => {
    // Check cache first (24 hour TTL)
    const cacheKey = `info_${icao24}`;
    const cached = flightInfoCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 86400000) { // 24 hours
        return cached.data;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), 5000); // 5s timeout
    
    try {
        const token = await getOpenSkyToken();
        if (!token) {
            clearTimeout(timeout);
            return null; // No auth, skip
        }
        
        const now = Math.floor(Date.now() / 1000);
        const begin = now - 86400; // 24 hours ago
        const end = now;
        
        const response = await fetch(
            `https://opensky-network.org/api/flights/aircraft?icao24=${icao24.toLowerCase()}&begin=${begin}&end=${end}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                signal: controller.signal
            }
        );
        clearTimeout(timeout);
        
        if (!response.ok) {
            return null;
        }
        
        const flights = await response.json();
        const latestFlight = flights && flights.length > 0 ? flights[flights.length - 1] : null;
        
        // Cache the result
        flightInfoCache.set(cacheKey, {
            data: latestFlight,
            timestamp: Date.now()
        });
        
        // Clean old cache entries (keep last 1000)
        if (flightInfoCache.size > 1000) {
            const firstKey = flightInfoCache.keys().next().value;
            flightInfoCache.delete(firstKey);
        }
        
        return latestFlight;
    } catch (error) {
        clearTimeout(timeout);
        console.error('Error fetching flight info:', error.message);
        return null;
    }
};

// Function to fetch flight track/trajectory
const fetchFlightTrack = async (icao24) => {
    // Check cache first (1 hour TTL)
    const cacheKey = `track_${icao24}`;
    const cached = flightTrackCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour
        return cached.data;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), 5000); // 5s timeout
    
    try {
        const token = await getOpenSkyToken();
        if (!token) {
            clearTimeout(timeout);
            return null; // No auth, skip
        }
        
        const response = await fetch(
            `https://opensky-network.org/api/tracks/all?icao24=${icao24.toLowerCase()}&time=0`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                signal: controller.signal
            }
        );
        clearTimeout(timeout);
        
        if (!response.ok) {
            return null;
        }
        
        const track = await response.json();
        
        // Cache the result
        flightTrackCache.set(cacheKey, {
            data: track,
            timestamp: Date.now()
        });
        
        // Clean old cache entries (keep last 500)
        if (flightTrackCache.size > 500) {
            const firstKey = flightTrackCache.keys().next().value;
            flightTrackCache.delete(firstKey);
        }
        
        return track;
    } catch (error) {
        clearTimeout(timeout);
        console.error('Error fetching flight track:', error.message);
        return null;
    }
};

// Main event listener for Cloudflare Workers
addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    const url = new URL(request.url);
    
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
        return handleCORS();
    }
    
    // Handle API routes
    if (url.pathname === '/api/flights' && request.method === 'GET') {
        return await fetchFlightData(request);
    }
    
    // Handle flight info endpoint
    if (url.pathname === '/api/flight-info' && request.method === 'GET') {
        const icao24 = url.searchParams.get('icao24');
        if (!icao24) {
            return new Response(
                JSON.stringify({ error: 'icao24 parameter required' }),
                {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                    }
                }
            );
        }
        
        const flightInfo = await fetchFlightInfo(icao24);
        return new Response(
            JSON.stringify(flightInfo || {}),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization',
                    'Cache-Control': 'public, max-age=3600' // Cache 1 hour
                }
            }
        );
    }
    
    // Handle flight track endpoint
    if (url.pathname === '/api/flight-track' && request.method === 'GET') {
        const icao24 = url.searchParams.get('icao24');
        if (!icao24) {
            return new Response(
                JSON.stringify({ error: 'icao24 parameter required' }),
                {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                    }
                }
            );
        }
        
        const track = await fetchFlightTrack(icao24);
        return new Response(
            JSON.stringify(track || {}),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization',
                    'Cache-Control': 'public, max-age=600' // Cache 10 minutes
                }
            }
        );
    }
    
    // Handle root path with basic info
    if (url.pathname === '/') {
        return new Response(
            JSON.stringify({ 
                message: 'Global Real-Time Flight Tracker API',
                endpoints: {
                    '/api/flights': 'GET - Fetch real-time flight data',
                    '/api/flight-info': 'GET - Fetch flight info (departure/arrival)',
                    '/api/flight-track': 'GET - Fetch flight trajectory'
                }
            }),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                }
            }
        );
    }
    
    // 404 for other routes
    return new Response(
        JSON.stringify({ message: 'Not Found' }),
        { 
            status: 404,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
            }
        }
    );
}
