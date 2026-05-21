require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

// ---------------------------------------------------------------------------
// OpenSky API base URL — single source of truth for this file
// ---------------------------------------------------------------------------
const OPENSKY_BASE = 'https://opensky-network.org/api';

// ---------------------------------------------------------------------------
// Filter constants — keep in sync with frontend/src/config/appConfig.js
// ---------------------------------------------------------------------------
const MIN_ALTITUDE_M    = 100;
const MIN_SPEED_MPS     = 20;       // 20 m/s ≈ 39 knots
const MAX_POSITION_AGE_S = 300;     // 5 minutes — accounts for OpenSky feed latency
const MAX_BBOX_DEGREES  = 80;

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
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 }
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

// ---------------------------------------------------------------------------
// Helpers — coordinate validation and state-vector transformation
// ---------------------------------------------------------------------------

/** 0 is a valid coordinate — use Number.isFinite, not truthy check. */
const isValidCoord = (lon, lat) =>
    Number.isFinite(lon) && Number.isFinite(lat) &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180;

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

/** Transform a raw OpenSky state-vector array into a named object. */
const transformState = (state) => ({
    icao24:          state[0],
    callsign:        state[1] ? state[1].trim() : null,
    origin_country:  state[2],
    time_position:   state[3],
    last_contact:    state[4],
    longitude:       state[5],
    latitude:        state[6],
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
    heading:     state[10] ?? 0,
    altitude_ft: state[7] != null ? Math.round(state[7] * 3.28084) : null,
    speed_kts:   state[9] != null ? Math.round(state[9] * 1.94384) : null,
    speed_mph:   state[9] != null ? Math.round(state[9] * 2.23694) : null,
    aircraft_type: getAircraftType(state[17] ?? 0),
});

// Function to generate fallback flight data when OpenSky is down or rate-limited on localhost
const getFallbackFlightData = (res, minLat, maxLat, minLon, maxLon, errorMsg) => {
    console.log(`[Fallback] OpenSky fetch failed (${errorMsg}), generating sample flight data...`);
    const sampleFlights = [];
    const numFlights = Math.min(25, Math.floor(Math.random() * 35) + 15); // 15-50 flights

    const aircraftTypes = [
        { category: 2, type: 'Light Aircraft', callsigns: ['N1234', 'G-ABCD', 'F-ABCD'] },
        { category: 3, type: 'Small Aircraft', callsigns: ['C-GABC', 'N5678', 'G-EFGH'] },
        { category: 4, type: 'Large Aircraft', callsigns: ['BA123', 'AA456', 'DL789'] },
        { category: 6, type: 'Heavy Aircraft', callsigns: ['LH123', 'AF456', 'EK789'] }
    ];

    const countries = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Netherlands', 'Spain', 'Italy'];

    for (let i = 0; i < numFlights; i++) {
        const lat = minLat + Math.random() * (maxLat - minLat);
        const lon = minLon + Math.random() * (maxLon - minLon);

        const aircraftType = aircraftTypes[Math.floor(Math.random() * aircraftTypes.length)];
        const callsign = aircraftType.callsigns[Math.floor(Math.random() * aircraftType.callsigns.length)] + 
                        Math.floor(Math.random() * 999).toString().padStart(3, '0');

        let altitude;
        if (aircraftType.category === 2) {
            altitude = Math.floor(Math.random() * 3000) + 500;
        } else if (aircraftType.category === 3) {
            altitude = Math.floor(Math.random() * 6000) + 1000;
        } else {
            altitude = Math.floor(Math.random() * 12000) + 8000;
        }

        let speed;
        if (aircraftType.category === 2) {
            speed = Math.floor(Math.random() * 80) + 40;
        } else if (aircraftType.category === 3) {
            speed = Math.floor(Math.random() * 120) + 80;
        } else {
            speed = Math.floor(Math.random() * 200) + 150;
        }

        const heading = Math.floor(Math.random() * 360);
        const verticalRate = Math.floor(Math.random() * 15) - 7;

        sampleFlights.push([
            `SAMPLE${i.toString().padStart(3, '0')}`,
            callsign,
            countries[Math.floor(Math.random() * countries.length)],
            Math.floor(Date.now() / 1000),
            Math.floor(Date.now() / 1000),
            lon,
            lat,
            altitude,
            false, // on_ground = false (airborne only)
            speed,
            heading,
            verticalRate,
            [],
            altitude + Math.floor(Math.random() * 100) - 50,
            Math.floor(Math.random() * 9999).toString().padStart(4, '0'),
            false,
            0,
            aircraftType.category
        ]);
    }

    const rawStates = sampleFlights;
    const rawStateCount = rawStates.length;
    const flights = rawStates.map(transformState);

    return res.json({
        flights,
        _fallback: true,
        _source: 'enhanced_sample',
        _message: `OpenSky API unavailable. Showing enhanced sample data for demonstration.`,
        _meta: {
            rawStateCount,
            validCoordinateCount: rawStateCount,
            filteredCount: flights.length,
            rejections: {
                invalidCoord: 0,
                onGround: 0,
                altitudeTooLow: 0,
                stalePosition: 0,
                speedTooLow: 0,
            },
            bbox: { minLat, minLon, maxLat, maxLon },
            authUsed: false,
            sourceTimestamp: Math.floor(Date.now() / 1000),
            serverTimestamp: Date.now(),
        },
    });
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
        const response = await openSkyRequest(url, 4000); // 4-second timeout
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
    const rawStateCount = rawStates.length;
    const now = Math.floor(Date.now() / 1000);

    let invalidCoordCount   = 0;
    let groundedCount       = 0;
    let altitudeTooLowCount = 0;
    let stalePosCount       = 0;
    let speedTooLowCount    = 0;

    const flights = rawStates
        .map(transformState)
        .filter(flight => {
            if (!isValidCoord(flight.longitude, flight.latitude)) { invalidCoordCount++;   return false; }
            if (flight.on_ground === true)                         { groundedCount++;       return false; }
            const alt = flight.baro_altitude ?? flight.geo_altitude ?? 0;
            if (alt < MIN_ALTITUDE_M)                              { altitudeTooLowCount++; return false; }
            if (flight.time_position != null && (now - flight.time_position) > MAX_POSITION_AGE_S) {
                stalePosCount++; return false;
            }
            if (flight.velocity !== null && flight.velocity < MIN_SPEED_MPS) {
                speedTooLowCount++; return false;
            }
            return true;
        });

    res.json({
        flights,
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
            bbox: { minLat, minLon, maxLat, maxLon },
            authUsed: !!accessToken,
            sourceTimestamp: rawData?.time ?? null,
            serverTimestamp: Date.now(),
        },
    });
});

