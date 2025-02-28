const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require("ws");

let lastBlockNumber = null;
let sseClients = new Set();
let wsClients = new Set();

// Create HTTP server
const server = http.createServer((req, res) => {
    if (req.url === "/") {
        fs.readFile(path.join(__dirname, "fastblocks.html"), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end("Error loading fastblocks.html");
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(data);
        });
    } else if (req.url === "/events") {
        // Set headers for Server-Sent Events
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        
        // Add client to the set
        sseClients.add(res);
        
        // Remove client when connection closes
        req.on('close', () => {
            sseClients.delete(res);
        });
    }
});

// Create WebSocket server for clients
const wss = new WebSocket.Server({ server });

// Connect to Base Sepolia WebSocket for FlashBlocks
const flashWs = new WebSocket(`wss://sepolia.flashblocks.base.org/ws`, {
    headers: {
        "Host": "sepolia.flashblocks.base.org",
        "Connection": "Upgrade",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        "Upgrade": "websocket",
        "Origin": "https://flashblocks.base.org",
        "Sec-WebSocket-Version": "13",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "zh-CN,zh;q=0.9",
        'Sec-WebSocket-Extensions': 'permessage-deflate'
    }
});

flashWs.binaryType = 'nodebuffer';

// Handle Base Sepolia WebSocket connection for FlashBlocks
flashWs.onopen = function () {
    console.log('Connected to Base Sepolia FlashBlocks WebSocket');
};

flashWs.onmessage = function (e) {
    try {
        const message = JSON.parse(e.data.toString('utf-8'));
        console.log('Received FlashBlocks data:', message.metadata.block_number);
        
        // Broadcast the message to all connected WebSocket clients with type identifier
        const flashMessage = {
            type: 'flash',
            data: message
        };
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(flashMessage));
            }
        });
    } catch (e) {
        console.error('Error processing FlashBlocks message:', e);
    }
};

flashWs.onclose = function () {
    console.error('Base Sepolia FlashBlocks WebSocket connection closed');
    setTimeout(() => {
        console.log('Attempting to reconnect FlashBlocks...');
        flashWs = new WebSocket(`wss://sepolia.flashblocks.base.org/ws`);
    }, 5000);
};

flashWs.onerror = function (error) {
    console.error('Base Sepolia FlashBlocks WebSocket error:', error);
};

function getLatestBlock() {
    const data = JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: ['latest', false],
        id: 1
    });

    const options = {
        hostname: 'sepolia.base.org',
        port: 443,
        path: '/',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length,
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Origin': 'https://sepolia.base.org',
            'Host': 'sepolia.base.org'
        },
        timeout: 10000, // 10 second timeout
        rejectUnauthorized: false // Allow self-signed certificates
    };

    const req = https.request(options, (res) => {
        let responseData = '';

        // Check response status
        if (res.statusCode !== 200) {
            console.error(`Full Node returned status code: ${res.statusCode}`);
            return;
        }

        res.on('data', (chunk) => {
            responseData += chunk;
        });

        res.on('end', () => {
            if (!responseData) {
                console.error('Empty response from Full Node');
                return;
            }

            try {
                const result = JSON.parse(responseData);
                if (result && result.result) {
                    const block = result.result;
                    // Only send if it's a new block
                    if (block.number !== lastBlockNumber) {
                        lastBlockNumber = block.number;
                        const blockData = {
                            number: parseInt(block.number, 16),
                            hash: block.hash,
                            parentHash: block.parentHash,
                            timestamp: parseInt(block.timestamp, 16) * 1000,
                            gasUsed: parseInt(block.gasUsed, 16),
                            transactions: block.transactions.length,
                            gasLimit: parseInt(block.gasLimit, 16)
                        };
                        
                        // Send to all connected SSE clients
                        const eventData = `data: ${JSON.stringify(blockData)}\n\n`;
                        sseClients.forEach(client => {
                            try {
                                client.write(eventData);
                            } catch (e) {
                                console.error('Error sending to SSE client:', e);
                                sseClients.delete(client);
                            }
                        });
                        
                        console.log('New Full Node Block:', blockData.number);
                    }
                } else if (result.error) {
                    console.error('Full Node RPC error:', result.error);
                }
            } catch (e) {
                console.error('Error parsing Full Node response:', e);
                console.error('Raw response:', responseData);
            }
        });

        // Handle response timeout
        res.setTimeout(10000, () => {
            res.destroy();
            console.error('Full Node response timeout');
        });
    });

    // Handle request errors
    req.on('error', (error) => {
        console.error('Error fetching Full Node block:', error);
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            console.log('Connection error, will retry on next interval');
        }
    });

    // Handle request timeout
    req.setTimeout(10000, () => {
        req.destroy();
        console.error('Full Node request timeout');
    });

    req.write(data);
    req.end();
}

// Modify the polling interval for better stability
const FULL_NODE_POLL_INTERVAL = 3000; // 3 seconds

// Handle client WebSocket connections
wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    wsClients.add(ws);
    
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        wsClients.delete(ws);
    });
});

// Start server
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Starting to monitor Base Sepolia blocks...');
    
    // Start polling for full node data with error handling
    const pollFullNode = () => {
        try {
            getLatestBlock();
        } catch (e) {
            console.error('Error in full node polling:', e);
        }
    };

    // Initial calls
    pollFullNode();
    
    // Set up intervals with error handling
    setInterval(pollFullNode, FULL_NODE_POLL_INTERVAL);
}); 