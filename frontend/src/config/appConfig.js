/**
 * Central application configuration.
 * All environment-specific values and shared constants live here.
 * Import from this file — never scatter env vars or magic numbers across components.
 */

// ---------------------------------------------------------------------------
// API URL
// ---------------------------------------------------------------------------
// For local development: leave VITE_API_URL empty (or unset) so Vite's proxy
// forwards /api/* to http://localhost:3001.
//
// For production (GitHub Pages + Cloudflare Worker): set VITE_API_URL to the
// full worker URL, e.g. https://global-flight-tracker-api.smah0085.workers.dev
//
// Vite replaces import.meta.env.* at build time, so the bundle is always clean.
export const API_URL = import.meta.env.VITE_API_URL ?? '';

// ---------------------------------------------------------------------------
// Mapbox
// ---------------------------------------------------------------------------
export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Map defaults
// Zoom 5 over central Europe gives a bbox of ~35°×25° — well within the
// 80°×80° limit — so the very first load can immediately fetch real flights.
// Europe also has the highest ADS-B coverage and flight density worldwide.
// ---------------------------------------------------------------------------
export const DEFAULT_CENTER = { lng: 10, lat: 51 }; // Central Europe
export const DEFAULT_ZOOM = 5;

// ---------------------------------------------------------------------------
// Bounding-box limits
// Matches the backend worker limit.  Both front and back validate against this.
// ---------------------------------------------------------------------------
export const MAX_BBOX_DEGREES = 80;

// ---------------------------------------------------------------------------
// Flight filtering constants
// These values must match (or be more permissive than) the backend equivalents
// so we don't double-filter aggressively.
// ---------------------------------------------------------------------------

/** Minimum barometric/geometric altitude in metres to include an aircraft. */
export const MIN_ALTITUDE_M = 100;

/**
 * Minimum ground-speed in m/s to include an aircraft.
 * 20 m/s ≈ 39 knots — catches helicopters, turboprops, slow climb phases.
 * We only apply this when velocity is explicitly known (non-null).
 */
export const MIN_SPEED_MPS = 20;

/**
 * Maximum age of the last known position in seconds.
 * OpenSky data can lag 60–120 s, and some feeds are updated every 5 min.
 * 300 s (5 min) is generous enough to keep real flights visible.
 */
export const MAX_POSITION_AGE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Fetch / polling
// ---------------------------------------------------------------------------

/** Milliseconds between automatic refresh cycles. */
export const FETCH_INTERVAL_MS = 15_000;

/** Minimum milliseconds between bound-change triggered fetches (debounce). */
export const BOUNDS_DEBOUNCE_MS = 600;
