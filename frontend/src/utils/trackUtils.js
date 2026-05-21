/**
 * OpenSky track path helpers for the frontend.
 * Path layout matches backend/lib/openskyApi.js and the OpenSky REST docs.
 * @see https://openskynetwork.github.io/opensky-api/rest.html#track-by-aircraft
 */

/** Minimum coordinate delta (degrees) before appending a new trail point (~5 m). */
export const MIN_TRAIL_SEGMENT_DEGREES = 0.00005;

/** Max stored poll snapshots per aircraft. */
export const MAX_RECORDED_TRAIL_POINTS = 60;

export function normalizeIcao24(icao24) {
    if (icao24 == null || typeof icao24 !== 'string') return null;
    const hex = icao24.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (!hex || hex.length > 6) return null;
    return hex.padStart(6, '0');
}

/** @param {unknown[][]} path OpenSky path: [time, lat, lon, alt, track, onGround] */
export function trackPathToCoordinates(path) {
    return (Array.isArray(path) ? path : [])
        .filter((p) => p != null && Number.isFinite(p[1]) && Number.isFinite(p[2]))
        .map((p) => [p[2], p[1]]);
}

export function hasDrawableTrail(coordinates) {
    return Array.isArray(coordinates) && coordinates.length > 1;
}

/**
 * Append current positions into a per-aircraft history map (mutates the map).
 * @param {Map<string, number[][]>} historyMap
 * @param {Array<{ icao24?: string, longitude?: number, latitude?: number }>} flights
 */
export function recordFlightPositions(historyMap, flights) {
    if (!historyMap || !Array.isArray(flights)) return;

    flights.forEach((flight) => {
        const icao = normalizeIcao24(flight?.icao24);
        if (!icao || !Number.isFinite(flight.longitude) || !Number.isFinite(flight.latitude)) return;

        const point = [flight.longitude, flight.latitude];
        const trail = historyMap.get(icao) ?? [];
        const last = trail[trail.length - 1];

        if (
            last &&
            Math.abs(last[0] - point[0]) < MIN_TRAIL_SEGMENT_DEGREES &&
            Math.abs(last[1] - point[1]) < MIN_TRAIL_SEGMENT_DEGREES
        ) {
            return;
        }

        const next = [...trail, point];
        historyMap.set(icao, next.length > MAX_RECORDED_TRAIL_POINTS ? next.slice(-MAX_RECORDED_TRAIL_POINTS) : next);
    });
}

export function getRecordedTrail(historyMap, icao24) {
    const icao = normalizeIcao24(icao24);
    if (!icao || !historyMap) return [];
    return historyMap.get(icao) ?? [];
}

/** Merge trail coordinate arrays, dropping duplicate consecutive points. */
export function mergeTrailCoordinates(...trails) {
    const merged = [];
    for (const trail of trails) {
        if (!Array.isArray(trail)) continue;
        for (const coord of trail) {
            if (!Array.isArray(coord) || coord.length < 2) continue;
            if (!Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) continue;
            const last = merged[merged.length - 1];
            if (
                last &&
                Math.abs(last[0] - coord[0]) < MIN_TRAIL_SEGMENT_DEGREES &&
                Math.abs(last[1] - coord[1]) < MIN_TRAIL_SEGMENT_DEGREES
            ) {
                continue;
            }
            merged.push([coord[0], coord[1]]);
        }
    }
    return merged;
}

export function getTrailStatusMessage({ historicalWaypointCount = 0, liveWaypointCount = 0, apiWaypointCount = 0 } = {}) {
    const total = liveWaypointCount;
    if (apiWaypointCount > 1) {
        return `✈️ Flight trail shown (${apiWaypointCount} waypoints)`;
    }
    if (total > 1) {
        return `✈️ Live trail (${total} points)`;
    }
    if (total === 1 || apiWaypointCount === 1) {
        return '📡 Live trail — accumulating waypoints…';
    }
    return '📡 Live trail will build as the aircraft moves';
}

export function trailStatusClass({ historicalWaypointCount = 0, liveWaypointCount = 0, apiWaypointCount = 0 } = {}) {
    return (apiWaypointCount > 1 || liveWaypointCount > 1) ? 'success-note' : 'info-note';
}

export function formatAltitude(flight) {
    if (flight?.altitude_ft) return `${flight.altitude_ft} ft`;
    if (Number.isFinite(flight?.baro_altitude)) return `${Math.round(flight.baro_altitude)} m`;
    if (Number.isFinite(flight?.geo_altitude)) return `${Math.round(flight.geo_altitude)} m`;
    return 'N/A';
}

export function formatSpeed(flight) {
    if (flight?.speed_kts) return `${flight.speed_kts} kts`;
    if (Number.isFinite(flight?.velocity)) return `${Math.round(flight.velocity * 1.94384)} kts`;
    return 'N/A';
}

export function formatSpeedKmh(flight) {
    const kts = flight?.speed_kts ?? (Number.isFinite(flight?.velocity) ? flight.velocity * 1.94384 : null);
    return Number.isFinite(kts) ? Math.round(kts * 1.852) : null;
}

export function formatHeading(flight) {
    const track = typeof flight?.true_track === 'number'
        ? flight.true_track
        : (typeof flight?.heading === 'number' ? flight.heading : null);
    return Number.isFinite(track) ? track : null;
}
