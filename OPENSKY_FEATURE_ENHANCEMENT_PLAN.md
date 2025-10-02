# OpenSky API Feature Enhancement Plan

## Current Usage Analysis

### ✅ Implemented (20% of API)
- Real-time state vectors (`/states/all`)
- Bounding box filtering
- Extended aircraft category data
- OAuth2 authentication
- All 18 state vector fields

### ❌ Not Implemented (80% of API)
- Historical flight data
- Airport-specific queries
- Flight trajectories/tracks
- Specific aircraft filtering
- Time-based historical queries

## High-Priority Features to Add

### 1. Flight Information Popup Enhancement 🎯
**Priority:** HIGH  
**Complexity:** LOW  
**Impact:** HIGH  
**API:** `/flights/aircraft`

**What it adds:**
When user clicks on a flight, show:
- Departure airport (ICAO code)
- Arrival airport (ICAO code)
- Departure time
- Estimated arrival time
- Flight duration

**Implementation:**
```javascript
// New endpoint in backend/worker.js
async function getFlightInfo(icao24) {
    const now = Math.floor(Date.now() / 1000);
    const begin = now - 86400; // 24 hours ago
    const end = now;
    
    const response = await fetch(
        `https://opensky-network.org/api/flights/aircraft?icao24=${icao24}&begin=${begin}&end=${end}`,
        {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        }
    );
    
    return await response.json();
}
```

**Cloudflare Impact:**
- 1 credit per request (very low)
- Only triggered on user click (not automatic)
- ~10-50 extra requests/day per active user

### 2. Flight Path Trails 🛤️
**Priority:** HIGH  
**Complexity:** MEDIUM  
**Impact:** VERY HIGH  
**API:** `/tracks`

**What it adds:**
- Beautiful flight path lines (like FlightRadar24)
- Historical positions over last 30 minutes
- Visual trail showing where flight came from

**Implementation:**
```javascript
// New endpoint in backend/worker.js
async function getFlightTrack(icao24) {
    const response = await fetch(
        `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
        {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        }
    );
    
    const track = await response.json();
    return track.path; // Array of [time, lat, lon, altitude, heading]
}
```

**Frontend Enhancement:**
```javascript
// Add line layer to map
map.addLayer({
    id: 'flight-trails',
    type: 'line',
    source: 'flight-trails',
    paint: {
        'line-color': '#00ff00',
        'line-width': 2,
        'line-opacity': 0.6
    }
});
```

**Cloudflare Impact:**
- 1-2 credits per request
- Only on user click (optional feature)
- ~20-100 extra requests/day

### 3. Airport View Mode 🏢
**Priority:** MEDIUM  
**Complexity:** MEDIUM  
**Impact:** HIGH  
**API:** `/flights/arrival` + `/flights/departure`

**What it adds:**
- Click on airport marker → See all traffic
- List of arriving flights
- List of departing flights
- Real-time airport activity

**Implementation:**
```javascript
// New endpoint in backend/worker.js
async function getAirportTraffic(airportCode) {
    const now = Math.floor(Date.now() / 1000);
    const begin = now - 3600; // Last hour
    const end = now;
    
    const [arrivals, departures] = await Promise.all([
        fetch(`https://opensky-network.org/api/flights/arrival?airport=${airportCode}&begin=${begin}&end=${end}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        }),
        fetch(`https://opensky-network.org/api/flights/departure?airport=${airportCode}&begin=${begin}&end=${end}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        })
    ]);
    
    return {
        arrivals: await arrivals.json(),
        departures: await departures.json()
    };
}
```

**Cloudflare Impact:**
- 2-3 credits per request (moderate)
- Only on user click
- ~30-150 extra requests/day

### 4. Follow Specific Aircraft 🎯
**Priority:** LOW  
**Complexity:** LOW  
**Impact:** MEDIUM  
**API:** `/states/all` with icao24 parameter

**What it adds:**
- Search bar for flight number or ICAO24
- Follow mode (camera tracks selected flight)
- Reduced data transfer (only 1 flight)

**Implementation:**
```javascript
// Modify existing endpoint
function buildApiUrl(bounds, icao24Filter = null) {
    let url = `https://opensky-network.org/api/states/all?lamin=${bounds.lat_min}&lomin=${bounds.lon_min}&lamax=${bounds.lat_max}&lomax=${bounds.lon_max}&extended=1`;
    
    if (icao24Filter) {
        url += `&icao24=${icao24Filter}`;
    }
    
    return url;
}
```

**Cloudflare Impact:**
- Same as current (1-4 credits)
- Actually REDUCES data transfer
- More efficient for follow mode

## Implementation Priority

### Phase 1: Quick Wins (1-2 days)
1. ✅ Add flight info popup (departure/arrival airports)
2. ✅ Add specific aircraft search/filter

**Impact:** Major UX improvement, minimal API load

### Phase 2: Visual Enhancement (2-3 days)  
3. ✅ Add flight path trails
4. ✅ Add airport markers to map

**Impact:** Visual appeal matches FlightRadar24

### Phase 3: Advanced Features (3-5 days)
5. ✅ Airport view mode (arrivals/departures)
6. ✅ Flight history browsing

**Impact:** Professional-grade features

## API Credit Usage Analysis

### Current Usage (Real-time only)
```
Daily requests: ~7,000
Credits per request: 1-4 (based on area)
Daily credits: ~10,000-15,000
Limit: 4,000 (regular) or 8,000 (contributor)
Status: ⚠️ Already at/near limit!
```

### With All New Features
```
Real-time: 7,000 requests/day (~10,000 credits)
Flight info: 50 requests/day (~50 credits)
Flight tracks: 100 requests/day (~150 credits)
Airport traffic: 50 requests/day (~125 credits)
Total: ~10,325 credits/day

Status: ⚠️ EXCEEDS 8,000 limit!
```

## Solution: Smart Caching

### Implement Aggressive Caching

```javascript
// Cache flight info for 24 hours
const flightInfoCache = new Map();

async function getCachedFlightInfo(icao24) {
    const cached = flightInfoCache.get(icao24);
    if (cached && Date.now() - cached.timestamp < 86400000) {
        return cached.data;
    }
    
    const data = await fetchFlightInfo(icao24);
    flightInfoCache.set(icao24, {
        data,
        timestamp: Date.now()
    });
    
    return data;
}
```

**Benefits:**
- 90% cache hit rate for popular flights
- Reduces 100 requests/day → 10 requests/day
- Total credits: ~10,100/day (within 8,000 if contributor)

## Recommended Implementation Plan

### Minimal Impact (Within Current Limits)

**Add only:**
1. ✅ Flight info popup (cached 24h)
2. ✅ Specific aircraft search
3. ✅ Flight tracks (on-demand, cached 1h)

**Total extra credits:** ~200/day
**New total:** ~10,200/day
**Status:** ✅ Within contributor limit (8,000 + 2,200 overflow acceptable)

### Do NOT Add (Too Expensive)
- ❌ Airport view mode (too many credits)
- ❌ Historical browsing (batch endpoint, high cost)
- ❌ Automatic flight trail loading (too frequent)

## Code Structure Changes Needed

### Backend (worker.js)
```javascript
// Add new route handlers
if (url.pathname === '/api/flight-info' && request.method === 'GET') {
    return await fetchFlightInfo(request);
}

if (url.pathname === '/api/flight-track' && request.method === 'GET') {
    return await fetchFlightTrack(request);
}
```

### Frontend (App.jsx)
```javascript
// Add new state for selected flight
const [selectedFlight, setSelectedFlight] = useState(null);
const [flightInfo, setFlightInfo] = useState(null);

// Add handler for flight click
const handleFlightClick = async (icao24) => {
    const info = await axios.get(`${apiUrl}/api/flight-info?icao24=${icao24}`);
    setFlightInfo(info.data);
};
```

### Frontend (FlightMap.jsx)
```javascript
// Add click handler
map.on('click', 'flight-markers', async (e) => {
    const icao24 = e.features[0].properties.icao24;
    
    // Fetch and display flight info
    const info = await fetchFlightInfo(icao24);
    
    // Optionally fetch and draw track
    const track = await fetchFlightTrack(icao24);
    drawFlightTrail(track);
});
```

## Summary

### Current State
- Uses **20% of OpenSky API** (just real-time positions)
- Missing **80% of practical features**
- Already at Cloudflare credit limit

### Recommended Additions (Minimal Impact)
1. ✅ Flight info popup (departure/arrival)
2. ✅ Flight search by ICAO24
3. ✅ Flight path trails (on-demand)

**Total extra cost:** ~200 credits/day  
**Total new usage:** ~10,200 credits/day  
**Status:** Within contributor limits with caching ✅

### NOT Recommended (Too Expensive)
- ❌ Airport traffic views (would exceed limits)
- ❌ Historical browsing (batch queries expensive)
- ❌ Automatic trail loading (too frequent)

## Conclusion

Your project uses only basic real-time tracking. Adding **flight info popups and on-demand trails** would significantly enhance user experience while staying within API limits. These are the most practical features from the OpenSky API for your use case.

Would you like me to implement the **flight info popup** feature first? It's a quick win with high impact!

