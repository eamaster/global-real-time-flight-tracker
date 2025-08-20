#!/usr/bin/env node

// Simple test to check OpenSky API directly
// Run with: node test-opensky.js

const https = require('https');

console.log('🧪 Testing OpenSky API directly\n');

// Test OpenSky API without authentication (public endpoint)
function testOpenSky() {
    return new Promise((resolve, reject) => {
        const url = 'https://opensky-network.org/api/states/all?lamin=40.5&lomin=-74.1&lamax=40.8&lomax=-73.8';
        
        console.log(`📡 Testing: ${url}`);
        
        const req = https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                console.log(`✅ Status: ${res.statusCode}`);
                console.log(`📊 Response size: ${data.length} bytes`);
                
                if (res.statusCode === 200) {
                    try {
                        const jsonData = JSON.parse(data);
                        if (jsonData.states) {
                            console.log(`✈️  Flights returned: ${jsonData.states.length}`);
                        } else {
                            console.log(`💬 Response: ${JSON.stringify(jsonData, null, 2)}`);
                        }
                    } catch (e) {
                        console.log(`📝 Raw response: ${data.substring(0, 200)}...`);
                    }
                } else {
                    console.log(`❌ Error response: ${data}`);
                }
                
                resolve();
            });
        });
        
        req.on('error', (err) => {
            console.log(`❌ Network error: ${err.message}`);
            reject(err);
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            console.log(`⏰ Request timeout after 10 seconds`);
            resolve();
        });
    });
}

// Test with authentication (if credentials are available)
async function testOpenSkyWithAuth() {
    const clientId = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
        console.log('🔑 No OpenSky credentials found in environment variables');
        return;
    }
    
    console.log('\n🔑 Testing OpenSky API with authentication...');
    
    try {
        // Get OAuth token
        const tokenResponse = await new Promise((resolve, reject) => {
            const params = new URLSearchParams();
            params.append('grant_type', 'client_credentials');
            params.append('client_id', clientId);
            params.append('client_secret', clientSecret);
            
            const req = https.request('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, data }));
            });
            
            req.on('error', reject);
            req.write(params.toString());
            req.end();
        });
        
        if (tokenResponse.status === 200) {
            const tokenData = JSON.parse(tokenResponse.data);
            console.log('✅ Successfully obtained OAuth token');
            
            // Test API with token
            const apiResponse = await new Promise((resolve, reject) => {
                const url = 'https://opensky-network.org/api/states/all?lamin=40.5&lomin=-74.1&lamax=40.8&lomax=-73.8';
                
                const req = https.get(url, {
                    headers: {
                        'Authorization': `Bearer ${tokenData.access_token}`
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                });
                
                req.on('error', reject);
                req.setTimeout(10000, () => {
                    req.destroy();
                    resolve({ status: 408, data: 'Timeout' });
                });
            });
            
            console.log(`🔐 Authenticated API Status: ${apiResponse.status}`);
            if (apiResponse.status === 200) {
                const jsonData = JSON.parse(apiResponse.data);
                console.log(`✈️  Authenticated flights: ${jsonData.states ? jsonData.states.length : 'N/A'}`);
            }
        } else {
            console.log(`❌ Failed to get OAuth token: ${tokenResponse.status}`);
        }
        
    } catch (error) {
        console.log(`❌ Authentication test error: ${error.message}`);
    }
}

// Run tests
async function runTests() {
    try {
        await testOpenSky();
        await testOpenSkyWithAuth();
    } catch (error) {
        console.log(`❌ Test error: ${error.message}`);
    }
    
    console.log('\n🎯 OpenSky API test completed!');
}

runTests();
