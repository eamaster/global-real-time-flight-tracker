import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import FlightMap from './components/FlightMap';
import {
    API_URL,
    MAPBOX_TOKEN,
    MAX_BBOX_DEGREES,
    MIN_ALTITUDE_M,
    MIN_SPEED_MPS,
    MAX_POSITION_AGE_SECONDS,
    FETCH_INTERVAL_MS,
} from './config/appConfig';
import './App.css';

// ---------------------------------------------------------------------------
// Status enum for clear, exclusive UI states
// ---------------------------------------------------------------------------
const STATUS = {
    IDLE:           'idle',
    LOADING:        'loading',
    SUCCESS:        'success',
    EMPTY:          'empty',
    TOO_WIDE:       'too_wide',
    API_ERROR:      'api_error',
    MISSING_TOKEN:  'missing_token',
    MISSING_BACKEND:'missing_backend',
};

const App = () => {
    const [flights, setFlights]               = useState([]);
    const [status, setStatus]                 = useState(STATUS.IDLE);
    const [errorMessage, setErrorMessage]     = useState(null);
    const [lastFetch, setLastFetch]           = useState(null);
    const [validFlightCount, setValidFlightCount] = useState(0);
    const [searchQuery, setSearchQuery]       = useState('');
    const [selectedAircraft, setSelectedAircraft] = useState(null);
    const [retryCount, setRetryCount]         = useState(0);
    const [isRetrying, setIsRetrying]         = useState(false);
    // Diagnostic metadata from the last API response
    const [lastMeta, setLastMeta]             = useState(null);

    const abortControllerRef = useRef(null);
    const lastBoundsRef      = useRef(null); // Use ref to avoid stale closure in fetchFlights

    // -------------------------------------------------------------------------
    // Missing Mapbox token — detected immediately on load
    // -------------------------------------------------------------------------
    useEffect(() => {
        if (!MAPBOX_TOKEN) {
            setStatus(STATUS.MISSING_TOKEN);
            setErrorMessage('VITE_MAPBOX_TOKEN is not set. Add it to frontend/.env.local.');
        }
    }, []);

    // -------------------------------------------------------------------------
    // Valid flight count from FlightMap (via useEffect in FlightMap, not useMemo)
    // -------------------------------------------------------------------------
    const handleValidFlightCountChange = useCallback((count) => {
        setValidFlightCount(count);
    }, []);

    // -------------------------------------------------------------------------
    // Bounds change callback — called by FlightMap on load + moveend
    // -------------------------------------------------------------------------
    const handleBoundsChange = useCallback((bounds) => {
        lastBoundsRef.current = bounds;
    }, []);

    // -------------------------------------------------------------------------
    // Search
    // -------------------------------------------------------------------------
    const handleSearch = useCallback((e) => {
        e.preventDefault();
        const query = searchQuery.trim().toUpperCase();
        if (!query) {
            setSelectedAircraft(null);
            return;
        }
        const matching = flights.find(f =>
            f.icao24?.toUpperCase() === query ||
            f.callsign?.trim().toUpperCase() === query
        );
        if (matching) {
            setSelectedAircraft(matching.icao24);
        } else {
            setErrorMessage(`No flight found for "${query}"`);
            setStatus(STATUS.API_ERROR);
            setTimeout(() => {
                setErrorMessage(null);
                setStatus(prev => prev === STATUS.API_ERROR ? STATUS.SUCCESS : prev);
            }, 3000);
        }
    }, [searchQuery, flights]);

    // -------------------------------------------------------------------------
    // Fetch flights
    // -------------------------------------------------------------------------
    const fetchFlights = useCallback(async (isRetry = false) => {
        const bounds = lastBoundsRef.current;
        if (!bounds) return;

        const width  = Math.abs(bounds.lon_max - bounds.lon_min);
        const height = Math.abs(bounds.lat_max - bounds.lat_min);

        if (width > MAX_BBOX_DEGREES || height > MAX_BBOX_DEGREES) {
            setStatus(STATUS.TOO_WIDE);
            setErrorMessage(null);
            return;
        }

        // Cancel any in-flight request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();

        setStatus(STATUS.LOADING);
        setErrorMessage(null);

        try {
            const { lat_min, lon_min, lat_max, lon_max } = bounds;
            const params = `?lat_min=${lat_min}&lon_min=${lon_min}&lat_max=${lat_max}&lon_max=${lon_max}`;
            const url    = `${API_URL}/api/flights${params}`;

            const response = await axios.get(url, {
                signal:  abortControllerRef.current.signal,
                timeout: 15_000,
            });

            const data = response.data;

            if (data?.flights != null) {
                // -----------------------------------------------------------
                // Front-end filter — relaxed, matches server-side constants
                // -----------------------------------------------------------
                const now = Math.floor(Date.now() / 1000);

                const validFlights = data.flights
                    .filter(flight => {
                        if (!flight?.icao24) return false;

                        // Coordinate validity — 0 is valid, use Number.isFinite
                        if (!Number.isFinite(flight.latitude) || !Number.isFinite(flight.longitude)) return false;

                        // Airborne only
                        if (flight.on_ground === true) return false;

                        // Minimum altitude
                        const alt = flight.baro_altitude ?? flight.geo_altitude ?? 0;
                        if (alt < MIN_ALTITUDE_M) return false;

                        // Position freshness — only filter when time_position is populated
                        if (flight.time_position != null && (now - flight.time_position) > MAX_POSITION_AGE_SECONDS) return false;

                        // Minimum speed — only when velocity is explicitly known
                        if (flight.velocity !== null && flight.velocity < MIN_SPEED_MPS) return false;

                        return true;
                    })
                    .map(flight => ({
                        ...flight,
                        heading: typeof flight.true_track === 'number' ? flight.true_track : 0,
                    }));

                setFlights(validFlights);
                setRetryCount(0);
                setLastFetch(new Date().toLocaleTimeString());
                setLastMeta(data._meta || null);

                if (validFlights.length === 0) {
                    // Log diagnostics to console to help debugging
                    if (data._meta) {
                        console.info('[Flight Filter] No flights after filtering:', data._meta);
                    }
                    setStatus(STATUS.EMPTY);
                } else {
                    setStatus(STATUS.SUCCESS);
                    setErrorMessage(null);
                }

                // Surface fallback notice — but never mix fake data with real
                if (data._fallback) {
                    const src = data._source || 'unknown';
                    if (src === 'enhanced_sample') {
                        setErrorMessage('⚠️ Demo data — OpenSky API unavailable. Showing simulated flights only.');
                    } else {
                        setErrorMessage(data._message || 'Showing fallback data.');
                    }
                }
            }
        } catch (err) {
            if (err.name === 'CanceledError' || err.name === 'AbortError') return;

            console.error('[Fetch] Error:', err);

            let msg      = 'Error fetching flight data. Please retry.';
            let newStatus = STATUS.API_ERROR;
            let shouldRetry = false;

            if (err.response) {
                const { status: httpStatus, data: resData } = err.response;
                if (httpStatus === 400)  msg = 'Invalid map bounds. Try panning.';
                else if (httpStatus === 413) { msg = 'Area too large. Zoom in to see flights.'; newStatus = STATUS.TOO_WIDE; }
                else if (httpStatus === 429) msg = 'OpenSky rate limit reached. Please wait 60 seconds.';
                else if (httpStatus === 502 || httpStatus === 503) { msg = 'Backend temporarily unavailable. Retrying…'; shouldRetry = true; }
                else if (httpStatus === 504) { msg = 'OpenSky API timed out. Retrying…'; shouldRetry = true; }
                else if (httpStatus >= 500) { msg = `Server error (${httpStatus}). Retrying…`; shouldRetry = true; }
                if (resData?.message) msg = resData.message;
            } else if (err.code === 'ERR_NETWORK' || err.message?.includes('Network Error')) {
                msg = 'Cannot reach the backend. Is the local server running on port 3001?';
                newStatus = STATUS.MISSING_BACKEND;
            } else if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
                msg = 'Request timed out. Retrying…';
                shouldRetry = true;
            } else if (err.message) {
                msg = err.message;
            }

            setErrorMessage(msg);
            setStatus(newStatus);

            if (shouldRetry && retryCount < 3 && !isRetry) {
                const delay = Math.pow(2, retryCount) * 1000;
                setIsRetrying(true);
                setTimeout(() => {
                    setRetryCount(prev => prev + 1);
                    setIsRetrying(false);
                    fetchFlights(true);
                }, delay);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [retryCount, isRetrying]);

    // -------------------------------------------------------------------------
    // Start fetching when bounds arrive; re-fetch on bounds change; poll
    // -------------------------------------------------------------------------
    useEffect(() => {
        // handleBoundsChange populates lastBoundsRef; we trigger an initial fetch
        // when FlightMap signals the first bounds via a custom event.
        const handleBoundsEvent = (e) => {
            lastBoundsRef.current = e.detail;
            setRetryCount(0);
        };
        window.addEventListener('map-bounds-changed', handleBoundsEvent);
        return () => window.removeEventListener('map-bounds-changed', handleBoundsEvent);
    }, []);

    useEffect(() => {
        // Poll on a fixed interval; bounds check happens inside fetchFlights
        const interval = setInterval(fetchFlights, FETCH_INTERVAL_MS);
        return () => {
            clearInterval(interval);
            abortControllerRef.current?.abort();
        };
    }, [fetchFlights]);

    // When bounds change, trigger an immediate fetch (debounced in FlightMap)
    const triggerFetch = useCallback(() => {
        setRetryCount(0);
        setErrorMessage(null);
        fetchFlights();
    }, [fetchFlights]);

    useEffect(() => {
        const handler = () => triggerFetch();
        window.addEventListener('map-bounds-changed', handler);
        return () => window.removeEventListener('map-bounds-changed', handler);
    }, [triggerFetch]);

    // -------------------------------------------------------------------------
    // Manual retry
    // -------------------------------------------------------------------------
    const handleRetry = useCallback(() => {
        setRetryCount(0);
        setErrorMessage(null);
        fetchFlights();
    }, [fetchFlights]);

    const closeErrorBanner = useCallback(() => {
        setErrorMessage(null);
        if (status === STATUS.API_ERROR) setStatus(STATUS.SUCCESS);
    }, [status]);

    // -------------------------------------------------------------------------
    // Status-derived UI flags
    // -------------------------------------------------------------------------
    const isTooWide      = status === STATUS.TOO_WIDE;
    const isLoading      = status === STATUS.LOADING && flights.length === 0 && !isRetrying;
    const isEmpty        = status === STATUS.EMPTY;
    const hasMissingToken = status === STATUS.MISSING_TOKEN;

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------
    return (
        <div className="App">
            <header className="App-header">
                <div className="header-top">
                    <h1
                        className="app-title-button"
                        onClick={() => window.location.reload()}
                        role="button"
                        tabIndex={0}
                        aria-label="Refresh and return to home"
                        title="Refresh"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                window.location.reload();
                            }
                        }}
                    >
                        Global Real-Time Flight Tracker
                    </h1>
                    <form onSubmit={handleSearch} className="search-form">
                        <input
                            type="text"
                            placeholder="Search flight (e.g., UAL123 or abc123)"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="search-input"
                            aria-label="Search by callsign or ICAO24"
                        />
                        <button type="submit" className="search-button" aria-label="Search">🔍</button>
                        {selectedAircraft && (
                            <button
                                type="button"
                                onClick={() => { setSelectedAircraft(null); setSearchQuery(''); }}
                                className="clear-button"
                                title="Clear search"
                                aria-label="Clear search"
                            >
                                ✕
                            </button>
                        )}
                    </form>
                </div>
                {lastFetch && (
                    <small style={{ opacity: 0.8, fontSize: '12px' }}>
                        Last updated: {lastFetch} | Flights: {validFlightCount}
                        {selectedAircraft && ` | Following: ${selectedAircraft.toUpperCase()}`}
                    </small>
                )}
            </header>

            <main className="main-content">
                {/* Missing Mapbox token */}
                {hasMissingToken && (
                    <div className="status-overlay">
                        <div className="status-box status-error">
                            <span className="status-icon">🔑</span>
                            <div>
                                <strong>Mapbox token missing</strong>
                                <p>Add <code>VITE_MAPBOX_TOKEN=your_token</code> to <code>frontend/.env.local</code> and restart the dev server.</p>
                                <p>Get a free token at <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noreferrer" style={{color:'#7dd3fc'}}>account.mapbox.com</a></p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Loading spinner */}
                {isLoading && (
                    <p className="loading-message">Loading flight data…</p>
                )}

                {/* Retrying */}
                {isRetrying && (
                    <p className="loading-message">Retrying… (Attempt {retryCount}/3)</p>
                )}

                {/* Area too wide */}
                {isTooWide && (
                    <p className="error-message">🔍 Zoom in to load flights — the current area exceeds {MAX_BBOX_DEGREES}°.</p>
                )}

                {/* Zero flights (but API succeeded) */}
                {isEmpty && !isTooWide && (
                    <p className="loading-message" style={{color:'#fbbf24'}}>
                        No flights found in this area.
                        {lastMeta && (
                            <> ({lastMeta.rawStateCount} raw → {lastMeta.filteredCount} after filters)</>
                        )}
                        {' '}Try another region or zoom in/out slightly.
                    </p>
                )}

                {/* Error / backend missing banner */}
                {errorMessage && (
                    <div
                        className="error-banner"
                        aria-live="polite"
                        role="alert"
                    >
                        <div className="error-content">
                            <button
                                className="close-button"
                                onClick={closeErrorBanner}
                                aria-label="Close error message"
                                title="Close"
                            >
                                ×
                            </button>
                            <div className="error-icon">⚠️</div>
                            <div className="error-text">{errorMessage}</div>
                            {status === STATUS.API_ERROR && retryCount < 3 && (
                                <button
                                    onClick={handleRetry}
                                    className="retry-button"
                                    disabled={isRetrying}
                                    aria-label="Retry fetching flight data"
                                >
                                    {isRetrying ? (
                                        <><span className="spinner" />Retrying…</>
                                    ) : (
                                        'Retry'
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                )}

                <FlightMap
                    flights={flights}
                    onValidFlightCountChange={handleValidFlightCountChange}
                    selectedAircraft={selectedAircraft}
                />
            </main>
        </div>
    );
};

export default App;
