import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
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
    const [isMapLoaded, setIsMapLoaded] = useState(false);
    const [selectedFlight, setSelectedFlight] = useState(null);
    const updateFrame = useRef(null);

    // Memoize valid flights to avoid recalculating
    const validFlights = useMemo(() => {
        return flights.filter(flight => 
            flight && 
            flight.icao24 && 
            typeof flight.latitude === 'number' && 
            typeof flight.longitude === 'number' &&
            !isNaN(flight.latitude) && 
            !isNaN(flight.longitude) &&
            Math.abs(flight.latitude) <= 90 &&
            Math.abs(flight.longitude) <= 180 &&
            typeof flight.heading === 'number'
        );
    }, [flights]);

    useEffect(() => {
        if (map.current) return; // initialize map only once

        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [lng, lat],
            zoom: zoom,
            // Performance optimizations for large datasets
            antialias: false,
            preserveDrawingBuffer: false,
            renderWorldCopies: false,
            maxZoom: 12,
            minZoom: 1
        });

        map.current.on('load', () => {
            // Add airplane icon to the map style
            map.current.loadImage('/global-real-time-flight-tracker/airplane-icon.svg', (error, image) => {
                if (error) {
                    // If image fails, we'll use text-based approach
                    console.log('Airplane icon not found, using emoji approach');
                }
                if (image) map.current.addImage('airplane', image);
            });

            // Add source for flight data
            map.current.addSource('flights', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Add layer for airplane symbols with rotation
            map.current.addLayer({
                id: 'flight-markers',
                type: 'symbol',
                source: 'flights',
                layout: {
                    'icon-image': 'airplane',
                    'icon-size': 0.8,
                    'icon-rotate': ['get', 'heading'],
                    'icon-rotation-alignment': 'map',
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': true,
                    // Fallback to text if icon not available
                    'text-field': '✈️',
                    'text-size': 16,
                    'text-rotate': ['get', 'heading'],
                    'text-rotation-alignment': 'map',
                    'text-allow-overlap': true,
                    'text-ignore-placement': true
                },
                paint: {
                    'text-color': '#4A90E2',
                    'text-halo-width': 0 // No halo
                }
            });

            // Add click handler for flight details
            map.current.on('click', 'flight-markers', (e) => {
                const flight = e.features[0].properties;
                showHeadingPopup({
                    ...flight,
                    latitude: e.features[0].geometry.coordinates[1],
                    longitude: e.features[0].geometry.coordinates[0]
                });
            });

            // Change cursor on hover
            map.current.on('mouseenter', 'flight-markers', () => {
                map.current.getCanvas().style.cursor = 'pointer';
            });

            map.current.on('mouseleave', 'flight-markers', () => {
                map.current.getCanvas().style.cursor = '';
            });

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

        // Add navigation control
        map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

        // Clean up on unmount
        return () => {
            if (updateFrame.current) {
                cancelAnimationFrame(updateFrame.current);
            }
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, []);

    // Show heading popup for clicked flight
    const showHeadingPopup = useCallback((flight) => {
        setSelectedFlight(flight);
        
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
        
        const popup = new mapboxgl.Popup({ 
            offset: 25,
            closeButton: true,
            closeOnClick: true,
            maxWidth: '250px'
        })
        .setLngLat([flight.longitude, flight.latitude])
        .setHTML(popupContent)
        .addTo(map.current);

        popup.on('close', () => {
            setSelectedFlight(null);
        });
    }, []);

    // Update flight data with optimized batching
    useEffect(() => {
        if (!isMapLoaded || !map.current) return;

        // Cancel any pending updates
        if (updateFrame.current) {
            cancelAnimationFrame(updateFrame.current);
        }

        // Batch updates using requestAnimationFrame for smooth performance
        updateFrame.current = requestAnimationFrame(() => {
            // Convert flights to GeoJSON features with heading data
            const features = validFlights.map(flight => ({
                type: 'Feature',
                properties: {
                    icao24: flight.icao24,
                    callsign: flight.callsign || 'Unknown',
                    origin_country: flight.origin_country || 'Unknown',
                    baro_altitude: flight.baro_altitude,
                    velocity: flight.velocity,
                    heading: flight.heading - 45 // Adjust for airplane emoji orientation
                },
                geometry: {
                    type: 'Point',
                    coordinates: [flight.longitude, flight.latitude]
                }
            }));

            // Update the source data
            if (map.current.getSource('flights')) {
                map.current.getSource('flights').setData({
                    type: 'FeatureCollection',
                    features: features
                });
            }
        });
    }, [validFlights, isMapLoaded]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;