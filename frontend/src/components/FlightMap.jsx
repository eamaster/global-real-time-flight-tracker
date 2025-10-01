import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import './FlightMap.css';

// Set the Mapbox access token
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const FlightMap = ({ flights, onValidFlightCountChange }) => {
    const mapContainer = useRef(null);
    const map = useRef(null);
    const [lng, setLng] = useState(10);
    const [lat, setLat] = useState(45);
    const [zoom, setZoom] = useState(2);
    const [isMapLoaded, setIsMapLoaded] = useState(false);
    const [selectedFlight, setSelectedFlight] = useState(null);
    const updateFrame = useRef(null);
    const animationFrame = useRef(null);
    const previousPositions = useRef(new Map()); // Store previous positions for interpolation
    const targetPositions = useRef(new Map()); // Store target positions
    const interpolationStartTime = useRef(null); // When interpolation started
    const INTERPOLATION_DURATION = 15000; // 15 seconds to match update interval

    // Memoize valid flights to avoid recalculating
    const validFlights = useMemo(() => {
        const filtered = flights.filter(flight => 
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
        
        // Notify parent component about valid flight count
        if (onValidFlightCountChange) {
            onValidFlightCountChange(filtered.length);
        }
        
        return filtered;
    }, [flights, onValidFlightCountChange]);

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
            // Dispatch initial bounds so the backend can be queried with a bounding box
            try {
                const b = map.current.getBounds();
                const detail = {
                    lat_min: b.getSouth(),
                    lon_min: b.getWest(),
                    lat_max: b.getNorth(),
                    lon_max: b.getEast()
                };
                window.dispatchEvent(new CustomEvent('map-bounds-changed', { detail }));
            } catch (_) {}

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

        // Throttle move events for better performance and emit bounds for bbox querying
        let moveTimeout;
        map.current.on('move', () => {
            if (moveTimeout) clearTimeout(moveTimeout);
            moveTimeout = setTimeout(() => {
            setLng(map.current.getCenter().lng.toFixed(4));
            setLat(map.current.getCenter().lat.toFixed(4));
            setZoom(map.current.getZoom().toFixed(2));
            try {
                const b = map.current.getBounds();
                const detail = {
                    lat_min: b.getSouth(),
                    lon_min: b.getWest(),
                    lat_max: b.getNorth(),
                    lon_max: b.getEast()
                };
                window.dispatchEvent(new CustomEvent('map-bounds-changed', { detail }));
            } catch (_) {}
            }, 100);
        });

        // Add navigation control
        map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

        // Clean up on unmount
        return () => {
            if (updateFrame.current) {
                cancelAnimationFrame(updateFrame.current);
            }
            if (animationFrame.current) {
                cancelAnimationFrame(animationFrame.current);
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
                <p><strong>Aircraft Type:</strong> ${flight.aircraft_type || 'Unknown'}</p>
                <p><strong>Altitude:</strong> ${flight.altitude_ft ? `${flight.altitude_ft} ft` : (flight.baro_altitude ? `${Math.round(flight.baro_altitude)}m` : 'N/A')}</p>
                <p><strong>Speed:</strong> ${flight.speed_mph ? `${flight.speed_mph} mph` : (flight.velocity ? `${Math.round(flight.velocity * 2.23694)} mph` : 'N/A')}</p>
                <p><strong>Speed (Knots):</strong> ${flight.speed_kts ? `${flight.speed_kts} kts` : (flight.velocity ? `${Math.round(flight.velocity * 1.94384)} kts` : 'N/A')}</p>
                <p class="heading-highlight"><strong>True Course:</strong> ${typeof flight.true_track === 'number' ? `${Math.round(flight.true_track)}°` : 'N/A'}</p>
                <p><strong>Display Rotation:</strong> ${typeof flight.heading === 'number' ? `${Math.round(flight.heading)}°` : 'N/A'}</p>
                <p><strong>Vertical Rate:</strong> ${flight.vertical_rate ? `${Math.round(flight.vertical_rate)} m/s` : 'N/A'}</p>
                <p><strong>On Ground:</strong> ${flight.on_ground ? 'Yes' : 'No'}</p>
                <p><strong>Position Source:</strong> ${getPositionSource(flight.position_source)}</p>
                <p><em>0°=North, 90°=East, 180°=South, 270°=West</em></p>
                </div>
            `;

        const popup = new mapboxgl.Popup({ 
            offset: 25,
            closeButton: true,
            closeOnClick: true,
            maxWidth: '300px'
        })
        .setLngLat([flight.longitude, flight.latitude])
        .setHTML(popupContent)
        .addTo(map.current);

        popup.on('close', () => {
            setSelectedFlight(null);
        });
    }, []);

    // Helper function to get position source description
    const getPositionSource = (source) => {
        const sources = {
            0: 'ADS-B',
            1: 'ASTERIX',
            2: 'MLAT',
            3: 'FLARM'
        };
        return sources[source] || 'Unknown';
    };

    // Smooth interpolation animation loop
    const animateFlights = useCallback(() => {
        if (!isMapLoaded || !map.current || targetPositions.current.size === 0) {
            animationFrame.current = requestAnimationFrame(animateFlights);
            return;
        }

        const now = Date.now();
        const elapsed = now - (interpolationStartTime.current || now);
        const progress = Math.min(elapsed / INTERPOLATION_DURATION, 1);
        
        // Easing function for smooth movement (ease-out)
        const easeProgress = 1 - Math.pow(1 - progress, 2);

        // Interpolate positions for all flights
        const interpolatedFeatures = [];
        targetPositions.current.forEach((target, icao24) => {
            const previous = previousPositions.current.get(icao24);
            
            if (!previous) {
                // No previous position, use target directly
                interpolatedFeatures.push(createFeature(target, target.longitude, target.latitude));
                return;
            }

            // Linear interpolation between previous and target positions
            const lng = previous.longitude + (target.longitude - previous.longitude) * easeProgress;
            const lat = previous.latitude + (target.latitude - previous.latitude) * easeProgress;
            
            // Smooth heading interpolation (handle 360° wraparound)
            let headingDiff = target.heading - previous.heading;
            if (headingDiff > 180) headingDiff -= 360;
            if (headingDiff < -180) headingDiff += 360;
            const heading = previous.heading + headingDiff * easeProgress;

            interpolatedFeatures.push(createFeature({
                ...target,
                heading: heading
            }, lng, lat));
        });

        // Update map with interpolated positions
        if (map.current.getSource('flights')) {
            map.current.getSource('flights').setData({
                type: 'FeatureCollection',
                features: interpolatedFeatures
            });
        }

        // Continue animation
        animationFrame.current = requestAnimationFrame(animateFlights);
    }, [isMapLoaded, INTERPOLATION_DURATION]);

    // Helper function to create GeoJSON feature
    const createFeature = (flight, lng, lat) => {
        // Use true_track for actual course over ground (movement direction)
        const actualHeading = typeof flight.true_track === 'number' ? flight.true_track : 
                            (typeof flight.heading === 'number' ? flight.heading : 0);
        
        // Airplane emoji ✈️ naturally points to the right (East = 90°)
        // To align the nose with true_track direction, subtract 90°
        const adjustedHeading = actualHeading - 90;
        
        return {
            type: 'Feature',
            properties: {
                icao24: flight.icao24,
                callsign: flight.callsign || 'Unknown',
                origin_country: flight.origin_country || 'Unknown',
                baro_altitude: flight.baro_altitude,
                velocity: flight.velocity,
                vertical_rate: flight.vertical_rate,
                on_ground: flight.on_ground,
                position_source: flight.position_source,
                true_track: flight.true_track,
                heading: adjustedHeading,
                timestamp: Date.now()
            },
            geometry: {
                type: 'Point',
                coordinates: [lng, lat]
            }
        };
    };

    // Start animation loop when map loads
    useEffect(() => {
        if (!isMapLoaded) return;

        animationFrame.current = requestAnimationFrame(animateFlights);

        return () => {
            if (animationFrame.current) {
                cancelAnimationFrame(animationFrame.current);
            }
        };
    }, [isMapLoaded, animateFlights]);

    // Update flight data with smooth interpolation
    useEffect(() => {
        if (!isMapLoaded || !map.current || validFlights.length === 0) return;

        // Cancel any pending updates
        if (updateFrame.current) {
            cancelAnimationFrame(updateFrame.current);
        }

        // Update target positions and start new interpolation
        updateFrame.current = requestAnimationFrame(() => {
            // Store current positions as previous positions for next update
            const newPreviousPositions = new Map();
            const newTargetPositions = new Map();

            validFlights.forEach(flight => {
                const icao24 = flight.icao24;
                
                // Get current target as previous (or use current if first time)
                const currentTarget = targetPositions.current.get(icao24);
                if (currentTarget) {
                    newPreviousPositions.set(icao24, currentTarget);
                } else {
                    // First time seeing this flight, no interpolation needed
                    newPreviousPositions.set(icao24, {
                        longitude: flight.longitude,
                        latitude: flight.latitude,
                        heading: typeof flight.true_track === 'number' ? flight.true_track : 0
                    });
                }

                // Set new target position
                newTargetPositions.set(icao24, {
                    ...flight,
                    heading: typeof flight.true_track === 'number' ? flight.true_track : 0
                });
            });

            previousPositions.current = newPreviousPositions;
            targetPositions.current = newTargetPositions;
            interpolationStartTime.current = Date.now();
        });
    }, [validFlights, isMapLoaded]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;