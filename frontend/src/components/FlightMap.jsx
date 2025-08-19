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
    const [selectedFlight, setSelectedFlight] = useState(null);

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

    // Show heading popup for clicked flight
    const showHeadingPopup = useCallback((flight) => {
        setSelectedFlight(flight);
        
        // Create popup content with heading emphasis
        const popupContent = `
            <div class="flight-popup">
                <h3>${flight.callsign || 'Unknown Flight'}</h3>
                <p><strong>ICAO24:</strong> ${flight.icao24}</p>
                <p><strong>Origin:</strong> ${flight.origin_country || 'Unknown'}</p>
                <p><strong>Altitude:</strong> ${flight.baro_altitude ? `${Math.round(flight.baro_altitude)}m` : 'N/A'}</p>
                <p><strong>Speed:</strong> ${flight.velocity ? `${Math.round(flight.velocity * 3.6)} km/h` : 'N/A'}</p>
                <p class="heading-highlight"><strong>Heading:</strong> ${typeof flight.heading === 'number' ? `${Math.round(flight.heading)}°` : 'N/A'}</p>
            </div>
        `;
        
        // Create and show popup
        const popup = new mapboxgl.Popup({ 
            offset: 25,
            closeButton: true,
            closeOnClick: true,
            maxWidth: '250px'
        })
        .setLngLat([flight.longitude, flight.latitude])
        .setHTML(popupContent)
        .addTo(map.current);

        // Clear selected flight when popup is closed
        popup.on('close', () => {
            setSelectedFlight(null);
        });
    }, []);

    // Create airplane marker element
    const createAirplaneMarker = useCallback((flight) => {
        const el = document.createElement('span');
        el.className = 'plane';
        
        // Use airplane emoji with SVG fallback
        el.innerHTML = '✈️';
        
        // Set individual rotation based on flight heading
        const heading = flight.heading || 0;
        // Airplane emoji ✈️ naturally points northeast (45°), so adjust for proper direction
        const adjustedHeading = heading - 45;
        el.style.transform = `rotate(${adjustedHeading}deg)`;
        el.style.transformOrigin = '50% 50%';
        
        // Debug logging for verification
        if (Math.random() < 0.01) {
            console.log(`Flight ${flight.icao24}: heading=${heading}° → adjusted=${adjustedHeading}°`);
        }
        
        // Add click handler for heading popup
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            showHeadingPopup(flight);
        });
        
        // Add tooltip
        el.title = `${flight.callsign || 'Unknown'} - Heading: ${Math.round(heading)}°`;
        
        return el;
    }, [showHeadingPopup]);

    useEffect(() => {
        if (!isMapLoaded || !flights.length) return;

        // Filter valid flights with coordinates
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
            const { icao24, latitude, longitude } = flight;
            const heading = flight.heading || 0;

            if (markers.current[icao24]) {
                // Update existing marker
                const marker = markers.current[icao24];
                marker.setLngLat([longitude, latitude]);
                
                // Update rotation only if heading changed (performance optimization)
                const markerElement = marker.getElement();
                if (markerElement) {
                    // Airplane emoji ✈️ naturally points northeast (45°), so adjust for proper direction
                    const adjustedHeading = heading - 45;
                    const currentTransform = markerElement.style.transform;
                    const newTransform = `rotate(${adjustedHeading}deg)`;
                    
                    // Only update transform if it changed (avoid unnecessary reflows)
                    if (currentTransform !== newTransform) {
                        markerElement.style.transform = newTransform;
                        markerElement.style.transformOrigin = '50% 50%';
                        markerElement.title = `${flight.callsign || 'Unknown'} - Heading: ${Math.round(heading)}°`;
                    }
                }
            } else {
                // Create new marker with airplane element
                const airplaneElement = createAirplaneMarker(flight);
                
                const newMarker = new mapboxgl.Marker(airplaneElement)
                    .setLngLat([longitude, latitude])
                    .addTo(map.current);
                
                markers.current[icao24] = newMarker;
            }
        });
    }, [flights, isMapLoaded, createAirplaneMarker]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;