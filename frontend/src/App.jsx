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
    const [loadingProgress, setLoadingProgress] = useState(null); // Track tile loading progress
    const tileCache = useRef(new Map()); // Cache tiles to avoid repeated requests

    // Callback to receive valid flight count from FlightMap
    const handleValidFlightCountChange = useCallback((count) => {
        setValidFlightCount(count);
    }, []);

    // Helper function to divide large area into tiles
    const createTiles = useCallback((bounds, maxSize = 55) => {
        const { lat_min, lon_min, lat_max, lon_max } = bounds;
        const width = lon_max - lon_min;
        const height = lat_max - lat_min;
        
        // Calculate how many tiles we need
        const tilesX = Math.ceil(width / maxSize);
        const tilesY = Math.ceil(height / maxSize);
        
        const tiles = [];
        const tileWidth = width / tilesX;
        const tileHeight = height / tilesY;
        
        for (let y = 0; y < tilesY; y++) {
            for (let x = 0; x < tilesX; x++) {
                tiles.push({
                    lat_min: lat_min + (y * tileHeight),
                    lat_max: lat_min + ((y + 1) * tileHeight),
                    lon_min: lon_min + (x * tileWidth),
                    lon_max: lon_min + ((x + 1) * tileWidth),
                    index: y * tilesX + x,
                    total: tilesX * tilesY
                });
            }
        }
        
        return tiles;
    }, []);

    // Helper function to fetch a single tile
    const fetchTile = useCallback(async (tile, apiUrl, signal) => {
        // Generate cache key
        const cacheKey = `${Math.round(tile.lat_min)},${Math.round(tile.lon_min)},${Math.round(tile.lat_max)},${Math.round(tile.lon_max)}`;
        
        // Check cache (5 minute TTL for tiles)
        const cached = tileCache.current.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < 300000) { // 5 minutes
            return cached.flights;
        }
        
        const params = `?lat_min=${tile.lat_min}&lon_min=${tile.lon_min}&lat_max=${tile.lat_max}&lon_max=${tile.lon_max}`;
        
        try {
            const response = await axios.get(`${apiUrl}/api/flights${params}`, {
                signal,
                timeout: 15000
            });
            
            if (response.data && response.data.flights) {
                const flights = response.data.flights.filter(flight => 
                    flight && 
                    flight.icao24 && 
                    typeof flight.latitude === 'number' && 
                    typeof flight.longitude === 'number' &&
                    !isNaN(flight.latitude) && 
                    !isNaN(flight.longitude)
                );
                
                // Cache the result
                tileCache.current.set(cacheKey, {
                    flights,
                    timestamp: Date.now()
                });
                
                return flights;
            }
        } catch (err) {
            // Silently fail individual tiles
            console.warn(`Tile ${tile.index + 1} failed:`, err.message);
        }
        
        return [];
    }, []);

    const fetchFlights = useCallback(async (isRetry = false) => {
        try {
            // Require bounds to satisfy backend bbox requirement
            if (!lastBounds) {
                return;
            }
            
            // Calculate bounding box dimensions
            const width = Math.abs(lastBounds.lon_max - lastBounds.lon_min);
            const height = Math.abs(lastBounds.lat_max - lastBounds.lat_min);
            
            // Cancel any ongoing request
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }

            // Create new abort controller for this request
            abortControllerRef.current = new AbortController();

            setLoading(true);
            setError(null);
            setTooWide(false);
            
            // Use production Cloudflare Workers backend URL
            const apiUrl = import.meta.env.VITE_API_URL || 'https://global-flight-tracker-api.smah0085.workers.dev';
            
            // Check if area is too large and needs tile-based loading
            if (width > 60 || height > 60) {
                // Create tiles for the large area
                const tiles = createTiles(lastBounds, 55);
                
                console.log(`Area too large (${width.toFixed(1)}° x ${height.toFixed(1)}°). Loading ${tiles.length} tiles...`);
                
                setLoadingProgress({ current: 0, total: tiles.length });
                
                const allFlights = new Map(); // Use Map to deduplicate by icao24
                let tilesLoaded = 0;
                
                // Load tiles with staggered delays to avoid rate limiting
                for (let i = 0; i < tiles.length; i++) {
                    const tile = tiles[i];
                    
                    // Add delay between requests (200ms = max 5 req/sec, well under limits)
                    if (i > 0) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                    
                    // Check if request was cancelled
                    if (abortControllerRef.current.signal.aborted) {
                        console.log('Tile loading cancelled');
                        setLoadingProgress(null);
                        return;
                    }
                    
                    const tileFlights = await fetchTile(tile, apiUrl, abortControllerRef.current.signal);
                    
                    // Merge flights, deduplicating by icao24
                    tileFlights.forEach(flight => {
                        allFlights.set(flight.icao24, flight);
                    });
                    
                    tilesLoaded++;
                    setLoadingProgress({ current: tilesLoaded, total: tiles.length });
                    
                    // Update display progressively every 2 tiles or on last tile
                    if (tilesLoaded % 2 === 0 || tilesLoaded === tiles.length) {
                        const currentFlights = Array.from(allFlights.values()).map(flight => ({
                            ...flight,
                            heading: typeof flight.true_track === 'number' ? flight.true_track : 0
                        }));
                        
                        setFlights(currentFlights);
                    }
                }
                
                console.log(`Loaded ${allFlights.size} unique flights from ${tilesLoaded} tiles`);
                
                setLoadingProgress(null);
                setError(null);
                setRetryCount(0);
                setLastFetch(new Date().toLocaleTimeString());
                
                return;
            }
            
            // Area is small enough, fetch directly (original logic)
            const { lat_min, lon_min, lat_max, lon_max } = lastBounds;
            const params = `?lat_min=${lat_min}&lon_min=${lon_min}&lat_max=${lat_max}&lon_max=${lon_max}`;
            
            const response = await axios.get(`${apiUrl}/api/flights${params}`, {
                signal: abortControllerRef.current.signal,
                timeout: 12000 // Increased to 12 seconds to match backend timeout
            });
            
            if (response.data && response.data.flights) {
                // Filter and process flight data
                const validFlights = response.data.flights
                    .filter(flight => 
                        flight && 
                        flight.icao24 && 
                        typeof flight.latitude === 'number' && 
                        typeof flight.longitude === 'number' &&
                        !isNaN(flight.latitude) && 
                        !isNaN(flight.longitude)
                    )
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
                setLoadingProgress(null); // Clear progress on error
                
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
        
        // Calculate area size to determine refresh interval
        const width = Math.abs(lastBounds.lon_max - lastBounds.lon_min);
        const height = Math.abs(lastBounds.lat_max - lastBounds.lat_min);
        
        // Use longer refresh interval for large areas to reduce API load
        // Small area (<60°): 15 seconds
        // Medium area (60-120°): 30 seconds
        // Large area (>120°): 60 seconds
        let refreshInterval = 15000;
        if (width > 60 || height > 60) {
            refreshInterval = width > 120 || height > 120 ? 60000 : 30000;
        }
        
        console.log(`Refresh interval set to ${refreshInterval/1000}s for area ${width.toFixed(1)}° x ${height.toFixed(1)}°`);
        
        fetchFlights();
        const interval = setInterval(fetchFlights, refreshInterval);
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
                <h1>Global Real-Time Flight Tracker</h1>
                {lastFetch && (
                    <small style={{ opacity: 0.8, fontSize: '12px' }}>
                        Last updated: {lastFetch} | Flights: {validFlightCount}
                    </small>
                )}
            </header>
            <main className="main-content">
                {loading && flights.length === 0 && !isRetrying && !loadingProgress && (
                    <p className="loading-message">Loading flight data...</p>
                )}
                {loadingProgress && (
                    <div className="loading-progress">
                        <p>Loading flights from {loadingProgress.total} regions...</p>
                        <div className="progress-bar">
                            <div 
                                className="progress-fill" 
                                style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }}
                            ></div>
                        </div>
                        <p className="progress-text">
                            {loadingProgress.current} of {loadingProgress.total} regions loaded
                            {flights.length > 0 && ` • ${validFlightCount} flights visible`}
                        </p>
                    </div>
                )}
                {isRetrying && (
                    <p className="loading-message">Retrying... (Attempt {retryCount + 1}/3)</p>
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
