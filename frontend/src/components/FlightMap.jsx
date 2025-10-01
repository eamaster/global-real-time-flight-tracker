import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import './FlightMap.css';

// Set the Mapbox access token
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const FlightMap = ({ flights, onValidFlightCountChange, selectedAircraft }) => {
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
    const currentPopup = useRef(null); // Track current popup
    const [loadingFlightInfo, setLoadingFlightInfo] = useState(false); // Loading state for flight info

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

            // Add source for flight trails
            map.current.addSource('flight-trails', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Add layer for flight trails (behind markers)
            map.current.addLayer({
                id: 'flight-trails',
                type: 'line',
                source: 'flight-trails',
                paint: {
                    'line-color': '#4CAF50',
                    'line-width': 2,
                    'line-opacity': 0.7
                }
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
                    'text-color': ['case',
                        ['==', ['get', 'icao24'], selectedAircraft || ''], 
                        '#FFD700', // Gold for selected
                        '#4A90E2'  // Blue for others
                    ],
                    'text-halo-width': 0, // No halo
                    'text-opacity': 1
                }
            });

            // Add smooth transitions for position changes
            map.current.setPaintProperty('flight-markers', 'text-opacity-transition', {
                duration: 300,
                delay: 0
            });

            // Add click handler for flight details with enhanced info and trails
            map.current.on('click', 'flight-markers', async (e) => {
                const flight = e.features[0].properties;
                const coords = e.features[0].geometry.coordinates;
                await showEnhancedPopup({
                    ...flight,
                    latitude: coords[1],
                    longitude: coords[0]
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
        // Use longer delay (500ms) to prevent excessive API calls during pan/zoom
        let moveTimeout;
        let lastBoundsUpdate = 0;
        const MIN_UPDATE_INTERVAL = 500; // Minimum 500ms between bound updates
        
        map.current.on('move', () => {
            if (moveTimeout) clearTimeout(moveTimeout);
            moveTimeout = setTimeout(() => {
                const now = Date.now();
                // Only update if enough time has passed since last update
                if (now - lastBoundsUpdate < MIN_UPDATE_INTERVAL) {
                    return;
                }
                lastBoundsUpdate = now;
                
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
            }, 500); // Increased from 100ms to 500ms for better throttling
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

    // Enhanced popup with flight info and trail
    const showEnhancedPopup = useCallback(async (flight) => {
        setSelectedFlight(flight);
        setLoadingFlightInfo(true);

        // Close existing popup
        if (currentPopup.current) {
            currentPopup.current.remove();
        }

        // Initial popup with basic info
        let popupContent = `
            <div class="flight-popup">
                <h3>${flight.callsign || 'Unknown Flight'}</h3>
                <p><strong>ICAO24:</strong> ${flight.icao24}</p>
                <p><strong>Origin:</strong> ${flight.origin_country || 'Unknown'}</p>
                <p><strong>Aircraft Type:</strong> ${flight.aircraft_type || 'Unknown'}</p>
                <p><strong>Altitude:</strong> ${flight.altitude_ft ? `${flight.altitude_ft} ft` : (flight.baro_altitude ? `${Math.round(flight.baro_altitude)}m` : 'N/A')}</p>
                <p><strong>Speed:</strong> ${flight.speed_kts ? `${flight.speed_kts} kts` : 'N/A'}</p>
                <p><strong>True Course:</strong> ${typeof flight.true_track === 'number' ? `${Math.round(flight.true_track)}°` : 'N/A'}</p>
                <p class="loading-info">⏳ Loading flight route...</p>
                </div>
            `;

        const popup = new mapboxgl.Popup({ 
            offset: 25,
            closeButton: true,
            closeOnClick: true,
            maxWidth: '350px'
        })
        .setLngLat([flight.longitude, flight.latitude])
        .setHTML(popupContent)
        .addTo(map.current);

        currentPopup.current = popup;

        popup.on('close', () => {
            setSelectedFlight(null);
            // Clear flight trail
            if (map.current.getSource('flight-trails')) {
                map.current.getSource('flight-trails').setData({
                    type: 'FeatureCollection',
                    features: []
                });
            }
        });

        // Fetch flight info and track in parallel
        try {
            const apiUrl = import.meta.env.VITE_API_URL || 'https://global-flight-tracker-api.smah0085.workers.dev';
            
            const [flightInfoRes, trackRes] = await Promise.all([
                fetch(`${apiUrl}/api/flight-info?icao24=${flight.icao24}`).catch(() => null),
                fetch(`${apiUrl}/api/flight-track?icao24=${flight.icao24}`).catch(() => null)
            ]);

            const flightInfo = flightInfoRes ? await flightInfoRes.json() : null;
            const track = trackRes ? await trackRes.json() : null;

            // Draw flight trail if available
            if (track && track.path && track.path.length > 0) {
                const coordinates = track.path
                    .filter(p => p[1] !== null && p[2] !== null)
                    .map(p => [p[2], p[1]]); // [lon, lat]

                if (coordinates.length > 1) {
                    map.current.getSource('flight-trails').setData({
                        type: 'FeatureCollection',
                        features: [{
                            type: 'Feature',
                            geometry: {
                                type: 'LineString',
                                coordinates: coordinates
                            }
                        }]
                    });
                }
            }

            // Update popup with enhanced info
            if (currentPopup.current && currentPopup.current.isOpen()) {
                const enhancedContent = `
                    <div class="flight-popup">
                        <h3>${flight.callsign || 'Unknown Flight'}</h3>
                        <p><strong>ICAO24:</strong> ${flight.icao24}</p>
                        ${flightInfo && flightInfo.estDepartureAirport ? `
                            <p><strong>From:</strong> ${flightInfo.estDepartureAirport}</p>
                            <p><strong>To:</strong> ${flightInfo.estArrivalAirport || 'Unknown'}</p>
                            <p><strong>Departure:</strong> ${new Date(flightInfo.firstSeen * 1000).toLocaleTimeString()}</p>
                            ${flightInfo.lastSeen ? `<p><strong>Duration:</strong> ${Math.round((flightInfo.lastSeen - flightInfo.firstSeen) / 60)} min</p>` : ''}
                        ` : '<p class="info-note">📍 Live position only</p>'}
                        <hr style="border-color: rgba(255,255,255,0.2)">
                        <p><strong>Origin:</strong> ${flight.origin_country || 'Unknown'}</p>
                        <p><strong>Aircraft:</strong> ${flight.aircraft_type || 'Unknown'}</p>
                        <p><strong>Altitude:</strong> ${flight.altitude_ft ? `${flight.altitude_ft} ft` : 'N/A'}</p>
                        <p><strong>Speed:</strong> ${flight.speed_kts ? `${flight.speed_kts} kts` : 'N/A'}</p>
                        <p><strong>Heading:</strong> ${typeof flight.true_track === 'number' ? `${Math.round(flight.true_track)}°` : 'N/A'}</p>
                        <p><strong>Vertical Rate:</strong> ${flight.vertical_rate ? `${Math.round(flight.vertical_rate)} m/s` : 'N/A'}</p>
                        ${track && track.path && track.path.length > 1 ? '<p class="success-note">✈️ Flight trail shown on map</p>' : ''}
                    </div>
                `;
                currentPopup.current.setHTML(enhancedContent);
            }
        } catch (error) {
            console.error('Error loading flight info:', error);
        } finally {
            setLoadingFlightInfo(false);
        }
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
        
        // Linear interpolation (no easing for consistent speed)
        const interpolatedFeatures = [];
        targetPositions.current.forEach((target, icao24) => {
            const previous = previousPositions.current.get(icao24);
            
            if (!previous || progress >= 1.0) {
                // No previous position OR interpolation complete - use target position directly
                interpolatedFeatures.push(createFeature(target, target.longitude, target.latitude));
                return;
            }

            // Linear interpolation between previous and target positions
            const lng = previous.longitude + (target.longitude - previous.longitude) * progress;
            const lat = previous.latitude + (target.latitude - previous.latitude) * progress;
            
            // Smooth heading interpolation (handle 360° wraparound)
            let headingDiff = target.heading - previous.heading;
            if (headingDiff > 180) headingDiff -= 360;
            if (headingDiff < -180) headingDiff += 360;
            const heading = previous.heading + headingDiff * progress;

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

    // Handle selected aircraft - zoom to it
    useEffect(() => {
        if (!isMapLoaded || !map.current || !selectedAircraft) return;

        const aircraft = validFlights.find(f => f.icao24 === selectedAircraft);
        if (aircraft) {
            // Zoom to aircraft
            map.current.flyTo({
                center: [aircraft.longitude, aircraft.latitude],
                zoom: Math.max(map.current.getZoom(), 8), // Zoom in if needed
                duration: 2000
            });

            // Show popup after zoom
            setTimeout(() => {
                showEnhancedPopup(aircraft);
            }, 2000);
        }
    }, [selectedAircraft, isMapLoaded, validFlights, showEnhancedPopup]);

    // Update flight data with smooth interpolation
    useEffect(() => {
        if (!isMapLoaded || !map.current || validFlights.length === 0) return;

        // Cancel any pending updates
        if (updateFrame.current) {
            cancelAnimationFrame(updateFrame.current);
        }

        // Update target positions and start new interpolation
        updateFrame.current = requestAnimationFrame(() => {
            const now = Date.now();
            const elapsed = now - (interpolationStartTime.current || now);
            const currentProgress = Math.min(elapsed / INTERPOLATION_DURATION, 1);
            
            // Store current interpolated positions as previous positions (prevents backward movement)
            const newPreviousPositions = new Map();
            const newTargetPositions = new Map();

            validFlights.forEach(flight => {
                const icao24 = flight.icao24;
                const previousPos = previousPositions.current.get(icao24);
                const currentTarget = targetPositions.current.get(icao24);
                
                if (currentTarget && previousPos && currentProgress < 1.0) {
                    // Calculate current interpolated position (where flight is RIGHT NOW)
                    const currentLng = previousPos.longitude + (currentTarget.longitude - previousPos.longitude) * currentProgress;
                    const currentLat = previousPos.latitude + (currentTarget.latitude - previousPos.latitude) * currentProgress;
                    
                    // Heading interpolation
                    let headingDiff = currentTarget.heading - previousPos.heading;
                    if (headingDiff > 180) headingDiff -= 360;
                    if (headingDiff < -180) headingDiff += 360;
                    const currentHeading = previousPos.heading + headingDiff * currentProgress;
                    
                    // Use CURRENT interpolated position as previous (smooth continuation)
                    newPreviousPositions.set(icao24, {
                        longitude: currentLng,
                        latitude: currentLat,
                        heading: currentHeading
                    });
                } else if (currentTarget) {
                    // Interpolation complete or no previous - use target as previous
                    newPreviousPositions.set(icao24, {
                        longitude: currentTarget.longitude,
                        latitude: currentTarget.latitude,
                        heading: currentTarget.heading || (typeof flight.true_track === 'number' ? flight.true_track : 0)
                    });
                } else {
                    // First time seeing this flight
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
    }, [validFlights, isMapLoaded, INTERPOLATION_DURATION]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;