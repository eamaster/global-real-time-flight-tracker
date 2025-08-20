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

    const clientId = OPENSKY_CLIENT_ID || 'smah0085-api-client';
    const clientSecret = OPENSKY_CLIENT_SECRET || 'Dlquai3Apg9q4PZKsqBQooW0R1IYtNys';

    if (!clientId || !clientSecret) {
        console.log('No OpenSky credentials configured, using public API (rate limited)');
        return null;
    }

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        console.log('Getting OAuth2 token from OpenSky...');
        console.log('Client ID:', clientId);
        
        const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params
        });

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

            let apiUrl = `https://opensky-network.org/api/states/all?lamin=${minLat}&lomin=${minLon}&lamax=${maxLat}&lomax=${maxLon}&extended=1`;

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
                    } else if (response.status === 503) {
                        // OpenSky API is down - return fallback data
                        console.log('OpenSky API is down (503), returning fallback data');
                        return await getFallbackFlightData(minLat, maxLat, minLon, maxLon);
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
            
            // If this is the last retry, return fallback data instead of error
            if (retryCount >= maxRetries - 1) {
                console.log('All retries failed, returning fallback data');
                const url = new URL(request.url);
                const lat_min = parseFloat(url.searchParams.get('lat_min'));
                const lon_min = parseFloat(url.searchParams.get('lon_min'));
                const lat_max = parseFloat(url.searchParams.get('lat_max'));
                const lon_max = parseFloat(url.searchParams.get('lon_max'));
                
                if (Number.isFinite(lat_min) && Number.isFinite(lon_min) && 
                    Number.isFinite(lat_max) && Number.isFinite(lon_max)) {
                    return await getFallbackFlightData(lat_min, lat_max, lon_min, lon_max);
                }
                
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

// Function to generate fallback flight data when OpenSky is down
const getFallbackFlightData = async (minLat, maxLat, minLon, maxLon) => {
    console.log('OpenSky API is down, using enhanced sample data fallback...');
    
    // Using enhanced sample data as fallback
    return generateSampleFlightData(minLat, maxLat, minLon, maxLon);
};

// Function to generate enhanced sample flight data (final fallback)
const generateSampleFlightData = (minLat, maxLat, minLon, maxLon) => {
    console.log('Generating enhanced sample flight data as final fallback');
    
    // Generate realistic sample flights in the requested area
    const sampleFlights = [];
    const numFlights = Math.min(25, Math.floor(Math.random() * 35) + 15); // 15-50 flights
    
    // Realistic aircraft types and patterns
    const aircraftTypes = [
        { category: 2, type: 'Light Aircraft', callsigns: ['N1234', 'G-ABCD', 'F-ABCD'] },
        { category: 3, type: 'Small Aircraft', callsigns: ['C-GABC', 'N5678', 'G-EFGH'] },
        { category: 4, type: 'Large Aircraft', callsigns: ['BA123', 'AA456', 'DL789'] },
        { category: 6, type: 'Heavy Aircraft', callsigns: ['LH123', 'AF456', 'EK789'] }
    ];
    
    // Realistic countries for the region
    const countries = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Netherlands', 'Spain', 'Italy'];
    
    for (let i = 0; i < numFlights; i++) {
        const lat = minLat + Math.random() * (maxLat - minLat);
        const lon = minLon + Math.random() * (maxLon - minLon);
        
        // Select realistic aircraft type
        const aircraftType = aircraftTypes[Math.floor(Math.random() * aircraftTypes.length)];
        const callsign = aircraftType.callsigns[Math.floor(Math.random() * aircraftType.callsigns.length)] + 
                        Math.floor(Math.random() * 999).toString().padStart(3, '0');
        
        // Realistic altitude based on aircraft type
        let altitude;
        if (aircraftType.category === 2) { // Light aircraft
            altitude = Math.floor(Math.random() * 3000) + 500; // 500-3500m
        } else if (aircraftType.category === 3) { // Small aircraft
            altitude = Math.floor(Math.random() * 6000) + 1000; // 1000-7000m
        } else { // Large/Heavy aircraft
            altitude = Math.floor(Math.random() * 12000) + 8000; // 8000-20000m
        }
        
        // Realistic speed based on aircraft type
        let speed;
        if (aircraftType.category === 2) { // Light aircraft
            speed = Math.floor(Math.random() * 80) + 40; // 40-120 m/s
        } else if (aircraftType.category === 3) { // Small aircraft
            speed = Math.floor(Math.random() * 120) + 80; // 80-200 m/s
        } else { // Large/Heavy aircraft
            speed = Math.floor(Math.random() * 200) + 150; // 150-350 m/s
        }
        
        // Realistic heading (avoid random directions)
        const heading = Math.floor(Math.random() * 360);
        
        // Realistic vertical rate
        const verticalRate = Math.floor(Math.random() * 15) - 7; // -7 to +8 m/s
        
        // Realistic ground status (higher aircraft less likely to be on ground)
        const onGround = aircraftType.category >= 4 ? Math.random() > 0.95 : Math.random() > 0.7;
        
        sampleFlights.push([
            `SAMPLE${i.toString().padStart(3, '0')}`, // icao24
            callsign, // callsign
            countries[Math.floor(Math.random() * countries.length)], // origin_country
            Math.floor(Date.now() / 1000), // time_position
            Math.floor(Date.now() / 1000), // last_contact
            lon, // longitude
            lat, // latitude
            altitude, // baro_altitude
            onGround, // on_ground
            speed, // velocity
            heading, // true_track
            verticalRate, // vertical_rate
            [], // sensors
            altitude + Math.floor(Math.random() * 100) - 50, // geo_altitude (slightly different)
            Math.floor(Math.random() * 9999).toString().padStart(4, '0'), // squawk
            false, // spi
            0, // position_source
            aircraftType.category // category
        ]);
    }
    
    const fallbackData = {
        states: sampleFlights,
        _fallback: true,
        _source: 'enhanced_sample',
        _message: 'OpenSky API unavailable. Showing enhanced sample data for demonstration.'
    };
    
    return processFlightData(fallbackData);
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
        category: state[17] || 0, // Aircraft category (extended field)
        // Add computed fields for better UX
        heading: state[10] || 0, // Alias for true_track
        altitude_ft: state[7] ? Math.round(state[7] * 3.28084) : null, // Convert m to ft
        speed_kts: state[9] ? Math.round(state[9] * 1.94384) : null, // Convert m/s to knots
        speed_mph: state[9] ? Math.round(state[9] * 2.23694) : null, // Convert m/s to mph
        // Aircraft type based on category
        aircraft_type: getAircraftType(state[17] || 0)
    })).filter(flight => flight.latitude && flight.longitude) : []; // Filter out flights with no coordinates

    return new Response(
        JSON.stringify({ 
            flights,
            _fallback: data._fallback || false,
            _message: data._message || null,
            timestamp: Date.now()
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

// Helper function to get aircraft type description
const getAircraftType = (category) => {
    const types = {
        0: 'Unknown',
        1: 'No ADS-B Info',
        2: 'Light (< 15,500 lbs)',
        3: 'Small (15,500 - 75,000 lbs)',
        4: 'Large (75,000 - 300,000 lbs)',
        5: 'High Vortex Large (B-757)',
        6: 'Heavy (> 300,000 lbs)',
        7: 'High Performance (> 5g, 400 kts)',
        8: 'Rotorcraft',
        9: 'Glider/Sailplane',
        10: 'Lighter-than-air',
        11: 'Parachutist/Skydiver',
        12: 'Ultralight/Hang-glider',
        13: 'Reserved',
        14: 'UAV/Drone',
        15: 'Space Vehicle',
        16: 'Emergency Vehicle',
        17: 'Service Vehicle',
        18: 'Point Obstacle',
        19: 'Cluster Obstacle',
        20: 'Line Obstacle'
    };
    return types[category] || 'Unknown';
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
