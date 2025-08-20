#!/usr/bin/env node

// Test script for the flight tracker API
// Run with: node test-api.js

const https = require('https');

const API_BASE = 'https://global-flight-tracker-api.smah0085.workers.dev';

// Test cases with different bounding boxes
const testCases = [
    {
        name: 'Small area (New York City)',
        params: 'lat_min=40.5&lon_min=-74.1&lat_max=40.8&lon_max=-73.8'
    },
    {
        name: 'Medium area (Northeast US)',
        params: 'lat_min=35&lon_min=-80&lat_max=45&lon_max=-70'
    },
    {
        name: 'Large area (should be rejected)',
        params: 'lat_min=30&lon_min=-120&lat_max=50&lon_max=-60'
    },
    {
        name: 'Invalid coordinates',
        params: 'lat_min=invalid&lon_min=-80&lat_max=50&lon_max=-70'
    }
];

function makeRequest(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        data: jsonData
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        data: data
                    });
                }
            });
        });
        
        req.on('error', (err) => {
            reject(err);
        });
        
        req.setTimeout(20000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

async function runTests() {
    console.log('🧪 Testing Flight Tracker API\n');
    console.log(`API Base: ${API_BASE}\n`);
    
    for (const testCase of testCases) {
        console.log(`📋 Testing: ${testCase.name}`);
        console.log(`URL: ${API_BASE}/api/flights?${testCase.params}`);
        
        try {
            const startTime = Date.now();
            const response = await makeRequest(`${API_BASE}/api/flights?${testCase.params}`);
            const duration = Date.now() - startTime;
            
            console.log(`✅ Status: ${response.status}`);
            console.log(`⏱️  Duration: ${duration}ms`);
            
            if (response.data && response.data.flights) {
                console.log(`✈️  Flights returned: ${response.data.flights.length}`);
            } else if (response.data && response.data.message) {
                console.log(`💬 Message: ${response.data.message}`);
            }
            
            if (response.headers['retry-after']) {
                console.log(`🔄 Retry-After: ${response.headers['retry-after']}s`);
            }
            
        } catch (error) {
            console.log(`❌ Error: ${error.message}`);
        }
        
        console.log('─'.repeat(50));
    }
    
    // Test CORS preflight
    console.log('\n📋 Testing CORS preflight');
    try {
        const response = await makeRequest(`${API_BASE}/api/flights`);
        console.log(`✅ CORS Status: ${response.status}`);
        console.log(`🌐 Access-Control-Allow-Origin: ${response.headers['access-control-allow-origin']}`);
    } catch (error) {
        console.log(`❌ CORS Error: ${error.message}`);
    }
    
    console.log('\n🎯 Test completed!');
}

// Run tests
runTests().catch(console.error);
