const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients and rooms
const rooms = new Map();

// Public rooms that we track
const PUBLIC_ROOMS = ['lounge', 'counter-strike', 'league-of-legends', 'empire-earth'];

// Broadcast room counts to all waiting clients
function broadcastRoomCounts() {
  const counts = {};
  PUBLIC_ROOMS.forEach(roomId => {
    const room = rooms.get(roomId);
    counts[roomId] = room ? room.size : 0;
  });
  
  // Broadcast to all clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && !client.roomId) {
      // Only send to clients not yet in a room (on lobby page)
      client.send(JSON.stringify({
        type: 'room-counts',
        counts: counts
      }));
    }
  });
}

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint for Fly.io
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch(data.type) {
        case 'join':
          handleJoin(ws, data);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleSignaling(ws, data);
          break;
        case 'leave':
          handleLeave(ws);
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });
  
  ws.on('close', () => {
    handleLeave(ws);
    console.log('Client disconnected');
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
  
  // Send initial room counts
  broadcastRoomCounts();
});

// Heartbeat to detect broken connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleLeave(ws);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

function handleJoin(ws, data) {
  const { roomId, userId, username } = data;
  
  ws.roomId = roomId;
  ws.userId = userId;
  ws.username = username;
  
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  
  const room = rooms.get(roomId);
  
  // If userId already exists in room (reconnect case), clean up old entry
  if (room.has(userId)) {
    const oldWs = room.get(userId);
    if (oldWs !== ws) {
      oldWs.roomId = null;
      oldWs.userId = null;
      if (oldWs.readyState === WebSocket.OPEN) {
        oldWs.close();
      }
    }
  }
  
  room.set(userId, ws);
  
  // Notify others in the room
  const userList = Array.from(room.entries())
    .filter(([id]) => id !== userId)
    .map(([id, client]) => ({ id, username: client.username }));
  
  // Send existing users to new client
  ws.send(JSON.stringify({
    type: 'users',
    users: userList
  }));
  
  // Notify existing users about new client
  broadcast(roomId, {
    type: 'user-joined',
    userId,
    username
  }, userId);
  
  console.log(`Room ${roomId}: ${room.size} users`);
  
  // Broadcast updated room counts if it's a public room
  if (PUBLIC_ROOMS.includes(roomId)) {
    broadcastRoomCounts();
  }
}

function handleSignaling(ws, data) {
  const { targetId } = data;
  const room = rooms.get(ws.roomId);
  
  if (room && room.has(targetId)) {
    const targetWs = room.get(targetId);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(JSON.stringify({
        ...data,
        senderId: ws.userId
      }));
    }
  }
}

function handleLeave(ws) {
  if (ws.roomId && ws.userId) {
    const room = rooms.get(ws.roomId);
    if (room) {
      room.delete(ws.userId);
      
      console.log(`Room: ${room.size} users remaining`);
      
      if (room.size === 0) {
        rooms.delete(ws.roomId);
        console.log(`Room deleted (empty)`);
      } else {
        broadcast(ws.roomId, {
          type: 'user-left',
          userId: ws.userId
        });
      }
      
      // Broadcast updated room counts if it was a public room
      if (PUBLIC_ROOMS.includes(ws.roomId)) {
        broadcastRoomCounts();
      }
    }
  }
}

function broadcast(roomId, message, excludeUserId = null) {
  const room = rooms.get(roomId);
  if (room) {
    room.forEach((client, userId) => {
      if (userId !== excludeUserId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Voice chat server running on port ${PORT}`);
  console.log(`Active rooms: ${rooms.size}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
