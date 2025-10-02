import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import FlightMap from './components/FlightMap';
import './App.css';

const App = () => {
    const [flights, setFlights] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastFetch, setLastFetch] = useState(null);
    const abortControllerRef = useRef(null);
    const [lastBounds, setLastBounds] = useState(null);
    const [tooWide, setTooWide] = useState(false);
    const [retryCount, setRetryCount] = useState(0);
    const [isRetrying, setIsRetrying] = useState(false);
    const [validFlightCount, setValidFlightCount] = useState(0); // Track rendered flights
    const [searchQuery, setSearchQuery] = useState(''); // Search input
    const [selectedAircraft, setSelectedAircraft] = useState(null); // Selected aircraft to follow

    // Callback to receive valid flight count from FlightMap
    const handleValidFlightCountChange = useCallback((count) => {
        setValidFlightCount(count);
    }, []);

    // Handle search for specific aircraft
    const handleSearch = useCallback((e) => {
        e.preventDefault();
        const query = searchQuery.trim().toUpperCase();
        if (!query) {
            setSelectedAircraft(null);
            return;
        }
        
        // Find matching flight
        const matching = flights.find(f => 
            f.icao24?.toUpperCase() === query || 
            f.callsign?.trim().toUpperCase() === query
        );
        
        if (matching) {
            setSelectedAircraft(matching.icao24);
        } else {
            setError(`No flight found for "${query}"`);
            setTimeout(() => setError(null), 3000);
        }
    }, [searchQuery, flights]);

    const fetchFlights = useCallback(async (isRetry = false) => {
        try {
            // Require bounds to satisfy backend bbox requirement
            if (!lastBounds) {
                return;
            }
            
            // Calculate bounding box dimensions
            const width = Math.abs(lastBounds.lon_max - lastBounds.lon_min);
            const height = Math.abs(lastBounds.lat_max - lastBounds.lat_min);
            
            // Check if area is too large (80° matches FlightRadar24 behavior)
            if (width > 80 || height > 80) {
                setTooWide(true);
                setError(null);
                setLoading(false);
                return;
            }
            setTooWide(false);
            
            // Cancel any ongoing request
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }

            // Create new abort controller for this request
            abortControllerRef.current = new AbortController();

            setLoading(true);
            setError(null);
            
            // Use production Cloudflare Workers backend URL
            const apiUrl = import.meta.env.VITE_API_URL || 'https://global-flight-tracker-api.smah0085.workers.dev';
            const { lat_min, lon_min, lat_max, lon_max } = lastBounds;
            const params = `?lat_min=${lat_min}&lon_min=${lon_min}&lat_max=${lat_max}&lon_max=${lon_max}`;
            
            const response = await axios.get(`${apiUrl}/api/flights${params}`, {
                signal: abortControllerRef.current.signal,
                timeout: 10000
            });
            
            if (response.data && response.data.flights) {
                // Filter and process flight data with FlightRadar24-like filtering
                const validFlights = response.data.flights
                    .filter(flight => {
                        // Basic validation
                        if (!flight || !flight.icao24) return false;
                        if (typeof flight.latitude !== 'number' || typeof flight.longitude !== 'number') return false;
                        if (isNaN(flight.latitude) || isNaN(flight.longitude)) return false;
                        
                        // Filter out grounded aircraft (critical for realistic display)
                        if (flight.on_ground === true) return false;
                        
                        // Filter by altitude - only show aircraft above 100 meters (like FlightRadar24)
                        // This removes ground operations, taxiing, and very low altitude flights
                        const altitude = flight.baro_altitude || flight.geo_altitude || 0;
                        if (altitude < 100) return false;
                        
                        // Filter out stale data (position older than 60 seconds)
                        const now = Math.floor(Date.now() / 1000);
                        if (flight.time_position && (now - flight.time_position) > 60) return false;
                        
                        // Filter out stationary or very slow aircraft (< 50 m/s = ~100 knots)
                        // This removes aircraft parked or taxiing slowly
                        if (flight.velocity !== null && flight.velocity < 50) return false;
                        
                        return true;
                    })
                    .map(flight => ({
                        ...flight,
                        // Ensure heading property exists (use true_track as heading)
                        heading: typeof flight.true_track === 'number' ? flight.true_track : 0
                    }));
                
                setFlights(validFlights);
                setError(null);
                setRetryCount(0);
                setLastFetch(new Date().toLocaleTimeString());
                
                // Check if this is fallback data
                if (response.data._fallback) {
                    const source = response.data._source || 'unknown';
                    const message = response.data._message || 'API unavailable. Showing fallback data.';
                    
                                    if (source === 'enhanced_sample') {
                    setError(`Using sample data (OpenSky unavailable)`);
                } else {
                    setError(message);
                }
                } else {
                    // Real data fetched successfully - animate out the error banner
                    const banner = document.querySelector('.error-banner');
                    if (banner) {
                        banner.classList.add('hiding');
                        setTimeout(() => {
                            setError(null);
                        }, 300);
                    } else {
                        setError(null);
                    }
                }
            }
        } catch (err) {
            if (err.name !== 'CanceledError') {
                console.error('Fetch error:', err);
                
                let errorMessage = 'Error fetching flight data. Please retry.';
                let shouldRetry = false;
                
                if (err.response) {
                    const { status, data: responseData } = err.response;
                    
                    switch (status) {
                        case 400:
                            errorMessage = 'Invalid request. Please check your map view.';
                            break;
                        case 413:
                            errorMessage = 'Area too large. Please zoom in.';
                            setTooWide(true);
                            break;
                        case 429:
                            errorMessage = 'Rate limit exceeded. Please wait.';
                            // Don't retry rate limit errors immediately
                            break;
                        case 502:
                            errorMessage = 'Service temporarily unavailable. Retrying...';
                            shouldRetry = true;
                            break;
                        case 500:
                            errorMessage = 'Server error. Retrying...';
                            shouldRetry = true;
                            break;
                        default:
                            if (status >= 500) {
                                errorMessage = 'Server error. Retrying...';
                                shouldRetry = true;
                            }
                    }
                    
                    // Check if the error response has a custom message
                    if (responseData && responseData.message) {
                        errorMessage = responseData.message;
                    }
                } else if (err.code === 'ECONNABORTED') {
                    errorMessage = 'Request timeout. Please retry.';
                    shouldRetry = true;
                } else if (err.message) {
                    errorMessage = err.message;
                }
                
                setError(errorMessage);
                
                // Implement retry logic with exponential backoff
                if (shouldRetry && retryCount < 3 && !isRetry) {
                    const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff: 1s, 2s, 4s
                    setIsRetrying(true);
                    
                    setTimeout(() => {
                        setRetryCount(prev => prev + 1);
                        setIsRetrying(false);
                        fetchFlights(true); // Retry
                    }, delay);
                }
            }
        } finally {
            setLoading(false);
        }
    }, [lastBounds, retryCount, isRetrying]);

    // Subscribe to map bounds updates from FlightMap
    useEffect(() => {
        const handler = (e) => setLastBounds(e.detail);
        window.addEventListener('map-bounds-changed', handler);
        return () => window.removeEventListener('map-bounds-changed', handler);
    }, []);

    // Start fetching only after we have initial bounds; refresh on bounds changes
    useEffect(() => {
        if (!lastBounds) return;
        
        // Reset retry count when bounds change
        setRetryCount(0);
        setError(null);
        
        fetchFlights();
        const interval = setInterval(fetchFlights, 15000); // 15 seconds for smooth updates
        return () => {
            clearInterval(interval);
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [lastBounds, fetchFlights]);

    // Function to close error banner with animation
    const closeErrorBanner = useCallback(() => {
        const banner = document.querySelector('.error-banner');
        if (banner) {
            banner.classList.add('hiding');
            setTimeout(() => {
                setError(null);
            }, 300); // Match animation duration
        } else {
            setError(null);
        }
    }, []);

    // Manual retry function
    const handleRetry = useCallback(() => {
        setRetryCount(0);
        setTooWide(false);
        // Animate out the error banner before retrying
        const banner = document.querySelector('.error-banner');
        if (banner) {
            banner.classList.add('hiding');
            setTimeout(() => {
                setError(null);
                fetchFlights();
            }, 300);
        } else {
            setError(null);
            fetchFlights();
        }
    }, [fetchFlights]);

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
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.location.reload(); } }}
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
                        />
                        <button type="submit" className="search-button">🔍</button>
                        {selectedAircraft && (
                            <button 
                                type="button" 
                                onClick={() => {
                                    setSelectedAircraft(null);
                                    setSearchQuery('');
                                }}
                                className="clear-button"
                                title="Clear search"
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
                {loading && flights.length === 0 && !isRetrying && (
                    <p className="loading-message">Loading flight data...</p>
                )}
                {isRetrying && (
                    <p className="loading-message">Retrying... (Attempt {retryCount + 1}/3)</p>
                )}
                {tooWide && (
                    <p className="error-message">Area too large. Please zoom in to see flights.</p>
                )}
                {error && (
                    <div
                        className="error-banner"
                        aria-live="polite"
                        role="alert"
                        aria-label="Error notification"
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
                            <div className="error-text">
                                {error}
                            </div>
                            {retryCount < 3 && !tooWide && (
                                <button
                                    onClick={handleRetry}
                                    className="retry-button"
                                    disabled={isRetrying}
                                    aria-label="Retry fetching flight data"
                                >
                                    {isRetrying ? (
                                        <>
                                            <span className="spinner"></span>
                                            Retrying...
                                        </>
                                    ) : (
                                        'Retry'
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                )}
                {flights && flights.length >= 0 ? (
                    <FlightMap 
                        flights={flights} 
                        onValidFlightCountChange={handleValidFlightCountChange}
                        selectedAircraft={selectedAircraft}
                    />
                ) : (
                    <div style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        height: '100%',
                        color: '#666',
                        fontSize: '16px'
                    }}>
                        Loading map...
                    </div>
                )}
            </main>
        </div>
    );
};

export default App;
