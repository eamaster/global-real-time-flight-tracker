// Cloudflare Workers version of the flight tracker backend
// This replaces the Express.js server for deployment on Cloudflare

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
    // Ensure we have a valid token
    if (!accessToken) {
        const token = await getOpenSkyToken();
        if (!token) {
            return new Response(
                JSON.stringify({ message: 'Service unavailable: Could not authenticate with OpenSky API.' }),
                { 
                    status: 503,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }
                }
            );
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

        const response = await fetch(apiUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

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
                return new Response(
                    JSON.stringify({ message: 'Rate limit exceeded. Please try again later.' }),
                    { 
                        status: 429,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Allow-Methods': 'GET, OPTIONS',
                            'Access-Control-Allow-Headers': 'Content-Type'
                        }
                    }
                );
            } else {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        }

        const data = await response.json();
        return processFlightData(data);

    } catch (error) {
        console.error('Error fetching flight data from OpenSky:', error.message);
        return new Response(
            JSON.stringify({ message: 'Failed to fetch flight data.' }),
            { 
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            }
        );
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
                'Access-Control-Allow-Headers': 'Content-Type'
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
            'Access-Control-Allow-Headers': 'Content-Type'
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
                    'Access-Control-Allow-Origin': '*'
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
                'Access-Control-Allow-Origin': '*'
            }
        }
    );
}
