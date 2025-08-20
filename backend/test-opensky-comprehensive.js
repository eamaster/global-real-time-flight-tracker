#!/usr/bin/env node

// Comprehensive OpenSky API test
// Run with: node test-opensky-comprehensive.js

const https = require('https');

console.log('🔍 Comprehensive OpenSky API Test\n');

const CLIENT_ID = '';
const CLIENT_SECRET = '';

// Test different API endpoints and scenarios
async function testOpenSkyComprehensive() {
    try {
        console.log('📡 Step 1: Testing OAuth2 Authentication...');
        const token = await getOAuthToken();
        
        if (!token) {
            console.log('❌ Failed to get OAuth token, stopping tests');
            return;
        }
        
        console.log('✅ OAuth2 authentication successful!\n');
        
        // Test different scenarios
        await testPublicEndpoint();
        await testAuthenticatedEndpoint(token);
        await testDifferentRegions(token);
        await testOwnStatesEndpoint(token);
        await testFlightsEndpoint(token);
        
    } catch (error) {
        console.log(`❌ Test error: ${error.message}`);
    }
    
    console.log('\n🎯 Comprehensive test completed!');
}

async function getOAuthToken() {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', CLIENT_ID);
        params.append('client_secret', CLIENT_SECRET);
        
        const req = https.request('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    const tokenData = JSON.parse(data);
                    resolve(tokenData.access_token);
                } else {
                    resolve(null);
                }
            });
        });
        
        req.on('error', reject);
        req.write(params.toString());
        req.end();
    });
}

async function testPublicEndpoint() {
    console.log('📡 Step 2: Testing Public Endpoint (No Auth)...');
    
    try {
        const response = await makeRequest('https://opensky-network.org/api/states/all');
        console.log(`   Public API Status: ${response.status}`);
        
        if (response.status === 200) {
            const data = JSON.parse(response.data);
            console.log(`   ✅ Public API working! Flights: ${data.states ? data.states.length : 'N/A'}`);
        } else if (response.status === 503) {
            console.log(`   ❌ Public API: 503 Service Unavailable`);
        } else {
            console.log(`   ⚠️  Public API: ${response.status} - ${response.data}`);
        }
    } catch (error) {
        console.log(`   ❌ Public API error: ${error.message}`);
    }
}

async function testAuthenticatedEndpoint(token) {
    console.log('\n📡 Step 3: Testing Authenticated Endpoint...');
    
    try {
        const response = await makeRequest('https://opensky-network.org/api/states/all', {
            'Authorization': `Bearer ${token}`
        });
        console.log(`   Auth API Status: ${response.status}`);
        
        if (response.status === 200) {
            const data = JSON.parse(response.data);
            console.log(`   ✅ Auth API working! Flights: ${data.states ? data.states.length : 'N/A'}`);
            
            // Check rate limits
            if (response.headers['x-rate-limit-remaining']) {
                console.log(`   🔄 Rate limit remaining: ${response.headers['x-rate-limit-remaining']} credits`);
            }
        } else if (response.status === 503) {
            console.log(`   ❌ Auth API: 503 Service Unavailable`);
        } else {
            console.log(`   ⚠️  Auth API: ${response.status} - ${response.data}`);
        }
    } catch (error) {
        console.log(`   ❌ Auth API error: ${error.message}`);
    }
}

async function testDifferentRegions(token) {
    console.log('\n📡 Step 4: Testing Different Geographic Regions...');
    
    const regions = [
        { name: 'Europe (Small)', url: 'https://opensky-network.org/api/states/all?lamin=45&lomin=5&lamax=55&lomax=15&extended=1' },
        { name: 'North America (Small)', url: 'https://opensky-network.org/api/states/all?lamin=35&lomin=-80&lamax=45&lomax=-70&extended=1' },
        { name: 'Asia (Small)', url: 'https://opensky-network.org/api/states/all?lamin=30&lomin=100&lamax=40&lomax=110&extended=1' }
    ];
    
    for (const region of regions) {
        try {
            const response = await makeRequest(region.url, {
                'Authorization': `Bearer ${token}`
            });
            console.log(`   ${region.name}: ${response.status}`);
        } catch (error) {
            console.log(`   ${region.name}: Error - ${error.message}`);
        }
    }
}

async function testOwnStatesEndpoint(token) {
    console.log('\n📡 Step 5: Testing Own States Endpoint...');
    
    try {
        const response = await makeRequest('https://opensky-network.org/api/states/own', {
            'Authorization': `Bearer ${token}`
        });
        console.log(`   Own States Status: ${response.status}`);
        
        if (response.status === 200) {
            const data = JSON.parse(response.data);
            console.log(`   ✅ Own States working! Flights: ${data.states ? data.states.length : 'N/A'}`);
        } else if (response.status === 403) {
            console.log(`   ⚠️  Own States: 403 Forbidden (No sensors configured)`);
        } else {
            console.log(`   ⚠️  Own States: ${response.status} - ${response.data}`);
        }
    } catch (error) {
        console.log(`   ❌ Own States error: ${error.message}`);
    }
}

async function testFlightsEndpoint(token) {
    console.log('\n📡 Step 6: Testing Flights Endpoint...');
    
    try {
        const now = Math.floor(Date.now() / 1000);
        const oneHourAgo = now - 3600;
        const url = `https://opensky-network.org/api/flights/all?begin=${oneHourAgo}&end=${now}`;
        
        const response = await makeRequest(url, {
            'Authorization': `Bearer ${token}`
        });
        console.log(`   Flights API Status: ${response.status}`);
        
        if (response.status === 200) {
            const data = JSON.parse(response.data);
            console.log(`   ✅ Flights API working! Flights: ${Array.isArray(data) ? data.length : 'N/A'}`);
        } else if (response.status === 404) {
            console.log(`   ⚠️  Flights API: 404 No flights found in time range`);
        } else {
            console.log(`   ⚠️  Flights API: ${response.status} - ${response.data}`);
        }
    } catch (error) {
        console.log(`   ❌ Flights API error: ${error.message}`);
    }
}

function makeRequest(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ 
                status: res.statusCode, 
                data, 
                headers: res.headers 
            }));
        });
        
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

// Run comprehensive test
testOpenSkyComprehensive();
