require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

let accessToken = null;

// Function to get OAuth2 token from OpenSky Network
const getOpenSkyToken = async () => {
    const clientId = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('OpenSky client ID or secret not configured.');
        return;
    }

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);

        const response = await axios.post('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        accessToken = response.data.access_token;
        console.log('Successfully obtained OpenSky access token.');

        // Token expires, so we should refresh it periodically.
        // OpenSky tokens seem to last for a while, but for a production app, you'd refresh before it expires.
        // For this example, we'll just get it once on startup.

    } catch (error) {
        console.error('Error getting OpenSky token:', error.response ? error.response.data : error.message);
        accessToken = null;
    }
};

// API endpoint to get flight states
app.get('/api/flights', async (req, res) => {
    if (!accessToken) {
        return res.status(503).json({ message: 'Service unavailable: Could not authenticate with OpenSky API.' });
    }

    try {
        const { lat_min, lon_min, lat_max, lon_max } = req.query;
        let url = 'https://opensky-network.org/api/states/all';

        // Add bounding box parameters if they exist
        if (lat_min && lon_min && lat_max && lon_max) {
            url += `?lamin=${lat_min}&lomin=${lon_min}&lamax=${lat_max}&lomax=${lon_max}`;
        }

        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });

        // Sanitize and structure the data for the frontend
        const flights = response.data.states ? response.data.states.map(state => ({
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

        res.json({ flights });

    } catch (error) {
        console.error('Error fetching flight data from OpenSky:', error.response ? error.response.data : error.message);
        if (error.response && error.response.status === 429) {
            res.status(429).json({ message: 'Rate limit exceeded. Please try again later.' });
        } else {
            res.status(500).json({ message: 'Failed to fetch flight data.' });
        }
    }
});

app.listen(port, async () => {
    console.log(`Backend server running on port ${port}`);
    await getOpenSkyToken();
});
