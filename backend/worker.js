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
const openskyApi = require('./lib/openskyApi');
const { MAX_BBOX_DEGREES } = flightUtils;

// OpenSky is unreachable from many Cloudflare edge POPs; fail fast then use adsb.lol.
const OPENSKY_FETCH_TIMEOUT_MS = 8_000;
const OPENSKY_MAX_RETRIES = 0;
const ADSB_LOL_FETCH_TIMEOUT_MS = 10_000;

const jsonCorsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOpenSkyWithRetry(url, headers = {}, maxRetries = OPENSKY_MAX_RETRIES) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('timeout'), OPENSKY_FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'global-flight-tracker-api/1.0',
                    ...headers,
                },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (response.status === 429 && attempt < maxRetries) {
                const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10);
                await sleep(Math.max(retryAfter, 1) * 1000);
                continue;
            }

            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            lastError = error;
            if (attempt < maxRetries) {
                await sleep(Math.pow(2, attempt) * 1000);
            }
        }
    }

    throw lastError || new Error('OpenSky fetch failed after retries');
}

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

    // Allow enough time for auth.opensky-network.org from Cloudflare edge (3 s was too short).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), 10_000);

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        console.log('Getting OAuth2 token from OpenSky...');
        
        const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'global-flight-tracker-api/1.0',
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
        const apiUrl = `https://opensky-network.org/api/states/all?lamin=${minLat}&lomin=${minLon}&lamax=${maxLat}&lomax=${maxLon}&extended=1`;

        // Use a cached token when available; refresh in the background without blocking.
        const headers = {};
        if (accessToken && Date.now() < tokenExpiry) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        } else if (OPENSKY_CLIENT_ID && OPENSKY_CLIENT_SECRET) {
            getOpenSkyToken().catch(() => null);
        }

        // Query OpenSky and adsb.lol in parallel — adsb.lol is reachable from Cloudflare edge.
        return await Promise.any([
            fetchFromOpenSky(apiUrl, headers),
            fetchFromAdsbLol(minLat, maxLat, minLon, maxLon),
        ]);
    } catch (error) {
        console.error('All live flight sources failed, using demo data:', error.message || error);
        return await getFallbackFlightData(minLat, maxLat, minLon, maxLon);
    }
};

const fetchFromOpenSky = async (apiUrl, headers) => {
    let response = await fetchOpenSkyWithRetry(apiUrl, headers);

    if (!response.ok) {
        if (response.status === 401) {
            accessToken = null;
            tokenExpiry = 0;
            const newToken = await getOpenSkyToken();
            if (newToken) {
                response = await fetchOpenSkyWithRetry(apiUrl, {
                    Authorization: `Bearer ${newToken}`,
                }, 0);
            }
        }
        if (!response.ok) {
            throw new Error(`OpenSky upstream status: ${response.status}`);
        }
    }

    const data = await response.json();
    return processFlightData(data);
};

