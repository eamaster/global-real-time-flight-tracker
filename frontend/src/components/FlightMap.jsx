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
                </div>
            `;

            const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupContent);

            if (markers.current[icao24]) {
                // Update existing marker position
                markers.current[icao24].setLngLat([longitude, latitude]);
            } else {
                // Create a new marker
                const el = document.createElement('div');
                el.className = 'marker';
                el.innerHTML = '✈️';
                // Adjust rotation to account for the emoji's default orientation
                el.style.transform = `rotate(${true_track ? true_track - 45 : -45}deg)`;

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
