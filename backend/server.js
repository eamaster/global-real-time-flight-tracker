require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const flightUtils = require('./lib/flightUtils');
const openskyApi = require('./lib/openskyApi');
const { MAX_BBOX_DEGREES } = flightUtils;

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

const OPENSKY_BASE = openskyApi.OPENSKY_API_BASE;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// OAuth2 token management
// ---------------------------------------------------------------------------
let accessToken = null;
let tokenExpiry = 0; // epoch ms

const getOpenSkyToken = async () => {
    // Return cached token if still valid (with 2-min buffer)
    if (accessToken && Date.now() < tokenExpiry - 120_000) {
        return accessToken;
    }

    const clientId     = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.warn('[Auth] OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set — using anonymous API (rate limited).');
        return null;
    }

    try {
        const params = new URLSearchParams();
        params.append('grant_type',    'client_credentials');
        params.append('client_id',     clientId);
        params.append('client_secret', clientSecret);

        const response = await axios.post(
            'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
            params,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 3000 }
        );

        accessToken = response.data.access_token;
        const expiresIn = response.data.expires_in || 1800;
        tokenExpiry = Date.now() + expiresIn * 1000;
        console.log(`[Auth] OpenSky token obtained, expires in ${expiresIn}s.`);
        return accessToken;

    } catch (error) {
        const msg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('[Auth] Token request failed:', msg);
        accessToken = null;
        tokenExpiry = 0;
        return null;
    }
};

// ---------------------------------------------------------------------------
// Shared helper — build axios request config with optional Bearer token
// ---------------------------------------------------------------------------
const openSkyRequest = async (url, timeoutMs = 4000) => {
    const token = await getOpenSkyToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return axios.get(url, { headers, timeout: timeoutMs });
};

const getAuthHeaders = async () => {
    const token = await getOpenSkyToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
};

const fetchOpenSkyJson = async (url, headers, timeoutMs) => {
    try {
        const response = await axios.get(url, { headers, timeout: timeoutMs });
        return response.data;
    } catch (error) {
        const err = new Error(error.message);
        err.status = error.response?.status;
        throw err;
    }
};

const openSkyClient = { getAuthHeaders, fetchJson: fetchOpenSkyJson };

// ---------------------------------------------------------------------------
// Helpers delegated to flightUtils
// ---------------------------------------------------------------------------

const getFallbackFlightData = (res, minLat, maxLat, minLon, maxLon, errorMsg) => {
    console.log(`[Fallback] OpenSky fetch failed (${errorMsg}), generating sample flight data...`);
    const fallbackData = flightUtils.generateFallbackFlights(minLat, maxLat, minLon, maxLon);
    return res.json(fallbackData);
};


// ---------------------------------------------------------------------------
// Health check — GET /
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
    res.json({
        status:  'ok',
        service: 'Global Real-Time Flight Tracker API',
        endpoints: {
            'GET /api/flights':                      'Real-time flight states (bbox required)',
            'GET /api/flight-track?icao24=<hex>':    'Flight trajectory from OpenSky /tracks/all',
            'GET /api/flight-info?icao24=<hex>':     'Recent flight record from OpenSky /flights/aircraft',
        },
        auth: !!accessToken,
    });
});

// ---------------------------------------------------------------------------
// GET /api/flights  — real-time state vectors for the given bounding box
// ---------------------------------------------------------------------------
app.get('/api/flights', async (req, res) => {
    const { lat_min, lon_min, lat_max, lon_max } = req.query;

    if (!lat_min || !lon_min || !lat_max || !lon_max) {
        return res.status(400).json({
            message: 'Bounding box required. Pass lat_min, lon_min, lat_max, lon_max.',
        });
    }

    const minLat = parseFloat(lat_min);
    const minLon = parseFloat(lon_min);
    const maxLat = parseFloat(lat_max);
    const maxLon = parseFloat(lon_max);

    if (!Number.isFinite(minLat) || !Number.isFinite(minLon) ||
        !Number.isFinite(maxLat) || !Number.isFinite(maxLon)) {
        return res.status(400).json({ message: 'Invalid bbox parameters — must be finite numbers.' });
    }

    const bboxWidth  = Math.abs(maxLon - minLon);
    const bboxHeight = Math.abs(maxLat - minLat);

    if (bboxWidth > MAX_BBOX_DEGREES || bboxHeight > MAX_BBOX_DEGREES) {
        return res.status(413).json({
            message: `Bounding box too large (${bboxWidth.toFixed(1)}°×${bboxHeight.toFixed(1)}°). Maximum is ${MAX_BBOX_DEGREES}°×${MAX_BBOX_DEGREES}°. Please zoom in.`,
            maxAllowed: MAX_BBOX_DEGREES,
        });
    }

    let rawData;
    try {
        const url = `${OPENSKY_BASE}/states/all?lamin=${minLat}&lomin=${minLon}&lamax=${maxLat}&lomax=${maxLon}&extended=1`;
        const response = await openSkyRequest(url, 15_000);
        rawData = response.data;
    } catch (error) {
        console.warn('[/api/flights] OpenSky API failed, falling back to simulated data. Error:', error.message);
        if (error.response && error.response.status === 401) {
            // Clear token cache if unauthorized
            accessToken = null;
            tokenExpiry = 0;
        }
        return getFallbackFlightData(res, minLat, maxLat, minLon, maxLon, error.message);
    }

    const rawStates = rawData?.states ?? [];
    const now = Math.floor(Date.now() / 1000);
    const { flights, stats } = flightUtils.processFlightStates(rawStates, now);

    res.json({
        flights,
        _meta: {
            rawStateCount: rawStates.length,
            validCoordinateCount: rawStates.length - stats.invalidCoord,
            filteredCount: flights.length,
            rejections: stats,
            bbox: { minLat, minLon, maxLat, maxLon },
            authUsed: !!accessToken,
            sourceTimestamp: rawData?.time ?? null,
            serverTimestamp: Date.now(),
        },
    });
});

// GET /api/flight-track — OpenSky /tracks/all (time=0, then firstSeen fallback)
app.get('/api/flight-track', async (req, res) => {
    const { icao24 } = req.query;

    if (!openskyApi.isValidIcao24(icao24)) {
        return res.status(400).json({ message: 'Valid icao24 hex address required.' });
    }

    const { track } = await openskyApi.fetchOpenSkyTrack(icao24, openSkyClient);
    return res.json(track);
});

// GET /api/flight-info — OpenSky /flights/aircraft (most recent record)
app.get('/api/flight-info', async (req, res) => {
    const { icao24 } = req.query;

    if (!openskyApi.isValidIcao24(icao24)) {
        return res.status(400).json({ message: 'Valid icao24 hex address required.' });
    }

    const info = await openskyApi.fetchOpenSkyFlightInfo(icao24, openSkyClient);
    return res.json(info);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
    console.log(`[Server] Flight Tracker backend running on http://localhost:${PORT}`);
    console.log(`[Server] Health:        http://localhost:${PORT}/`);
    console.log(`[Server] Flights API:   http://localhost:${PORT}/api/flights?lat_min=45&lon_min=5&lat_max=55&lon_max=15`);
    console.log(`[Server] Track API:     http://localhost:${PORT}/api/flight-track?icao24=<hex>`);
    console.log(`[Server] Info API:      http://localhost:${PORT}/api/flight-info?icao24=<hex>`);

    await getOpenSkyToken();
});
