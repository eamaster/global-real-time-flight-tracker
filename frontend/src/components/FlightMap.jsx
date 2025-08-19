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
            // Create airplane icon programmatically to ensure it loads
            const createAirplaneIcon = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 32;
                canvas.height = 32;
                
                // Draw airplane pointing up (North)
                ctx.fillStyle = '#4A90E2';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                
                // Main body
                ctx.beginPath();
                ctx.moveTo(16, 4);
                ctx.lineTo(18, 10);
                ctx.lineTo(26, 10);
                ctx.lineTo(23, 13);
                ctx.lineTo(19, 13);
                ctx.lineTo(16, 18);
                ctx.lineTo(13, 13);
                ctx.lineTo(9, 13);
                ctx.lineTo(6, 10);
                ctx.lineTo(14, 10);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                
                // Tail
                ctx.beginPath();
                ctx.moveTo(16, 18);
                ctx.lineTo(19, 24);
                ctx.lineTo(22, 24);
                ctx.lineTo(23, 27);
                ctx.lineTo(20, 27);
                ctx.lineTo(16, 28);
                ctx.lineTo(12, 27);
                ctx.lineTo(9, 27);
                ctx.lineTo(10, 24);
                ctx.lineTo(13, 24);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                
                return canvas;
            };
            
            // Add the airplane icon
            try {
                const airplaneCanvas = createAirplaneIcon();
                map.current.addImage('airplane', airplaneCanvas);
                console.log('Airplane icon created successfully');
            } catch (error) {
                console.log('Failed to create airplane icon, using emoji fallback');
            }

            // Add source for flight data with smooth transitions
            map.current.addSource('flights', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                },
                // Enable smooth transitions between position updates
                lineMetrics: true,
                tolerance: 0.375,
                maxzoom: 14
            });

            // Add layer for airplane symbols with rotation
            map.current.addLayer({
                id: 'flight-markers',
                type: 'symbol',
                source: 'flights',
                layout: {
                    // Use emoji text for all markers (reliable cross-platform)
                    'text-field': '✈️',
                    'text-size': 28, // Even larger emoji for better visibility
                    'text-rotate': ['get', 'heading'],
                    'text-rotation-alignment': 'map',
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular']
                },
                paint: {
                    'text-color': '#4A90E2',
                    'text-halo-width': 0, // No halo
                    'text-opacity': 1
                }
            });

            // Add smooth transitions for position changes
            map.current.setPaintProperty('flight-markers', 'text-opacity-transition', {
                duration: 300,
                delay: 0
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

    // Update flight data with optimized batching and smooth interpolation
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
                    heading: flight.heading, // Use direct heading - let Mapbox handle rotation
                    // Add timestamp for interpolation
                    timestamp: Date.now()
                },
                geometry: {
                    type: 'Point',
                    coordinates: [flight.longitude, flight.latitude]
                }
            }));

            // Update the source data with smooth transitions
            if (map.current.getSource('flights')) {
                // Enable smooth position interpolation
                map.current.getSource('flights').setData({
                    type: 'FeatureCollection',
                    features: features
                });
                
                // Add smooth transition properties for position interpolation
                map.current.setPaintProperty('flight-markers', 'text-translate-transition', {
                    duration: 8000, // Match update interval for smooth movement
                    delay: 0
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