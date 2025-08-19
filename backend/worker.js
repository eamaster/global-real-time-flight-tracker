// Cloudflare Workers version of the flight tracker backend
// This replaces the Express.js server for deployment on Cloudflare

// ——— CORS and caching helpers ———
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization',
};

const CACHE_HEADERS = {
    // Edge cache for 12s to respect Cloudflare CPU limits while keeping data fresh
    // caches.default honors s-maxage for TTL when using the Cache API
    'Cache-Control': 'public, max-age=0, s-maxage=12',
};

function withCORS(response, extra = {}) {
    const headers = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
    Object.entries(CACHE_HEADERS).forEach(([k, v]) => headers.set(k, v));
    Object.entries(extra).forEach(([k, v]) => headers.set(k, v));
    return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(obj, status = 200, extra = {}) {
    const headers = new Headers({
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
        ...CACHE_HEADERS,
        ...extra,
    });
    return new Response(JSON.stringify(obj), { status, headers });
}

let accessToken = null;

// Function to get OAuth2 token from OpenSky Network
const getOpenSkyToken = async () => {
    const clientId = OPENSKY_CLIENT_ID;
    const clientSecret = OPENSKY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('OpenSky client ID or secret not configured.');
        return null;
    }

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        accessToken = data.access_token;
        console.log('Successfully obtained OpenSky access token.');
        return accessToken;

    } catch (error) {
        console.error('Error getting OpenSky token:', error.message);
        accessToken = null;
        return null;
    }
};

// Function to fetch flight data from OpenSky API
const fetchFlightData = async (request) => {
    // Try to get a token, but continue without authentication if credentials are missing
    if (!accessToken) {
        const token = await getOpenSkyToken();
        // Continue without token if credentials are not configured (use public API)
        if (!token) {
            console.log('No OpenSky credentials configured, using public API (rate limited)');
        }
    }

    try {
        const url = new URL(request.url);
        const lat_min = url.searchParams.get('lat_min');
        const lon_min = url.searchParams.get('lon_min');
        const lat_max = url.searchParams.get('lat_max');
        const lon_max = url.searchParams.get('lon_max');

        let apiUrl = 'https://opensky-network.org/api/states/all';

        // Add bounding box parameters if they exist
        if (lat_min && lon_min && lat_max && lon_max) {
            apiUrl += `?lamin=${lat_min}&lomin=${lon_min}&lamax=${lat_max}&lomax=${lon_max}`;
        }

        // Make request with or without authentication
        const headers = {};
        if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }
        
        // Upstream fetch (let Cloudflare cache upstream for a short time as well)
        const response = await fetch(apiUrl, { headers });

        if (!response.ok) {
            if (response.status === 401) {
                // Token might be expired, try to get a new one
                accessToken = null;
                const newToken = await getOpenSkyToken();
                if (newToken) {
                    // Retry with new token
                    const retryResponse = await fetch(apiUrl, {
                        headers: {
                            'Authorization': `Bearer ${newToken}`
                        }
                    });
                    if (!retryResponse.ok) {
                        throw new Error(`HTTP error! status: ${retryResponse.status}`);
                    }
                    const retryData = await retryResponse.json();
                    return processFlightData(retryData);
                } else {
                    throw new Error('Failed to refresh authentication token');
                }
            } else if (response.status === 429) {
                return jsonResponse({ message: 'Rate limit exceeded. Please try again later.' }, 429);
            } else {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        }

        const data = await response.json();
        return processFlightData(data);

    } catch (error) {
        console.error('Error fetching flight data from OpenSky:', error.message);
        return jsonResponse({ message: 'Failed to fetch flight data.' }, 500);
    }
};

// Function to process and structure flight data
const processFlightData = (data) => {
    const states = Array.isArray(data?.states) ? data.states : [];

    // Fast path: imperative loop to reduce CPU and allocations
    const flights = [];
    for (let i = 0; i < states.length; i++) {
        const s = states[i];
        const lon = s[5];
        const lat = s[6];
        if (typeof lon !== 'number' || typeof lat !== 'number') continue;
        flights.push({
            icao24: s[0],
            callsign: s[1] ? s[1].trim() : null,
            origin_country: s[2],
            time_position: s[3],
            last_contact: s[4],
            longitude: lon,
            latitude: lat,
            baro_altitude: s[7],
            on_ground: s[8],
            velocity: s[9],
            true_track: s[10],
            vertical_rate: s[11],
            sensors: s[12],
            geo_altitude: s[13],
            squawk: s[14],
            spi: s[15],
            position_source: s[16],
        });
    }

    return jsonResponse({ flights }, 200);
};

// Handle CORS preflight requests
const handleCORS = () => new Response(null, { status: 200, headers: { ...CORS_HEADERS, ...CACHE_HEADERS } });

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
        // Edge cache: key includes query to keep bbox-specific entries distinct
        const cache = caches.default;
        const cacheKey = new Request(request.url, request);

        // Try cache first to avoid CPU spikes and ensure CORS headers on cached responses
        const cached = await cache.match(cacheKey);
        if (cached) {
            return withCORS(cached);
        }

        const fresh = await fetchFlightData(request);
        // Store successful responses only
        if (fresh.status === 200) {
            // Ensure CORS + cache headers on the stored response
            const store = withCORS(fresh);
            event?.waitUntil?.(cache.put(cacheKey, store.clone()));
            return store;
        }
        return withCORS(fresh);
    }
    
    // Handle root path with basic info
    if (url.pathname === '/') {
        return jsonResponse({ 
            message: 'Global Real-Time Flight Tracker API',
            endpoints: { '/api/flights': 'GET - Fetch real-time flight data' }
        }, 200);
    }
    
    // 404 for other routes
    return jsonResponse({ message: 'Not Found' }, 404);
}
