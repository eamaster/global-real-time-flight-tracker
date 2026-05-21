/**
 * Shared utility library for Flight Tracker backend.
 * Unifies constants, data transformation, validation, filtering, and simulated fallbacks.
 * Used by both server.js (Node.js/Express) and worker.js (Cloudflare Workers).
 */

const MIN_ALTITUDE_M = 100;
const MIN_SPEED_MPS = 20;        // 20 m/s ≈ 39 knots
const MAX_POSITION_AGE_S = 300;  // 5 minutes
const MAX_BBOX_DEGREES = 80;

/**
 * Maps aircraft category codes to readable descriptions.
 */
const getAircraftType = (category) => {
    const types = {
        0: 'Unknown',
        1: 'No ADS-B Info',
        2: 'Light (< 15,500 lbs)',
        3: 'Small (15,500 - 75,000 lbs)',
        4: 'Large (75,000 - 300,000 lbs)',
        5: 'High Vortex Large (B-757)',
        6: 'Heavy (> 300,000 lbs)',
        7: 'High Performance (> 5g, 400 kts)',
        8: 'Rotorcraft',
        9: 'Glider/Sailplane',
        10: 'Lighter-than-air',
        11: 'Parachutist/Skydiver',
        12: 'Ultralight/Hang-glider',
        13: 'Reserved',
        14: 'UAV/Drone',
        15: 'Space Vehicle',
        16: 'Emergency Vehicle',
        17: 'Service Vehicle',
        18: 'Point Obstacle',
        19: 'Cluster Obstacle',
        20: 'Line Obstacle'
    };
    return types[category] || 'Unknown';
};

/**
 * Validates coordinate numbers and ranges.
 */
const isValidCoord = (lon, lat) =>
    Number.isFinite(lon) && Number.isFinite(lat) &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180;

/**
 * Transforms a raw OpenSky state vector array into a named, structured object.
 */
const transformState = (state) => {
    const lon = state[5] != null ? parseFloat(state[5]) : null;
    const lat = state[6] != null ? parseFloat(state[6]) : null;
    const baroAlt = state[7] != null ? parseFloat(state[7]) : null;
    const speed = state[9] != null ? parseFloat(state[9]) : null;

    return {
        icao24:          state[0],
        callsign:        state[1] ? state[1].trim() : null,
        origin_country:  state[2],
        time_position:   state[3] != null ? parseInt(state[3], 10) : null,
        last_contact:    state[4] != null ? parseInt(state[4], 10) : null,
        longitude:       lon,
        latitude:        lat,
        baro_altitude:   baroAlt,
        on_ground:       state[8] === true,
        velocity:        speed,
        true_track:      state[10] != null ? parseFloat(state[10]) : null,
        vertical_rate:   state[11] != null ? parseFloat(state[11]) : null,
        sensors:         state[12] || [],
        geo_altitude:    state[13] != null ? parseFloat(state[13]) : null,
        squawk:          state[14] || null,
        spi:             state[15] === true,
        position_source: state[16] != null ? parseInt(state[16], 10) : 0,
        category:        state[17] ?? 0,
        // Derived / convenience fields
        heading:         state[10] ?? 0,
        altitude_ft:     baroAlt != null ? Math.round(baroAlt * 3.28084) : null,
        speed_kts:       speed != null ? Math.round(speed * 1.94384) : null,
        speed_mph:       speed != null ? Math.round(speed * 2.23694) : null,
        aircraft_type:   getAircraftType(state[17] ?? 0),
    };
};

/**
 * Filters and transforms a list of raw state vectors.
 * Returns both the filtered flights and rejections statistics.
 */
const processFlightStates = (rawStates, now) => {
    let invalidCoordCount   = 0;
    let groundedCount       = 0;
    let altitudeTooLowCount = 0;
    let stalePosCount       = 0;
    let speedTooLowCount    = 0;

    const flights = rawStates
        .map(transformState)
        .filter(flight => {
            if (!isValidCoord(flight.longitude, flight.latitude)) {
                invalidCoordCount++;
                return false;
            }
            if (flight.on_ground === true) {
                groundedCount++;
                return false;
            }
            const alt = flight.baro_altitude ?? flight.geo_altitude ?? 0;
            if (alt < MIN_ALTITUDE_M) {
                altitudeTooLowCount++;
                return false;
            }
            if (flight.time_position != null && (now - flight.time_position) > MAX_POSITION_AGE_S) {
                stalePosCount++;
                return false;
            }
            if (flight.velocity !== null && flight.velocity < MIN_SPEED_MPS) {
                speedTooLowCount++;
                return false;
            }
            return true;
        });

    return {
        flights,
        stats: {
            invalidCoord:   invalidCoordCount,
            onGround:       groundedCount,
            altitudeTooLow: altitudeTooLowCount,
            stalePosition:  stalePosCount,
            speedTooLow:    speedTooLowCount,
        }
    };
};

