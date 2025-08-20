// Cloudflare Workers version of the flight tracker backend
// This replaces the Express.js server for deployment on Cloudflare

let accessToken = null;
let tokenExpiry = 0;

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
        // Set token expiry to 1 hour from now (with 5 minute buffer)
        tokenExpiry = Date.now() + (data.expires_in * 1000) - (5 * 60 * 1000);
        console.log('Successfully obtained OpenSky access token.');
        return accessToken;

    } catch (error) {
        console.error('Error getting OpenSky token:', error.message);
        accessToken = null;
        tokenExpiry = 0;
        return null;
    }
};

// Function to fetch flight data from OpenSky API with retry logic
const fetchFlightData = async (request) => {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
        try {
            // Try to get a token, but continue without authentication if credentials are missing
            if (!accessToken) {
                const token = await getOpenSkyToken();
                // Continue without token if credentials are not configured (use public API)
                if (!token) {
                    console.log('No OpenSky credentials configured, using public API (rate limited)');
                }
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

            // Validate and clamp bbox to a reasonable size (avoid CPU limit)
            const minLat = Math.max(-90, Math.min(90, parseFloat(lat_min)));
            const maxLat = Math.max(-90, Math.min(90, parseFloat(lat_max)));
            const minLon = Math.max(-180, Math.min(180, parseFloat(lon_min)));
            const maxLon = Math.max(-180, Math.min(180, parseFloat(lon_max)));

            // Reject huge boxes (> 60 x 60 degrees)
            if (!Number.isFinite(minLat) || !Number.isFinite(maxLat) || !Number.isFinite(minLon) || !Number.isFinite(maxLon) ||
                Math.abs(maxLat - minLat) > 60 || Math.abs(maxLon - minLon) > 60) {
                return new Response(
                    JSON.stringify({ 
                        message: 'Bounding box too large. Please zoom in further.',
                        hint: 'Maximum allowed area is 60° x 60° degrees'
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

            let apiUrl = `https://opensky-network.org/api/states/all?lamin=${minLat}&lomin=${minLon}&lamax=${maxLat}&lomax=${maxLon}`;

            // Make request with or without authentication
            const headers = {};
            if (accessToken) {
                headers['Authorization'] = `Bearer ${accessToken}`;
            }

            // Add timeout and small caching to ease pressure
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort('timeout'), 15000); // Increased to 15 seconds
            
            try {
                const response = await fetch(apiUrl, {
                    headers,
                    signal: controller.signal,
                    cf: { 
                        cacheTtl: 10, // Increased cache time
                        cacheEverything: true 
                    }
                });
                clearTimeout(timeout);

                if (!response.ok) {
                    if (response.status === 401) {
                        // Token might be expired, try to get a new one
                        accessToken = null;
                        tokenExpiry = 0;
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
                        return new Response(
                            JSON.stringify({ 
                                message: 'Rate limit exceeded. Please try again later.',
                                retryAfter: response.headers.get('Retry-After') || 60
                            }),
                            { 
                                status: 429,
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Access-Control-Allow-Origin': '*',
                                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization',
                                    'Retry-After': response.headers.get('Retry-After') || '60'
                                }
                            }
                        );
                    } else if (response.status >= 500) {
                        // For upstream errors, try to retry
                        if (retryCount < maxRetries - 1) {
                            retryCount++;
                            console.log(`Upstream error ${response.status}, retrying ${retryCount}/${maxRetries}`);
                            // Wait before retry (exponential backoff)
                            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
                            continue;
                        }
                        
                        return new Response(
                            JSON.stringify({ 
                                message: 'Upstream service temporarily unavailable. Please retry shortly.',
                                retryCount: retryCount + 1
                            }),
                            {
                                status: 502,
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Access-Control-Allow-Origin': '*',
                                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                                    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                                }
                            }
                        );
                    } else {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }
                }

                const data = await response.json();
                return processFlightData(data);

            } catch (fetchError) {
                clearTimeout(timeout);
                if (fetchError.name === 'AbortError') {
                    throw new Error('Request timeout - OpenSky API is taking too long to respond');
                }
                throw fetchError;
            }

        } catch (error) {
            console.error(`Error fetching flight data from OpenSky (attempt ${retryCount + 1}):`, error.message);
            
            // If this is the last retry, return error response
            if (retryCount >= maxRetries - 1) {
                return new Response(
                    JSON.stringify({ 
                        message: 'Failed to fetch flight data after multiple attempts.',
                        error: error.message,
                        retryCount: retryCount + 1
                    }),
                    { 
                        status: 500,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Methods': 'GET, OPTIONS',
                            'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Authorization'
                        }
                    }
                );
            }
            
            // Increment retry count and wait before next attempt
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 1000));
        }
    }
};

// Function to process and structure flight data
const processFlightData = (data) => {
    const flights = data.states ? data.states.map(state => ({
        icao24: state[0],
        callsign: state[1] ? state[1].trim() : null,
        origin_country: state[2],
        time_position: state[3],
        last_contact: state[4],
        longitude: state[5],
        latitude: state[6],
        baro_altitude: state[7],
        on_ground: state[8],
        velocity: state[9],
        true_track: state[10], // heading
        vertical_rate: state[11],
        sensors: state[12],
        geo_altitude: state[13],
        squawk: state[14],
        spi: state[15],
        position_source: state[16],
    })).filter(flight => flight.latitude && flight.longitude) : []; // Filter out flights with no coordinates

    return new Response(
        JSON.stringify({ flights }),
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
    
    // Handle root path with basic info
    if (url.pathname === '/') {
        return new Response(
            JSON.stringify({ 
                message: 'Global Real-Time Flight Tracker API',
                endpoints: {
                    '/api/flights': 'GET - Fetch real-time flight data'
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
