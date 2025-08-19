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

    const fetchFlights = useCallback(async () => {
        // Require bounds to satisfy backend bbox requirement
        if (!lastBounds) return;
        // Cancel any ongoing request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        // Create new abort controller for this request
        abortControllerRef.current = new AbortController();

        try {
            setLoading(true);
            // Use production Cloudflare Workers backend URL
            const apiUrl = import.meta.env.VITE_API_URL || 'https://global-flight-tracker-api.smah0085.workers.dev';
            // Always include current map bounds (required by backend)
            const { lat_min, lon_min, lat_max, lon_max } = lastBounds;
            const params = `?lat_min=${lat_min}&lon_min=${lon_min}&lat_max=${lat_max}&lon_max=${lon_max}`;
            
            const response = await axios.get(`${apiUrl}/api/flights${params}`, {
                signal: abortControllerRef.current.signal,
                timeout: 8000 // 8 second timeout
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
                setLastFetch(new Date().toLocaleTimeString());
            }
        } catch (err) {
            if (err.name !== 'CanceledError') {
                setError('Error fetching flight data. Please try again later.');
                console.error('Fetch error:', err);
            }
        } finally {
            setLoading(false);
        }
    }, [lastBounds]);

    // Subscribe to map bounds updates from FlightMap
    useEffect(() => {
        const handler = (e) => setLastBounds(e.detail);
        window.addEventListener('map-bounds-changed', handler);
        return () => window.removeEventListener('map-bounds-changed', handler);
    }, []);

    // Start fetching only after we have initial bounds; refresh on bounds changes
    useEffect(() => {
        if (!lastBounds) return;
        fetchFlights();
        const interval = setInterval(fetchFlights, 15000);
        return () => {
            clearInterval(interval);
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [lastBounds, fetchFlights]);

    return (
        <div className="App">
            <header className="App-header">
                <h1>Global Real-Time Flight Tracker</h1>
                {lastFetch && (
                    <small style={{ opacity: 0.8, fontSize: '12px' }}>
                        Last updated: {lastFetch} | Flights: {flights.length}
                    </small>
                )}
            </header>
            <main className="main-content">
                {loading && flights.length === 0 && (
                    <p className="loading-message">Loading flight data...</p>
                )}
                {error && <p className="error-message">{error}</p>}
                <FlightMap flights={flights} />
            </main>
        </div>
    );
};

export default App;
