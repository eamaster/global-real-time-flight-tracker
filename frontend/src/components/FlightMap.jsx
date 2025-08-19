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
    const markers = useRef({});
    const popups = useRef({});
    const [isMapLoaded, setIsMapLoaded] = useState(false);
    const updateTimeouts = useRef({});

    useEffect(() => {
        if (map.current) return; // initialize map only once


        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [lng, lat],
            zoom: zoom
        });

        map.current.on('load', () => {
            setIsMapLoaded(true);
        });

        map.current.on('move', () => {
            setLng(map.current.getCenter().lng.toFixed(4));
            setLat(map.current.getCenter().lat.toFixed(4));
            setZoom(map.current.getZoom().toFixed(2));
        });

        // Add navigation control (the +/- zoom buttons)
        map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

        // Clean up on unmount to prevent issues with React.StrictMode
        return () => {
            map.current.remove();
            map.current = null;
        };
    }, []);

    // Memoized function to calculate rotation angle for airplane emoji
    const calculateRotation = useCallback((trueTrack) => {
        if (!trueTrack || isNaN(trueTrack)) return 0;
        
        // Normalize the angle to be between 0 and 360 degrees
        let normalizedAngle = trueTrack % 360;
        if (normalizedAngle < 0) normalizedAngle += 360;
        
        // The airplane emoji ✈️ points northeast by default (around 45 degrees)
        // We need to adjust it to point in the correct direction
        // Subtract 45 degrees to align with the emoji's natural orientation
        return normalizedAngle - 45;
    }, []);

    // Optimized function to update marker rotation with debouncing
    const updateMarkerRotation = useCallback((markerElement, rotationAngle, icao24) => {
        if (!markerElement) return;
        
        // Clear any existing timeout for this marker
        if (updateTimeouts.current[icao24]) {
            clearTimeout(updateTimeouts.current[icao24]);
        }
        
        // Debounce rotation updates to improve performance
        updateTimeouts.current[icao24] = setTimeout(() => {
            requestAnimationFrame(() => {
                markerElement.style.setProperty('--rotation', `${rotationAngle}deg`);
                markerElement.style.transform = `rotate(${rotationAngle}deg)`;
            });
            delete updateTimeouts.current[icao24];
        }, 50);
    }, []);

    // Memoized popup creation to avoid recreating on every render
    const createPopup = useCallback((flight) => {
        const { icao24, callsign, origin_country, baro_altitude, velocity, true_track } = flight;
        
        if (popups.current[icao24]) {
            return popups.current[icao24];
        }
        
        const popupContent = `
            <div class="flight-popup">
                <h3>${callsign || 'N/A'}</h3>
                <p><strong>ICAO24:</strong> ${icao24}</p>
                <p><strong>Origin:</strong> ${origin_country}</p>
                <p><strong>Altitude:</strong> ${baro_altitude ? `${baro_altitude}m` : 'N/A'}</p>
                <p><strong>Speed:</strong> ${velocity ? `${velocity} m/s` : 'N/A'}</p>
                <p><strong>Heading:</strong> ${true_track ? `${true_track.toFixed(1)}°` : 'N/A'}</p>
            </div>
        `;
        
        const popup = new mapboxgl.Popup({ 
            offset: 25,
            closeButton: true,
            closeOnClick: false
        }).setHTML(popupContent);
        
        popups.current[icao24] = popup;
        return popup;
    }, []);

    // Optimized flights processing with useMemo
    const processedFlights = useMemo(() => {
        return flights.filter(flight => 
            flight.latitude && 
            flight.longitude && 
            !isNaN(flight.latitude) && 
            !isNaN(flight.longitude)
        );
    }, [flights]);

    useEffect(() => {
        if (!isMapLoaded || !processedFlights.length) return;

        const currentMarkerIds = Object.keys(markers.current);
        const newFlightIds = new Set(processedFlights.map(f => f.icao24));

        // Remove markers and popups for flights that are no longer present
        currentMarkerIds.forEach(id => {
            if (!newFlightIds.has(id)) {
                if (markers.current[id]) {
                    markers.current[id].remove();
                    delete markers.current[id];
                }
                if (popups.current[id]) {
                    delete popups.current[id];
                }
                if (updateTimeouts.current[id]) {
                    clearTimeout(updateTimeouts.current[id]);
                    delete updateTimeouts.current[id];
                }
            }
        });

        // Batch DOM updates using requestAnimationFrame
        requestAnimationFrame(() => {
            processedFlights.forEach(flight => {
                const { icao24, latitude, longitude, true_track } = flight;

                if (markers.current[icao24]) {
                    // Update existing marker position and rotation
                    const marker = markers.current[icao24];
                    marker.setLngLat([longitude, latitude]);
                    
                    // Update rotation smoothly with debouncing
                    const rotationAngle = calculateRotation(true_track);
                    const markerElement = marker.getElement();
                    updateMarkerRotation(markerElement, rotationAngle, icao24);
                    
                    // Update visual indicator efficiently
                    if (markerElement) {
                        const hasHeading = true_track && !isNaN(true_track);
                        markerElement.style.opacity = hasHeading ? '1' : '0.6';
                        markerElement.title = hasHeading ? 
                            `Heading: ${true_track.toFixed(1)}°` : 
                            'No heading data available';
                    }
                } else {
                    // Create a new marker with optimized setup
                    const el = document.createElement('div');
                    el.className = 'marker';
                    el.innerHTML = '✈️';
                    
                    // Set initial rotation immediately without debouncing
                    const rotationAngle = calculateRotation(true_track);
                    el.style.setProperty('--rotation', `${rotationAngle}deg`);
                    el.style.transform = `rotate(${rotationAngle}deg)`;
                    
                    // Set visual indicator
                    const hasHeading = true_track && !isNaN(true_track);
                    el.style.opacity = hasHeading ? '1' : '0.6';
                    el.title = hasHeading ? 
                        `Heading: ${true_track.toFixed(1)}°` : 
                        'No heading data available';

                    // Create popup only when needed
                    const popup = createPopup(flight);

                    const newMarker = new mapboxgl.Marker(el)
                        .setLngLat([longitude, latitude])
                        .setPopup(popup)
                        .addTo(map.current);
                    
                    markers.current[icao24] = newMarker;
                }
            });
        });
    }, [processedFlights, isMapLoaded, calculateRotation, updateMarkerRotation, createPopup]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;
