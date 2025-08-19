import React, { useRef, useEffect, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import './FlightMap.css';

// Set the Mapbox access token
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const FlightMap = ({ flights }) => {
    const mapContainer = useRef(null);
    const map = useRef(null);
    const [lng, setLng] = useState(10);
    const [lat, setLat] = useState(45);
    const [zoom, setZoom] = useState(2);
    const markers = useRef({});
    const [isMapLoaded, setIsMapLoaded] = useState(false);

    useEffect(() => {
        if (map.current) return; // initialize map only once

        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [lng, lat],
            zoom: zoom,
            // Performance optimizations
            antialias: false,
            preserveDrawingBuffer: false,
            renderWorldCopies: false,
            maxZoom: 12,
            minZoom: 1
        });

        map.current.on('load', () => {
            setIsMapLoaded(true);
        });

        // Throttle move events for better performance
        let moveTimeout;
        map.current.on('move', () => {
            if (moveTimeout) clearTimeout(moveTimeout);
            moveTimeout = setTimeout(() => {
                setLng(map.current.getCenter().lng.toFixed(4));
                setLat(map.current.getCenter().lat.toFixed(4));
                setZoom(map.current.getZoom().toFixed(2));
            }, 100);
        });

        // Add navigation control (the +/- zoom buttons)
        map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

        // Clean up on unmount to prevent issues with React.StrictMode
        return () => {
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, []);

    // Airplane rotation calculation
    const calculateRotation = useCallback((trueTrack) => {
        if (typeof trueTrack !== 'number' || isNaN(trueTrack)) {
            return 0; // Default rotation for flights without heading data
        }
        
        // Normalize the angle to be between 0 and 360 degrees
        let angle = trueTrack % 360;
        if (angle < 0) angle += 360;
        
        // Triangle ▲ naturally points up (North = 0°)
        // true_track from OpenSky: 0° = North, 90° = East, 180° = South, 270° = West
        // Since triangle already points North, we can use the angle directly
        
        // Debug logging for a few flights
        if (Math.random() < 0.01) {
            console.log(`Flight heading: ${trueTrack}° → Rotation: ${angle}°`);
        }
        
        return angle;
    }, []);

    // Simple popup creation
    const createPopup = useCallback((flight) => {
        const { callsign, icao24, origin_country, baro_altitude, velocity, true_track } = flight;
        
        const popupContent = `
            <div class="flight-popup">
                <h3>${callsign || 'Unknown'}</h3>
                <p><strong>ICAO24:</strong> ${icao24}</p>
                <p><strong>Origin:</strong> ${origin_country || 'Unknown'}</p>
                <p><strong>Altitude:</strong> ${baro_altitude ? `${Math.round(baro_altitude)}m` : 'N/A'}</p>
                <p><strong>Speed:</strong> ${velocity ? `${Math.round(velocity * 3.6)} km/h` : 'N/A'}</p>
                <p><strong>Heading:</strong> ${typeof true_track === 'number' ? `${Math.round(true_track)}°` : 'N/A'}</p>
            </div>
        `;
        
        return new mapboxgl.Popup({ 
            offset: 25,
            closeButton: true,
            closeOnClick: false,
            maxWidth: '250px'
        }).setHTML(popupContent);
    }, []);

    useEffect(() => {
        if (!isMapLoaded || !flights.length) return;

        // Filter valid flights
        const validFlights = flights.filter(flight => 
            flight && 
            flight.icao24 && 
            typeof flight.latitude === 'number' && 
            typeof flight.longitude === 'number' &&
            !isNaN(flight.latitude) && 
            !isNaN(flight.longitude) &&
            Math.abs(flight.latitude) <= 90 &&
            Math.abs(flight.longitude) <= 180
        );

        const currentMarkerIds = Object.keys(markers.current);
        const newFlightIds = new Set(validFlights.map(f => f.icao24));

        // Remove markers for flights that are no longer present
        currentMarkerIds.forEach(id => {
            if (!newFlightIds.has(id)) {
                if (markers.current[id]) {
                    markers.current[id].remove();
                    delete markers.current[id];
                }
            }
        });

        // Process each flight
        validFlights.forEach(flight => {
            const { icao24, latitude, longitude, true_track } = flight;

            if (markers.current[icao24]) {
                // Update existing marker
                const marker = markers.current[icao24];
                marker.setLngLat([longitude, latitude]);
                
                // Update rotation immediately
                const rotationAngle = calculateRotation(true_track);
                const markerElement = marker.getElement();
                
                if (markerElement) {
                    // Apply rotation
                    markerElement.style.setProperty('transform', `rotate(${rotationAngle}deg)`, 'important');
                    markerElement.style.setProperty('transform-origin', 'center center', 'important');
                    markerElement.style.opacity = typeof true_track === 'number' ? '1' : '0.6';
                    markerElement.title = typeof true_track === 'number' ? 
                        `Heading: ${Math.round(true_track)}° (Rotated: ${Math.round(rotationAngle)}°)` : 
                        'No heading data';
                }
            } else {
                // Create new marker
                const el = document.createElement('div');
                el.className = 'marker';
                // Use a simple directional arrow that clearly shows rotation
                el.innerHTML = '▲';
                
                // Set rotation immediately
                const rotationAngle = calculateRotation(true_track);
                
                // Apply rotation
                el.style.setProperty('transform', `rotate(${rotationAngle}deg)`, 'important');
                el.style.setProperty('transform-origin', 'center center', 'important');
                el.style.opacity = typeof true_track === 'number' ? '1' : '0.6';
                el.title = typeof true_track === 'number' ? 
                    `Heading: ${Math.round(true_track)}° (Rotated: ${Math.round(rotationAngle)}°)` : 
                    'No heading data';

                // Create popup
                const popup = createPopup(flight);

                const newMarker = new mapboxgl.Marker(el)
                    .setLngLat([longitude, latitude])
                    .setPopup(popup)
                    .addTo(map.current);
                
                markers.current[icao24] = newMarker;
            }
        });
    }, [flights, isMapLoaded, calculateRotation, createPopup]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;