/**
 * Generates structured fallback flight response containing simulated flight states.
 */
const generateFallbackFlights = (minLat, maxLat, minLon, maxLon) => {
    const sampleFlights = [];
    // 15 to 50 flights
    const numFlights = Math.min(25, Math.floor(Math.random() * 35) + 15);

    const aircraftTypes = [
        { category: 2, type: 'Light Aircraft', callsigns: ['N1234', 'G-ABCD', 'F-ABCD'] },
        { category: 3, type: 'Small Aircraft', callsigns: ['C-GABC', 'N5678', 'G-EFGH'] },
        { category: 4, type: 'Large Aircraft', callsigns: ['BA123', 'AA456', 'DL789'] },
        { category: 6, type: 'Heavy Aircraft', callsigns: ['LH123', 'AF456', 'EK789'] }
    ];

    const countries = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Netherlands', 'Spain', 'Italy'];

    for (let i = 0; i < numFlights; i++) {
        const lat = minLat + Math.random() * (maxLat - minLat);
        const lon = minLon + Math.random() * (maxLon - minLon);

        const aircraftType = aircraftTypes[Math.floor(Math.random() * aircraftTypes.length)];
        const callsign = aircraftType.callsigns[Math.floor(Math.random() * aircraftType.callsigns.length)] + 
                        Math.floor(Math.random() * 999).toString().padStart(3, '0');

        let altitude;
        if (aircraftType.category === 2) {
            altitude = Math.floor(Math.random() * 3000) + 500;
        } else if (aircraftType.category === 3) {
            altitude = Math.floor(Math.random() * 6000) + 1000;
        } else {
            altitude = Math.floor(Math.random() * 12000) + 8000;
        }

        let speed;
        if (aircraftType.category === 2) {
            speed = Math.floor(Math.random() * 80) + 40;
        } else if (aircraftType.category === 3) {
            speed = Math.floor(Math.random() * 120) + 80;
        } else {
            speed = Math.floor(Math.random() * 200) + 150;
        }

        const heading = Math.floor(Math.random() * 360);
        const verticalRate = Math.floor(Math.random() * 15) - 7;
        // Higher altitude means less likely on ground
        const onGround = aircraftType.category >= 4 ? Math.random() > 0.95 : Math.random() > 0.7;

        sampleFlights.push([
            `SAMPLE${i.toString().padStart(3, '0')}`,
            callsign,
            countries[Math.floor(Math.random() * countries.length)],
            Math.floor(Date.now() / 1000),
            Math.floor(Date.now() / 1000),
            lon,
            lat,
            altitude,
            onGround,
            speed,
            heading,
            verticalRate,
            [],
            altitude + Math.floor(Math.random() * 100) - 50,
            Math.floor(Math.random() * 9999).toString().padStart(4, '0'),
            false,
            0,
            aircraftType.category
        ]);
    }

    const { flights, stats } = processFlightStates(sampleFlights, Math.floor(Date.now() / 1000));

    return {
        flights,
        _fallback: true,
        _source: 'enhanced_sample',
        _message: 'OpenSky API unavailable. Showing enhanced sample data for demonstration.',
        _meta: {
            rawStateCount: sampleFlights.length,
            validCoordinateCount: sampleFlights.length - stats.invalidCoord,
            filteredCount: flights.length,
            rejections: stats,
            bbox: { minLat, minLon, maxLat, maxLon },
            authUsed: false,
            sourceTimestamp: Math.floor(Date.now() / 1000),
            serverTimestamp: Date.now(),
        }
    };
};

module.exports = {
    MIN_ALTITUDE_M,
    MIN_SPEED_MPS,
    MAX_POSITION_AGE_S,
    MAX_BBOX_DEGREES,
    getAircraftType,
    isValidCoord,
    transformState,
    processFlightStates,
    generateFallbackFlights
};
