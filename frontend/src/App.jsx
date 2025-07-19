import React, { useState, useEffect } from 'react';
import axios from 'axios';
import FlightMap from './components/FlightMap';
import './App.css';

const App = () => {
    const [flights, setFlights] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetchFlights = async () => {
        try {
            setLoading(true);
            // Use production Cloudflare Workers backend URL
            const apiUrl = import.meta.env.VITE_API_URL || 'https://global-flight-tracker-api.smah0085.workers.dev';
            const response = await axios.get(`${apiUrl}/api/flights`);
            setFlights(response.data.flights);
            setError(null);
        } catch (err) {
            setError('Error fetching flight data. Please try again later.');
            console.error(err);
        }
        setLoading(false);
    };

    useEffect(() => {
        fetchFlights();
        const interval = setInterval(fetchFlights, 10000); // Poll every 10 seconds

        return () => clearInterval(interval); // Cleanup on unmount
    }, []);

    return (
        <div className="App">
            <header className="App-header">
                <h1>Global Real-Time Flight Tracker</h1>
            </header>
            <main className="main-content">
                {loading && <p className="loading-message">Loading flight data...</p>}
                {error && <p className="error-message">{error}</p>}
                <FlightMap flights={flights} />
            </main>
        </div>
    );
};

export default App;