const fetchFromAdsbLol = async (minLat, maxLat, minLon, maxLon) => {
    const { centerLat, centerLon, radiusNm } = flightUtils.bboxCenterAndRadiusNm(
        minLat, maxLat, minLon, maxLon
    );
    const url = `https://api.adsb.lol/v2/lat/${centerLat.toFixed(4)}/lon/${centerLon.toFixed(4)}/dist/${radiusNm}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), ADSB_LOL_FETCH_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'global-flight-tracker-api/1.0',
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
    } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
    }

    if (!response.ok) {
        throw new Error(`adsb.lol upstream status: ${response.status}`);
    }

    const payload = await response.json();
    const data = flightUtils.buildAdsbLolResponse(payload.ac || [], minLat, maxLat, minLon, maxLon);
    data._meta.authUsed = !!accessToken;

    console.log(`adsb.lol returned ${data.flights.length} flights for bbox.`);

    return new Response(JSON.stringify(data), { status: 200, headers: jsonCorsHeaders });
};

// Function to generate fallback flight data when all live sources fail
const getFallbackFlightData = async (minLat, maxLat, minLon, maxLon) => {
    console.log('All live sources failed, using enhanced sample data fallback...');
    const fallbackData = flightUtils.generateFallbackFlights(minLat, maxLat, minLon, maxLon);
    return new Response(
        JSON.stringify(fallbackData),
        { status: 200, headers: jsonCorsHeaders }
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
                authUsed: !!accessToken,
                serverTimestamp: Date.now(),
            },
            timestamp: Date.now(),
        }),
        {
            status: 200,
            headers: jsonCorsHeaders,
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

const getAuthHeaders = async () => {
    if (!accessToken || Date.now() >= tokenExpiry) {
        await getOpenSkyToken();
    }
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
};

const fetchOpenSkyJson = async (url, headers, timeoutMs) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'global-flight-tracker-api/1.0',
                ...headers,
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            const err = new Error(`HTTP ${response.status}`);
            err.status = response.status;
            throw err;
        }
        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.status) throw error;
        const err = new Error(error.message || 'fetch_failed');
        throw err;
    }
};

const openSkyClient = { getAuthHeaders, fetchJson: fetchOpenSkyJson };

// Function to fetch flight info (departure/arrival airports)
const fetchFlightInfo = async (icao24) => {
    const icao = openskyApi.normalizeIcao24(icao24);
    if (!icao) return null;

    const cacheKey = `info_${icao}`;
    const cached = flightInfoCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 86400000) {
        return cached.data;
    }

    const info = await openskyApi.fetchOpenSkyFlightInfo(icao, openSkyClient);

    flightInfoCache.set(cacheKey, { data: info, timestamp: Date.now() });
    if (flightInfoCache.size > 1000) {
        flightInfoCache.delete(flightInfoCache.keys().next().value);
    }

    return info;
};

// Function to fetch flight track/trajectory
const fetchFlightTrack = async (icao24) => {
    const icao = openskyApi.normalizeIcao24(icao24);
    if (!icao) return openskyApi.emptyTrackResponse(icao24);

    const cacheKey = `track_${icao}`;
    const cached = flightTrackCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3600000) {
        return cached.data;
    }

    const { track } = await openskyApi.fetchOpenSkyTrack(icao, openSkyClient);

    flightTrackCache.set(cacheKey, { data: track, timestamp: Date.now() });
    if (flightTrackCache.size > 500) {
        flightTrackCache.delete(flightTrackCache.keys().next().value);
    }

    return track;
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
    if (url.pathname === '/api/diagnostics' && request.method === 'GET') {
        const results = { timestamp: Date.now(), authConfigured: !!(OPENSKY_CLIENT_ID && OPENSKY_CLIENT_SECRET) };

        const probe = async (label, url, init = {}) => {
            const started = Date.now();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort('timeout'), 8_000);
            try {
                const response = await fetch(url, { ...init, signal: controller.signal });
                clearTimeout(timeoutId);
                results[label] = { ok: response.ok, status: response.status, ms: Date.now() - started };
            } catch (error) {
                clearTimeout(timeoutId);
                results[label] = { error: error.message || String(error), ms: Date.now() - started };
            }
        };

        await probe('openskyPublic', 'https://opensky-network.org/api/states/all?lamin=45&lomin=5&lamax=55&lomax=15');
        await probe('adsbLol', 'https://api.adsb.lol/v2/lat/51/lon/10/dist/250');
        if (OPENSKY_CLIENT_ID && OPENSKY_CLIENT_SECRET) {
            const params = new URLSearchParams();
            params.append('grant_type', 'client_credentials');
            params.append('client_id', OPENSKY_CLIENT_ID);
            params.append('client_secret', OPENSKY_CLIENT_SECRET);
            await probe('openskyAuth', 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params,
            });
        }

        return new Response(JSON.stringify(results), { status: 200, headers: jsonCorsHeaders });
    }

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
            JSON.stringify(flightInfo),
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
            JSON.stringify(track),
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
                status: 'ok',
                authConfigured: !!(OPENSKY_CLIENT_ID && OPENSKY_CLIENT_SECRET),
                endpoints: {
                    '/api/flights': 'GET - Fetch real-time flight data',
                    '/api/flight-info': 'GET - Fetch flight info (departure/arrival)',
                    '/api/flight-track': 'GET - Fetch flight trajectory'
                }
            }),
            {
                status: 200,
                headers: jsonCorsHeaders,
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
