import React, { useRef, useEffect, useState } from 'react';
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

    // Function to calculate rotation angle for airplane emoji
    const calculateRotation = (trueTrack) => {
        if (!trueTrack || isNaN(trueTrack)) return 0;
        
        // Normalize the angle to be between 0 and 360 degrees
        let normalizedAngle = trueTrack % 360;
        if (normalizedAngle < 0) normalizedAngle += 360;
        
        // The airplane emoji ✈️ points upward by default
        // We need to rotate it so it points in the direction of travel
        // true_track is in degrees where 0° is North, 90° is East, etc.
        // Since the emoji points up (North) by default, we just need to rotate by true_track
        return normalizedAngle;
    };

    // Function to update marker rotation smoothly
    const updateMarkerRotation = (markerElement, rotationAngle) => {
        if (markerElement) {
            // Set CSS custom property for rotation
            markerElement.style.setProperty('--rotation', `${rotationAngle}deg`);
            markerElement.style.transform = `rotate(${rotationAngle}deg)`;
        }
    };

    useEffect(() => {
        if (!isMapLoaded) return; // wait for map to be loaded

        const currentMarkerIds = Object.keys(markers.current);
        const newFlightIds = new Set(flights.map(f => f.icao24));

        // Remove markers for flights that are no longer present
        currentMarkerIds.forEach(id => {
            if (!newFlightIds.has(id)) {
                markers.current[id].remove();
                delete markers.current[id];
            }
        });

        // Add or update markers for current flights
        flights.forEach(flight => {
            const { icao24, latitude, longitude, true_track, callsign, baro_altitude, velocity, origin_country } = flight;

            const popupContent = `
                <div>
                    <h3>${callsign || 'N/A'}</h3>
                    <p><strong>ICAO24:</strong> ${icao24}</p>
                    <p><strong>Origin:</strong> ${origin_country}</p>
                    <p><strong>Altitude:</strong> ${baro_altitude ? `${baro_altitude}m` : 'N/A'}</p>
                    <p><strong>Speed:</strong> ${velocity ? `${velocity} m/s` : 'N/A'}</p>
                    <p><strong>Heading:</strong> ${true_track ? `${true_track.toFixed(1)}°` : 'N/A'}</p>
                </div>
            `;

            const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupContent);

            if (markers.current[icao24]) {
                // Update existing marker position and rotation
                const marker = markers.current[icao24];
                marker.setLngLat([longitude, latitude]);
                
                // Update rotation smoothly
                const rotationAngle = calculateRotation(true_track);
                const markerElement = marker.getElement();
                updateMarkerRotation(markerElement, rotationAngle);
                
                // Add visual indicator for flights without heading data
                if (markerElement) {
                    if (!true_track || isNaN(true_track)) {
                        markerElement.style.opacity = '0.6';
                        markerElement.title = 'No heading data available';
                    } else {
                        markerElement.style.opacity = '1';
                        markerElement.title = `Heading: ${true_track.toFixed(1)}°`;
                    }
                }
            } else {
                // Create a new marker
                const el = document.createElement('div');
                el.className = 'marker';
                el.innerHTML = '✈️';
                
                // Set initial rotation
                const rotationAngle = calculateRotation(true_track);
                updateMarkerRotation(el, rotationAngle);
                
                // Add visual indicator for flights without heading data
                if (!true_track || isNaN(true_track)) {
                    el.style.opacity = '0.6';
                    el.title = 'No heading data available';
                } else {
                    el.title = `Heading: ${true_track.toFixed(1)}°`;
                }

                const newMarker = new mapboxgl.Marker(el)
                    .setLngLat([longitude, latitude])
                    .setPopup(popup)
                    .addTo(map.current);
                markers.current[icao24] = newMarker;
            }
        });
    }, [flights, isMapLoaded]);

    return (
        <div className="flight-map-wrapper">
            <div ref={mapContainer} className="map-container" />
        </div>
    );
};

export default FlightMap;
