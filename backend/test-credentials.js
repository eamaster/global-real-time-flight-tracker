#!/usr/bin/env node

// Test script to verify OpenSky API credentials
// Run with: node test-credentials.js

const https = require('https');

console.log('🔑 Testing OpenSky API Credentials\n');

const CLIENT_ID = 'eamaster-api-client';
const CLIENT_SECRET = '09VJfhtZ1ObHTlXkpQ6WOm7Ln4OKtVXZ';

async function testCredentials() {
    try {
        console.log('📡 Step 1: Getting OAuth2 token...');
        
        // Get OAuth token
        const tokenResponse = await new Promise((resolve, reject) => {
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
                res.on('end', () => resolve({ status: res.statusCode, data }));
            });
            
            req.on('error', reject);
            req.write(params.toString());
            req.end();
        });
        
        console.log(`✅ Token Response Status: ${tokenResponse.status}`);
        
        if (tokenResponse.status === 200) {
            const tokenData = JSON.parse(tokenResponse.data);
            console.log('✅ Successfully obtained OAuth token!');
            console.log(`🔑 Token expires in: ${tokenData.expires_in} seconds`);
            
            // Test API with token
            console.log('\n📡 Step 2: Testing API with token...');
            
            const apiResponse = await new Promise((resolve, reject) => {
                const url = 'https://opensky-network.org/api/states/all?lamin=40.5&lomin=-74.1&lamax=40.8&lomax=-73.8&extended=1';
                
                const req = https.get(url, {
                    headers: {
                        'Authorization': `Bearer ${tokenData.access_token}`
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
                });
                
                req.on('error', reject);
                req.setTimeout(15000, () => {
                    req.destroy();
                    resolve({ status: 408, data: 'Timeout', headers: {} });
                });
            });
            
            console.log(`✅ API Response Status: ${apiResponse.status}`);
            
            if (apiResponse.status === 200) {
                const jsonData = JSON.parse(apiResponse.data);
                console.log(`✈️  Flights returned: ${jsonData.states ? jsonData.states.length : 'N/A'}`);
                
                if (jsonData.states && jsonData.states.length > 0) {
                    const sampleFlight = jsonData.states[0];
                    console.log('\n📊 Sample Flight Data:');
                    console.log(`   ICAO24: ${sampleFlight[0]}`);
                    console.log(`   Callsign: ${sampleFlight[1]}`);
                    console.log(`   Country: ${sampleFlight[2]}`);
                    console.log(`   Position: ${sampleFlight[6]}, ${sampleFlight[5]}`);
                    console.log(`   Altitude: ${sampleFlight[7]}m`);
                    console.log(`   Speed: ${sampleFlight[9]} m/s`);
                    console.log(`   Category: ${sampleFlight[17] || 'N/A'}`);
                }
                
                // Check rate limits
                const remaining = apiResponse.headers['x-rate-limit-remaining'];
                if (remaining) {
                    console.log(`🔄 Rate limit remaining: ${remaining} credits`);
                }
                
            } else {
                console.log(`❌ API Error: ${apiResponse.data}`);
            }
            
        } else {
            console.log(`❌ Failed to get OAuth token: ${tokenResponse.status}`);
            console.log(`Error response: ${tokenResponse.data}`);
        }
        
    } catch (error) {
        console.log(`❌ Test error: ${error.message}`);
    }
    
    console.log('\n🎯 Credential test completed!');
}

// Run test
testCredentials();