// ---------------------------------------------------------------------------
// GET /api/flight-track?icao24=<hex>
// Proxies: GET /tracks/all?icao24=<hex>&time=0
//
// Per OpenSky API docs:
//   - time=0 → retrieve the live/current track if the aircraft is airborne
//   - Response: { icao24, startTime, endTime, callsign, path: [[time,lat,lon,alt,track,onGround],...] }
//   - path[n][0] = Unix time, [1] = lat, [2] = lon, [3] = baro_altitude,
//                  [4] = true_track, [5] = on_ground
// ---------------------------------------------------------------------------
app.get('/api/flight-track', async (req, res) => {
    const { icao24 } = req.query;

    if (!icao24 || typeof icao24 !== 'string' || !/^[0-9a-f]{6}$/i.test(icao24.trim())) {
        return res.status(400).json({ message: 'Valid icao24 hex string (6 chars) required.' });
    }

    const icao = icao24.trim().toLowerCase();

    try {
        // time=0 asks for the live/current track per the OpenSky REST API docs
        const url = `${OPENSKY_BASE}/tracks/all?icao24=${icao}&time=0`;
        const response = await openSkyRequest(url, 5000);
        const data = response.data;

        // Normalise: only forward what the frontend needs
        // path entries: [time, lat, lon, baro_altitude, true_track, on_ground]
        const path = Array.isArray(data?.path) ? data.path : [];

        return res.json({
            icao24:    data?.icao24    ?? icao,
            callsign:  data?.callsign  ?? null,
            startTime: data?.startTime ?? null,
            endTime:   data?.endTime   ?? null,
            path,                          // pass through as-is; frontend already knows the index layout
        });

    } catch (error) {
        if (error.response) {
            const { status } = error.response;
            if (status === 401) { accessToken = null; tokenExpiry = 0; }
            if (status === 404) {
                // OpenSky returns 404 when no track exists for this aircraft
                return res.json({ icao24: icao, callsign: null, startTime: null, endTime: null, path: [] });
            }
            if (status === 429) {
                return res.status(429).json({ message: 'Rate limit on track endpoint. Please wait.' });
            }
        }
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            return res.status(504).json({ message: 'Track request timed out.' });
        }
        console.error(`[/api/flight-track] Error for ${icao}:`, error.message);
        // Return empty path rather than 500 — the popup can gracefully handle it
        return res.json({ icao24: icao, callsign: null, startTime: null, endTime: null, path: [] });
    }
});

// ---------------------------------------------------------------------------
// GET /api/flight-info?icao24=<hex>
// Proxies: GET /flights/aircraft?icao24=<hex>&begin=<24h_ago>&end=<now>
//
// Per OpenSky API docs:
//   - Returns array of flight records for the aircraft in the given time window
//   - Each record: { icao24, firstSeen, estDepartureAirport, lastSeen, estArrivalAirport, callsign, ... }
//   - We return the most recent record (last element of array)
// ---------------------------------------------------------------------------
app.get('/api/flight-info', async (req, res) => {
    const { icao24 } = req.query;

    if (!icao24 || typeof icao24 !== 'string' || !/^[0-9a-f]{6}$/i.test(icao24.trim())) {
        return res.status(400).json({ message: 'Valid icao24 hex string (6 chars) required.' });
    }

    const icao = icao24.trim().toLowerCase();
    const now  = Math.floor(Date.now() / 1000);
    const begin = now - 86_400; // 24 hours back

    try {
        const url = `${OPENSKY_BASE}/flights/aircraft?icao24=${icao}&begin=${begin}&end=${now}`;
        const response = await openSkyRequest(url, 5000);
        const flights = response.data;

        if (!Array.isArray(flights) || flights.length === 0) {
            return res.json(null); // no records — frontend handles null gracefully
        }

        // Return the most recent flight record
        return res.json(flights[flights.length - 1]);

    } catch (error) {
        if (error.response) {
            const { status } = error.response;
            if (status === 401) { accessToken = null; tokenExpiry = 0; }
            if (status === 404) return res.json(null);
            if (status === 429) return res.status(429).json({ message: 'Rate limit on flight-info endpoint.' });
        }
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            return res.status(504).json({ message: 'Flight-info request timed out.' });
        }
        console.error(`[/api/flight-info] Error for ${icao}:`, error.message);
        return res.json(null); // return null so popup degrades gracefully
    }
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
