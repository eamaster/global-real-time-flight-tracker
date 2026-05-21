/**
 * Shared OpenSky REST API helpers.
 * @see https://openskynetwork.github.io/opensky-api/rest.html
 *
 * Track path waypoint layout: [time, latitude, longitude, baro_altitude, true_track, on_ground]
 * Live track: GET /tracks/all?icao24=<hex>&time=0
 * Historical: use firstSeen from GET /flights/aircraft as the time parameter.
 */

const OPENSKY_API_BASE = 'https://opensky-network.org/api';
const LIVE_TRACK_TIME = 0;
const FLIGHT_INFO_WINDOW_S = 86_400;
const OPENSKY_SUBREQUEST_TIMEOUT_MS = 12_000;

const normalizeIcao24 = (icao24) => {
    if (icao24 == null || typeof icao24 !== 'string') return null;
    const hex = icao24.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (!hex || hex.length > 6) return null;
    return hex.padStart(6, '0');
};

const isValidIcao24 = (icao24) => normalizeIcao24(icao24) !== null;

const emptyTrackResponse = (icao24) => ({
    icao24: normalizeIcao24(icao24) || String(icao24 || '').toLowerCase(),
    callsign: null,
    startTime: null,
    endTime: null,
    path: [],
});

const normalizeTrackResponse = (data, icao24) => ({
    icao24: normalizeIcao24(data?.icao24) || normalizeIcao24(icao24),
    callsign: typeof data?.callsign === 'string' ? data.callsign.trim() : (data?.callsign ?? null),
    startTime: data?.startTime ?? null,
    endTime: data?.endTime ?? null,
    path: Array.isArray(data?.path) ? data.path : [],
});

/** Convert OpenSky path arrays to GeoJSON [lon, lat] pairs. */
const trackPathToCoordinates = (path) =>
    (Array.isArray(path) ? path : [])
        .filter((p) => p != null && Number.isFinite(p[1]) && Number.isFinite(p[2]))
        .map((p) => [p[2], p[1]]);

const hasDrawableTrack = (path) => trackPathToCoordinates(path).length > 1;

const buildTrackUrl = (icao24, time = LIVE_TRACK_TIME) =>
    `${OPENSKY_API_BASE}/tracks/all?icao24=${normalizeIcao24(icao24)}&time=${time}`;

const buildAircraftFlightsUrl = (icao24, begin, end) =>
    `${OPENSKY_API_BASE}/flights/aircraft?icao24=${normalizeIcao24(icao24)}&begin=${begin}&end=${end}`;

const pickLatestFlight = (flights) =>
    (Array.isArray(flights) && flights.length > 0 ? flights[flights.length - 1] : null);

async function fetchOpenSkyTrack(icao24, { getAuthHeaders, fetchJson, timeoutMs = OPENSKY_SUBREQUEST_TIMEOUT_MS }) {
    const icao = normalizeIcao24(icao24);
    if (!icao) {
        return { track: emptyTrackResponse(icao24), error: 'invalid_icao24' };
    }

    const headers = (await getAuthHeaders()) || {};

    const tryTrack = async (time) => {
        try {
            const data = await fetchJson(buildTrackUrl(icao, time), headers, timeoutMs);
            return normalizeTrackResponse(data, icao);
        } catch (error) {
            if (error?.status === 404) return emptyTrackResponse(icao);
            throw error;
        }
    };

    try {
        const liveTrack = await tryTrack(LIVE_TRACK_TIME);
        if (hasDrawableTrack(liveTrack.path)) {
            return { track: liveTrack, source: 'opensky_live' };
        }

        const now = Math.floor(Date.now() / 1000);
        let flights;
        try {
            flights = await fetchJson(
                buildAircraftFlightsUrl(icao, now - FLIGHT_INFO_WINDOW_S, now),
                headers,
                timeoutMs
            );
        } catch (error) {
            if (error?.status === 404) flights = [];
            else throw error;
        }

        const latest = pickLatestFlight(flights);
        if (latest?.firstSeen) {
            const historicalTrack = await tryTrack(latest.firstSeen);
            if (hasDrawableTrack(historicalTrack.path)) {
                return { track: historicalTrack, source: 'opensky_flight' };
            }
        }

        if (liveTrack.path.length > 0) {
            return { track: liveTrack, source: 'opensky_live' };
        }

        return { track: emptyTrackResponse(icao), source: null };
    } catch (error) {
        console.error(`[OpenSky track] ${icao}:`, error.message || error);
        return { track: emptyTrackResponse(icao), error: error.message || 'fetch_failed' };
    }
}

async function fetchOpenSkyFlightInfo(icao24, { getAuthHeaders, fetchJson, timeoutMs = OPENSKY_SUBREQUEST_TIMEOUT_MS }) {
    const icao = normalizeIcao24(icao24);
    if (!icao) return null;

    const headers = (await getAuthHeaders()) || {};
    const now = Math.floor(Date.now() / 1000);

    try {
        const flights = await fetchJson(
            buildAircraftFlightsUrl(icao, now - FLIGHT_INFO_WINDOW_S, now),
            headers,
            timeoutMs
        );
        return pickLatestFlight(flights);
    } catch (error) {
        if (error?.status === 404) return null;
        console.error(`[OpenSky flight-info] ${icao}:`, error.message || error);
        return null;
    }
}

module.exports = {
    OPENSKY_API_BASE,
    LIVE_TRACK_TIME,
    FLIGHT_INFO_WINDOW_S,
    OPENSKY_SUBREQUEST_TIMEOUT_MS,
    normalizeIcao24,
    isValidIcao24,
    emptyTrackResponse,
    normalizeTrackResponse,
    trackPathToCoordinates,
    hasDrawableTrack,
    buildTrackUrl,
    buildAircraftFlightsUrl,
    pickLatestFlight,
    fetchOpenSkyTrack,
    fetchOpenSkyFlightInfo,
};
