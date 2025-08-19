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
    
    // Animation and interpolation state
    const animationFrame = useRef(null);
    const flightStates = useRef(new Map()); // Store interpolation state for each flight
    const lastUpdateTime = useRef(Date.now());

    // Flight interpolation and animation system
    const FlightAnimator = {
        // Initialize or update flight state for interpolation
        updateFlightState: (flight, currentTime) => {
            const flightId = flight.icao24;
            const existingState = flightStates.current.get(flightId);
            
            const newState = {
                // Current real position from API
                realPosition: [flight.longitude, flight.latitude],
                realHeading: flight.true_track || 0,
                velocity: flight.velocity || 0, // m/s
                lastUpdateTime: currentTime,
                
                // Interpolated position (starts at real position)
                currentPosition: existingState?.currentPosition || [flight.longitude, flight.latitude],
                currentHeading: existingState?.currentHeading || (flight.true_track || 0),
                
                // Previous state for smooth transitions
                previousPosition: existingState?.realPosition || [flight.longitude, flight.latitude],
                previousHeading: existingState?.realHeading || (flight.true_track || 0),
                previousUpdateTime: existingState?.lastUpdateTime || currentTime,
                
                // Flight metadata
                callsign: flight.callsign,
                origin_country: flight.origin_country,
                baro_altitude: flight.baro_altitude,
                
                // Animation state
                isStale: false,
                opacity: 1
            };
            
            flightStates.current.set(flightId, newState);
            return newState;
        },

        // Interpolate position between updates using velocity vector
        interpolatePosition: (state, currentTime, deltaTime) => {
            if (!state || state.velocity < 2.57) return state.currentPosition; // < 5 knots, freeze position
            
            const timeSinceUpdate = (currentTime - state.lastUpdateTime) / 1000; // seconds
            const maxPredictionTime = Math.min(10, timeSinceUpdate); // Cap at 10 seconds
            
            // Convert velocity from m/s to degrees per second (approximate)
            const metersPerDegree = 111000; // Approximate meters per degree at equator
            const velocityDegreesPerSec = state.velocity / metersPerDegree;
            
            // Calculate velocity vector components
            const headingRad = (state.realHeading * Math.PI) / 180;
            const velocityLat = velocityDegreesPerSec * Math.cos(headingRad);
            const velocityLon = velocityDegreesPerSec * Math.sin(headingRad) / Math.cos((state.realPosition[1] * Math.PI) / 180);
            
            // Predict position based on velocity vector
            const predictedLon = state.realPosition[0] + (velocityLon * maxPredictionTime);
            const predictedLat = state.realPosition[1] + (velocityLat * maxPredictionTime);
            
            // Smooth interpolation with ease-in/out
            const t = Math.min(deltaTime / 1000, 1); // Normalize to 0-1 over 1 second
            const easeT = 0.5 * (1 - Math.cos(Math.PI * t)); // Smooth ease-in/out
            
            const interpolatedLon = state.previousPosition[0] + (predictedLon - state.previousPosition[0]) * easeT;
            const interpolatedLat = state.previousPosition[1] + (predictedLat - state.previousPosition[1]) * easeT;
            
            return [interpolatedLon, interpolatedLat];
        },

        // Smooth heading changes with low-pass filter
        interpolateHeading: (state, deltaTime) => {
            if (!state) return 0;
            
            const targetHeading = state.realHeading;
            const currentHeading = state.currentHeading;
            
            // Calculate shortest angular distance
            let headingDiff = targetHeading - currentHeading;
            if (headingDiff > 180) headingDiff -= 360;
            if (headingDiff < -180) headingDiff += 360;
            
            // Low-pass filter for smooth heading changes (damping factor)
            const dampingFactor = Math.min(deltaTime / 2000, 1); // 2 second transition
            const smoothedHeading = currentHeading + (headingDiff * dampingFactor);
            
            // Normalize to 0-360 range
            return ((smoothedHeading % 360) + 360) % 360;
        },

        // Check if flight data is stale
        isFlightStale: (state, currentTime) => {
            return (currentTime - state.lastUpdateTime) > 20000; // 20 seconds
        }
    };

    useEffect(() => {
        if (map.current) return; // initialize map only once

        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [lng, lat],
            zoom: zoom,
            // Performance optimizations for smooth animation
            antialias: false,
            preserveDrawingBuffer: false,
            renderWorldCopies: false,
            maxZoom: 12,
            minZoom: 1
        });

        map.current.on('load', () => {
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
                    'text-field': '✈️',
                    'text-size': 28,
                    'text-rotate': ['get', 'heading'],
                    'text-rotation-alignment': 'map',
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular']
                },
                paint: {
                    'text-color': '#4A90E2',
                    'text-halo-width': 0,
                    'text-opacity': ['get', 'opacity']
                }
            });

            // Click handler for flight details
            map.current.on('click', 'flight-markers', (e) => {
                const properties = e.features[0].properties;
                const flightState = flightStates.current.get(properties.icao24);
                if (flightState) {
                    showHeadingPopup({
                        ...properties,
                        ...flightState,
                        longitude: e.features[0].geometry.coordinates[0],
                        latitude: e.features[0].geometry.coordinates[1]
                    });
                }
            });

            // Hover effects
            map.current.on('mouseenter', 'flight-markers', () => {
                map.current.getCanvas().style.cursor = 'pointer';
            });

            map.current.on('mouseleave', 'flight-markers', () => {
                map.current.getCanvas().style.cursor = '';
            });

            setIsMapLoaded(true);
            
            // Start 60fps animation loop
            startAnimationLoop();
        });

        // Throttle move events
        let moveTimeout;
        map.current.on('move', () => {
            if (moveTimeout) clearTimeout(moveTimeout);
            moveTimeout = setTimeout(() => {
                setLng(map.current.getCenter().lng.toFixed(4));
                setLat(map.current.getCenter().lat.toFixed(4));
                setZoom(map.current.getZoom().toFixed(2));
            }, 100);
        });

        map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

        return () => {
            if (animationFrame.current) {
                cancelAnimationFrame(animationFrame.current);
            }
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, []);

    // 60fps animation loop for smooth interpolation
    const startAnimationLoop = useCallback(() => {
        const animate = (currentTime) => {
            if (!map.current || !isMapLoaded) {
                animationFrame.current = requestAnimationFrame(animate);
                return;
            }

            const deltaTime = currentTime - lastUpdateTime.current;
            lastUpdateTime.current = currentTime;

            // Update all flight positions and headings
            const features = [];
            
            flightStates.current.forEach((state, flightId) => {
                // Check if flight is stale
                if (FlightAnimator.isFlightStale(state, currentTime)) {
                    state.isStale = true;
                    state.opacity = Math.max(0.3, state.opacity - 0.02); // Fade out
                } else {
                    state.opacity = Math.min(1, state.opacity + 0.05); // Fade in
                }

                // Interpolate position and heading
                state.currentPosition = FlightAnimator.interpolatePosition(state, currentTime, deltaTime);
                state.currentHeading = FlightAnimator.interpolateHeading(state, deltaTime);
                
                // Adjust heading for airplane emoji orientation (points northeast naturally)
                const adjustedHeading = state.currentHeading - 45;

                features.push({
                    type: 'Feature',
                    properties: {
                        icao24: flightId,
                        callsign: state.callsign || 'Unknown',
                        heading: adjustedHeading,
                        opacity: state.opacity,
                        true_track: state.realHeading,
                        velocity: state.velocity
                    },
                    geometry: {
                        type: 'Point',
                        coordinates: state.currentPosition
                    }
                });
            });

            // Update map data
            if (map.current.getSource('flights')) {
                map.current.getSource('flights').setData({
                    type: 'FeatureCollection',
                    features: features
                });
            }

            // Continue animation loop
            animationFrame.current = requestAnimationFrame(animate);
        };

        animationFrame.current = requestAnimationFrame(animate);
    }, [isMapLoaded]);

    // Infer destination from flight callsign
    const inferDestination = useCallback((callsign, origin_country) => {
        if (!callsign || callsign.trim() === '') return 'Unknown';
        
        const cleanCallsign = callsign.trim();
        const airlineCode = cleanCallsign.substring(0, 3);
        
        const routePatterns = {
            // US Airlines
            'AAL': 'Dallas/Miami/Phoenix Hub',
            'DAL': 'Atlanta/Detroit/Minneapolis Hub', 
            'UAL': 'Chicago/Denver/San Francisco Hub',
            'SWA': 'US Domestic Network',
            'JBU': 'New York/Boston/Fort Lauderdale Hub',
            'ASA': 'Seattle/Portland Hub',
            'FFT': 'Memphis Hub (Cargo)',
            'FDX': 'Memphis Hub (Cargo)',
            'UPS': 'Louisville Hub (Cargo)',
            
            // European Airlines
            'BAW': 'London Heathrow Hub',
            'AFR': 'Paris Charles de Gaulle Hub',
            'DLH': 'Frankfurt/Munich Hub',
            'KLM': 'Amsterdam Schiphol Hub',
            'SWR': 'Zurich Hub',
            'AUA': 'Vienna Hub',
            'SAS': 'Copenhagen/Stockholm Hub',
            'FIN': 'Helsinki Hub',
            'LOT': 'Warsaw Hub',
            'CSA': 'Prague Hub',
            'IBE': 'Madrid Hub',
            'TAP': 'Lisbon Hub',
            'AZA': 'Rome/Milan Hub',
            'TUR': 'Istanbul Hub',
            
            // Asian Airlines
            'JAL': 'Tokyo Haneda/Narita Hub',
            'ANA': 'Tokyo Haneda/Narita Hub',
            'KAL': 'Seoul Incheon Hub',
            'AAR': 'Seoul Incheon Hub',
            'CCA': 'Beijing Capital Hub',
            'CES': 'Shanghai Pudong Hub',
            'SIA': 'Singapore Changi Hub',
            'THA': 'Bangkok Suvarnabhumi Hub',
            'MAS': 'Kuala Lumpur Hub',
            'EVA': 'Taipei Hub',
            'CAL': 'Taipei Hub',
            
            // Middle East & Africa
            'UAE': 'Dubai International Hub',
            'QTR': 'Doha Hamad Hub',
            'SVA': 'Riyadh/Jeddah Hub',
            'ETH': 'Addis Ababa Hub',
            'SAA': 'Johannesburg Hub',
            
            // Others
            'AFL': 'Moscow Sheremetyevo Hub',
            'SBI': 'Novosibirsk Hub',
            'QFA': 'Sydney/Melbourne Hub',
            'ANZ': 'Auckland Hub'
        };
        
        if (routePatterns[airlineCode]) {
            return routePatterns[airlineCode];
        }
        
        if (origin_country && origin_country !== 'Unknown') {
            return `${origin_country} Region`;
        }
        
        return 'Unknown';
    }, []);

    // Show flight details popup
    const showHeadingPopup = useCallback((flight) => {
        setSelectedFlight(flight);
        
        const destination = inferDestination(flight.callsign, flight.origin_country);
        
        const popupContent = `
            <div class="flight-popup">
                <h3>${flight.callsign || 'Unknown Flight'}</h3>
                <p><strong>ICAO24:</strong> ${flight.icao24}</p>
                <p><strong>Origin:</strong> ${flight.origin_country || 'Unknown'}</p>
                <p><strong>Destination:</strong> ${destination}</p>
                <p><strong>Altitude:</strong> ${flight.baro_altitude ? `${Math.round(flight.baro_altitude)}m` : 'N/A'}</p>
                <p><strong>Speed:</strong> ${flight.velocity ? `${Math.round(flight.velocity * 3.6)} km/h` : 'N/A'}</p>
                <p class="heading-highlight"><strong>True Course:</strong> ${typeof flight.true_track === 'number' ? `${Math.round(flight.true_track)}°` : 'N/A'}</p>
                <p><strong>Ground Speed:</strong> ${flight.velocity ? `${Math.round(flight.velocity * 1.944)} knots` : 'N/A'}</p>
                <p><em>0°=North, 90°=East, 180°=South, 270°=West</em></p>
            </div>
        `;
        
        const popup = new mapboxgl.Popup({ 
            offset: 25,
            closeButton: true,
            closeOnClick: true,
            maxWidth: '280px'
        })
        .setLngLat([flight.longitude, flight.latitude])
        .setHTML(popupContent)
        .addTo(map.current);

        popup.on('close', () => {
            setSelectedFlight(null);
        });
    }, [inferDestination]);

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

    // Update flight data from server (every 15 seconds)
    useEffect(() => {
        if (!isMapLoaded || !validFlights.length) return;

        const currentTime = Date.now();
        
        // Update flight states with new data
        const currentFlightIds = new Set(validFlights.map(f => f.icao24));
        
        // Remove stale flights
        flightStates.current.forEach((state, flightId) => {
            if (!currentFlightIds.has(flightId)) {
                flightStates.current.delete(flightId);
            }
        });

        // Update existing flights and add new ones
        validFlights.forEach(flight => {
            FlightAnimator.updateFlightState(flight, currentTime);
        });

        // Debug logging
        if (Math.random() < 0.01) {
            console.log(`Updated ${validFlights.length} flights for smooth interpolation`);
        }

    }, [validFlights, isMapLoaded]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;