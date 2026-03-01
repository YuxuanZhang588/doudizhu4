#!/bin/bash
# Test script to start server and verify it's working

cd /home/david/clawd/projects/doudizhu4

# Kill any existing server
pkill -9 -f "server.py.*8099" 2>/dev/null
sleep 1

# Start server in background
nohup python3 server.py --host 0.0.0.0 --port 8099 > server.log 2>&1 &
SERVER_PID=$!

# Wait for server to start
sleep 3

# Check if server is running
if kill -0 $SERVER_PID 2>/dev/null; then
    echo "Server started successfully with PID: $SERVER_PID"
    echo "Checking health endpoint..."
    curl -s http://localhost:8099/api/health | python3 -m json.tool || echo "Health check failed"
    echo ""
    echo "Server log (last 20 lines):"
    tail -20 server.log
else
    echo "Server failed to start"
    cat server.log
    exit 1
fi
