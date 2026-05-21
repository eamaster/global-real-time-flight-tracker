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
const MIN_ALTITUDE_M = 100;
const MIN_SPEED_MPS = 20;        // 20 m/s ≈ 39 knots
const MAX_POSITION_AGE_S = 300;  // 5 minutes
const MAX_BBOX_DEGREES = 80;

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

        console.log('Getting OAuth2 token from OpenSky...');
        
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

    // Validate and clamp bbox to a reasonable size (avoid CPU limit)
    const minLat = Math.max(-90, Math.min(90, parseFloat(lat_min)));
    const maxLat = Math.max(-90, Math.min(90, parseFloat(lat_max)));
    const minLon = Math.max(-180, Math.min(180, parseFloat(lon_min)));
    const maxLon = Math.max(-180, Math.min(180, parseFloat(lon_max)));

    // Reject huge boxes — matches FlightRadar24 behaviour
    if (!Number.isFinite(minLat) || !Number.isFinite(maxLat) || !Number.isFinite(minLon) || !Number.isFinite(maxLon) ||
        Math.abs(maxLat - minLat) > MAX_BBOX_DEGREES || Math.abs(maxLon - minLon) > MAX_BBOX_DEGREES) {
        return new Response(
            JSON.stringify({ 
                message: 'Bounding box too large. Please zoom in further.',
                hint: 'Maximum allowed area is 80° x 80° degrees'
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
    const rawStates = data.states ?? [];
    const rawStateCount = rawStates.length;
    const now = Math.floor(Date.now() / 1000);

    let invalidCoordCount   = 0;
    let groundedCount       = 0;
    let altitudeTooLowCount = 0;
    let stalePosCount       = 0;
    let speedTooLowCount    = 0;

    const flights = rawStates
        .filter(state => {
            // --- Coordinate validation ---
            // Use Number.isFinite: longitude=0 and latitude=0 are VALID coordinates.
            // The previous `if (!state[5] || !state[6])` falsy-check was a bug.
            const lon = parseFloat(state[5]);
            const lat = parseFloat(state[6]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
                lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                invalidCoordCount++;
                return false;
            }

            // Airborne only
            if (state[8] === true) {
                groundedCount++;
                return false;
            }

            // Minimum altitude (barometric preferred, fall back to geometric)
            const altitude = state[7] ?? state[13] ?? 0;
            if (altitude < MIN_ALTITUDE_M) {
                altitudeTooLowCount++;
                return false;
            }

            // Position freshness — only check when time_position is populated
            if (state[3] != null && (now - state[3]) > MAX_POSITION_AGE_S) {
                stalePosCount++;
                return false;
            }

            // Minimum speed — only when velocity is explicitly known (null = unknown → keep)
            if (state[9] !== null && state[9] < MIN_SPEED_MPS) {
                speedTooLowCount++;
                return false;
            }

            return true;
        })
        .map(state => ({
            icao24:          state[0],
            callsign:        state[1] ? state[1].trim() : null,
            origin_country:  state[2],
            time_position:   state[3],
            last_contact:    state[4],
            longitude:       parseFloat(state[5]),
            latitude:        parseFloat(state[6]),
            baro_altitude:   state[7],
            on_ground:       state[8],
            velocity:        state[9],
            true_track:      state[10],
            vertical_rate:   state[11],
            sensors:         state[12],
            geo_altitude:    state[13],
            squawk:          state[14],
            spi:             state[15],
            position_source: state[16],
            category:        state[17] ?? 0,
            // Derived / convenience fields
            heading:      state[10] ?? 0,
            altitude_ft:  state[7] != null ? Math.round(state[7] * 3.28084) : null,
            speed_kts:    state[9] != null ? Math.round(state[9] * 1.94384) : null,
            speed_mph:    state[9] != null ? Math.round(state[9] * 2.23694) : null,
            aircraft_type: getAircraftType(state[17] ?? 0),
        }));

    return new Response(
        JSON.stringify({
            flights,
            _fallback: data._fallback || false,
            _source:   data._source   || null,
            _message:  data._message  || null,
            _meta: {
                rawStateCount,
                validCoordinateCount: rawStateCount - invalidCoordCount,
                filteredCount: flights.length,
                rejections: {
                    invalidCoord:   invalidCoordCount,
                    onGround:       groundedCount,
                    altitudeTooLow: altitudeTooLowCount,
                    stalePosition:  stalePosCount,
                    speedTooLow:    speedTooLowCount,
                },
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
