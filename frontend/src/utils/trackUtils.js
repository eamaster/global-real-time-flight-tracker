/**
 * OpenSky track path helpers for the frontend.
 * Path layout matches backend/lib/openskyApi.js and the OpenSky REST docs.
 * @see https://openskynetwork.github.io/opensky-api/rest.html#track-by-aircraft
 */

/** @param {unknown[][]} path OpenSky path: [time, lat, lon, alt, track, onGround] */
export function trackPathToCoordinates(path) {
    return (Array.isArray(path) ? path : [])
        .filter((p) => p != null && Number.isFinite(p[1]) && Number.isFinite(p[2]))
        .map((p) => [p[2], p[1]]);
}

export function hasDrawableTrail(coordinates) {
    return Array.isArray(coordinates) && coordinates.length > 1;
}

export function getTrailStatusMessage({ historicalWaypointCount = 0, liveWaypointCount = 0 } = {}) {
    if (historicalWaypointCount > 1) {
        return `✈️ Flight trail shown (${historicalWaypointCount} waypoints)`;
    }
    if (liveWaypointCount > 1) {
        return `✈️ Live trail (${liveWaypointCount} points)`;
    }
    if (liveWaypointCount === 1 || historicalWaypointCount === 1) {
        return '📡 Live trail — accumulating waypoints…';
    }
    return '📡 Live trail will build as the aircraft moves';
}

export function trailStatusClass({ historicalWaypointCount = 0, liveWaypointCount = 0 } = {}) {
    return (historicalWaypointCount > 1 || liveWaypointCount > 1) ? 'success-note' : 'info-note';
}
