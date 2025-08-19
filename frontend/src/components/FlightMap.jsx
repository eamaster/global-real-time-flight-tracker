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

    // Function to update airplane emoji rotation based on heading
    const updatePlaneDirection = (element, heading) => {
        if (heading === null || heading === undefined) {
            // Default orientation when no heading data is available
            element.style.transform = 'rotate(-45deg)';
            return;
        }

        // Convert heading to rotation angle
        // The ✈️ emoji naturally points northeast (45°), so we subtract 45° to align it properly
        // Heading 0° (North) should point up, 90° (East) should point right, etc.
        const rotation = heading - 45;
        
        // Handle smooth transition across 360°/0° boundary
        const currentTransform = element.style.transform;
        const currentRotation = currentTransform ? parseFloat(currentTransform.match(/rotate\((-?\d+\.?\d*)deg\)/)?.[1] || 0) : 0;
        
        let targetRotation = rotation;
        
        // Calculate the shortest rotation path
        const diff = targetRotation - currentRotation;
        if (diff > 180) {
            targetRotation -= 360;
        } else if (diff < -180) {
            targetRotation += 360;
        }
        
        element.style.transform = `rotate(${targetRotation}deg)`;
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
                    <p><strong>Heading:</strong> ${true_track ? `${Math.round(true_track)}°` : 'N/A'}</p>
                </div>
            `;

            const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupContent);

            if (markers.current[icao24]) {
                // Update existing marker position and rotation
                const marker = markers.current[icao24];
                marker.setLngLat([longitude, latitude]);
                
                // Update the rotation of the existing marker element
                const markerElement = marker.getElement();
                updatePlaneDirection(markerElement, true_track);
            } else {
                // Create a new marker
                const el = document.createElement('div');
                el.className = 'marker airplane-marker';
                el.innerHTML = '✈️';
                
                // Set initial rotation
                updatePlaneDirection(el, true_track);

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
