import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import {
    MAPBOX_TOKEN,
    API_URL,
    DEFAULT_CENTER,
    DEFAULT_ZOOM,
    BOUNDS_DEBOUNCE_MS,
} from '../config/appConfig';
import {
    trackPathToCoordinates,
    hasDrawableTrail,
    getTrailStatusMessage,
    trailStatusClass,
} from '../utils/trackUtils';
import './FlightMap.css';

// Set the Mapbox access token from centralised config
mapboxgl.accessToken = MAPBOX_TOKEN;

const FlightMap = ({ flights, onValidFlightCountChange, selectedAircraft }) => {
    const mapContainer = useRef(null);
    const map = useRef(null);
    const [lng, setLng] = useState(DEFAULT_CENTER.lng);
    const [lat, setLat] = useState(DEFAULT_CENTER.lat);
    const [zoom, setZoom] = useState(DEFAULT_ZOOM);
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
    const liveTrailCoordinates = useRef([]); // Store live trail coordinates for selected flight
    const selectedFlightIcao = useRef(null); // Track which flight is being followed
    const historicalTrailWaypointCount = useRef(0);

    // Memoize valid flights to avoid recalculating
    const validFlights = useMemo(() => {
        return flights.filter(flight =>
            flight &&
            flight.icao24 &&
            typeof flight.latitude  === 'number' &&
            typeof flight.longitude === 'number' &&
            !isNaN(flight.latitude)  &&
            !isNaN(flight.longitude) &&
            Math.abs(flight.latitude)  <= 90  &&
            Math.abs(flight.longitude) <= 180 &&
            typeof flight.heading === 'number'
        );
    }, [flights]);

    // Notify parent of valid flight count via useEffect (NOT inside useMemo —
    // calling a state-setter during render is a React rule violation).
    useEffect(() => {
        if (onValidFlightCountChange) {
            onValidFlightCountChange(validFlights.length);
        }
    }, [validFlights.length, onValidFlightCountChange]);

    useEffect(() => {
        if (map.current) return; // initialize map only once

        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
            zoom: DEFAULT_ZOOM,   // zoom 5 → bbox ~35°×25°, within the 80° limit
            antialias: false,
            preserveDrawingBuffer: false,
            renderWorldCopies: false,
            maxZoom: 12,
            minZoom: 1,
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

        // Emit bounds on moveend (debounced) — much less API chatter than on 'move'
        let boundsDebounceTimer = null;
        const emitBounds = () => {
            if (boundsDebounceTimer) clearTimeout(boundsDebounceTimer);
            boundsDebounceTimer = setTimeout(() => {
                if (!map.current) return;
                try {
                    const b = map.current.getBounds();
                    const detail = {
                        lat_min: b.getSouth(),
                        lon_min: b.getWest(),
                        lat_max: b.getNorth(),
                        lon_max: b.getEast(),
                    };
                    window.dispatchEvent(new CustomEvent('map-bounds-changed', { detail }));
                    setLng(map.current.getCenter().lng.toFixed(4));
                    setLat(map.current.getCenter().lat.toFixed(4));
                    setZoom(map.current.getZoom().toFixed(2));
                } catch (_) {}
            }, BOUNDS_DEBOUNCE_MS);
        };

        map.current.on('moveend', emitBounds);

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

    // Update the trail status line inside an open popup
    const updateTrailStatusInPopup = useCallback(() => {
        if (!currentPopup.current?.isOpen()) return;
        const statusEl = currentPopup.current.getElement()?.querySelector('[data-trail-status]');
        if (!statusEl) return;

        const status = {
            historicalWaypointCount: historicalTrailWaypointCount.current,
            liveWaypointCount: liveTrailCoordinates.current.length,
        };
        statusEl.className = trailStatusClass(status);
        statusEl.textContent = getTrailStatusMessage(status);
    }, []);

    const setFlightTrailOnMap = useCallback((coordinates) => {
        if (!map.current?.getSource('flight-trails') || !hasDrawableTrail(coordinates)) return;
        map.current.getSource('flight-trails').setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates },
            }],
        });
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
        const callsignSafe = (flight.callsign || 'Unknown Flight').replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
        const countrySafe  = (flight.origin_country || 'Unknown').replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));

        let popupContent = `
            <div class="flight-popup">
                <h3>${callsignSafe}</h3>
                <p><strong>ICAO24:</strong> ${flight.icao24}</p>
                <p><strong>Origin:</strong> ${countrySafe}</p>
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
            maxWidth: '350px',
        })
        .setLngLat([flight.longitude, flight.latitude])
        .setHTML(popupContent)
        .addTo(map.current);

        currentPopup.current = popup;

        popup.on('close', () => {
            setSelectedFlight(null);
            selectedFlightIcao.current = null;
            liveTrailCoordinates.current = [];
            historicalTrailWaypointCount.current = 0;
            // Clear flight trail
            if (map.current?.getSource('flight-trails')) {
                map.current.getSource('flight-trails').setData({
                    type: 'FeatureCollection',
                    features: [],
                });
            }
        });

        // Fetch flight info and track in parallel — failures are non-fatal
        try {
            const [flightInfoRes, trackRes] = await Promise.all([
                fetch(`${API_URL}/api/flight-info?icao24=${flight.icao24}`).catch(() => null),
                fetch(`${API_URL}/api/flight-track?icao24=${flight.icao24}`).catch(() => null),
            ]);

            const flightInfo = flightInfoRes?.ok ? await flightInfoRes.json().catch(() => null) : null;
            const track      = trackRes?.ok      ? await trackRes.json().catch(() => null)      : null;
            const trackPath  = Array.isArray(track?.path) ? track.path : [];
            const historicalCoordinates = trackPathToCoordinates(trackPath);
            historicalTrailWaypointCount.current = trackPath.length;

            // Draw historical trail, or seed live trail from current position
            if (hasDrawableTrail(historicalCoordinates)) {
                liveTrailCoordinates.current = [...historicalCoordinates];
                selectedFlightIcao.current = flight.icao24;
                setFlightTrailOnMap(historicalCoordinates);
            } else {
                liveTrailCoordinates.current = [[flight.longitude, flight.latitude]];
                selectedFlightIcao.current = flight.icao24;
            }

            const trailStatus = {
                historicalWaypointCount: historicalTrailWaypointCount.current,
                liveWaypointCount: liveTrailCoordinates.current.length,
            };

            // Update popup with enhanced info
            if (currentPopup.current && currentPopup.current.isOpen()) {
                const enhancedContent = `
                    <div class="flight-popup">
                        <h3>${flight.callsign || 'Unknown Flight'}</h3>
                        <p><strong>ICAO24:</strong> ${flight.icao24}</p>
                        ${flightInfo && flightInfo.estDepartureAirport ? `
                            <p class="route-info"><strong>Route:</strong> ${flightInfo.estDepartureAirport} → ${flightInfo.estArrivalAirport || '?'}</p>
                            <p><strong>Departure:</strong> ${new Date(flightInfo.firstSeen * 1000).toLocaleTimeString()}</p>
                            ${flightInfo.lastSeen ? `<p><strong>Duration:</strong> ${Math.round((flightInfo.lastSeen - flightInfo.firstSeen) / 60)} min</p>` : ''}
                        ` : '<p class="info-note">📍 Real-time position tracking</p>'}
                        <hr style="border-color: rgba(0,0,0,0.1); margin: 8px 0">
                        <p><strong>Origin Country:</strong> ${flight.origin_country || 'Unknown'}</p>
                        ${flight.aircraft_type && flight.aircraft_type !== 'Unknown' && flight.aircraft_type !== 'No information at all' ? 
                            `<p><strong>Category:</strong> ${flight.aircraft_type}</p>` : ''}
                        <p><strong>Altitude:</strong> ${flight.altitude_ft ? `${flight.altitude_ft} ft` : 'N/A'}</p>
                        <p><strong>Speed:</strong> ${flight.speed_kts ? `${flight.speed_kts} kts` : 'N/A'} ${flight.speed_kts ? `(${Math.round(flight.speed_kts * 1.852)} km/h)` : ''}</p>
                        <p><strong>Heading:</strong> ${typeof flight.true_track === 'number' ? `${Math.round(flight.true_track)}° ${getCompassDirection(flight.true_track)}` : 'N/A'}</p>
                        <p><strong>Vertical Rate:</strong> ${flight.vertical_rate ? `${Math.round(flight.vertical_rate)} m/s ${flight.vertical_rate > 0 ? '⬆️ Climbing' : flight.vertical_rate < 0 ? '⬇️ Descending' : '➡️ Level'}` : 'N/A'}</p>
                        <p><strong>Position Source:</strong> ${getPositionSource(flight.position_source)}</p>
                        <p class="${trailStatusClass(trailStatus)}" data-trail-status>${getTrailStatusMessage(trailStatus)}</p>
                    </div>
                `;
                currentPopup.current.setHTML(enhancedContent);
            }
        } catch (error) {
            console.error('Error loading flight info:', error);
        } finally {
            setLoadingFlightInfo(false);
        }
    }, [setFlightTrailOnMap, updateTrailStatusInPopup]);

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

    // Helper function to get compass direction from heading
    const getCompassDirection = (heading) => {
        if (typeof heading !== 'number') return '';
        const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const index = Math.round(((heading % 360) / 22.5)) % 16;
        return `(${directions[index]})`;
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
            
            // Update live trail for selected flight
            if (selectedFlightIcao.current) {
                const selectedFlight = validFlights.find(f => f.icao24 === selectedFlightIcao.current);
                if (selectedFlight) {
                    const newCoord = [selectedFlight.longitude, selectedFlight.latitude];
                    
                    // Only add if position has changed significantly (avoid duplicates)
                    const lastCoord = liveTrailCoordinates.current[liveTrailCoordinates.current.length - 1];
                    if (!lastCoord || 
                        Math.abs(lastCoord[0] - newCoord[0]) > 0.001 || 
                        Math.abs(lastCoord[1] - newCoord[1]) > 0.001) {
                        
                        liveTrailCoordinates.current.push(newCoord);
                        
                        // Keep trail to a reasonable length (last 100 points)
                        if (liveTrailCoordinates.current.length > 100) {
                            liveTrailCoordinates.current = liveTrailCoordinates.current.slice(-100);
                        }
                        
                        // Update the trail on the map and popup status
                        setFlightTrailOnMap(liveTrailCoordinates.current);
                        updateTrailStatusInPopup();
                    }
                }
            }
        });
    }, [validFlights, isMapLoaded, INTERPOLATION_DURATION, setFlightTrailOnMap, updateTrailStatusInPopup]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;