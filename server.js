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
const PUBLIC_ROOMS = ['lounge', ‘lan-party’, ’ai-studio’, ‘gaming-fps', 'gaming-moba', 'gaming-rts'];

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

// TURN credentials endpoint - generates temporary credentials
app.get('/api/turn-credentials', async (req, res) => {
  // Verify access code before providing TURN credentials
  const code = req.query.code || req.headers['x-access-code'];
  if (code !== currentAccessCode) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
  }
  
  try {
    const METERED_API_KEY = process.env.METERED_API_KEY || '76214b4b535deb3fcbd21125c5a722a21952';
    
    // Fetch temporary credentials from Metered.ca
    const response = await fetch(
      `https://zzz.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch TURN credentials from Metered.ca');
    }
    
    const credentials = await response.json();
    
    // Return ICE servers in the format WebRTC expects
    res.json({ iceServers: credentials });
  } catch (error) {
    console.error('Error fetching TURN credentials:', error);
    // Return basic STUN servers as fallback
    res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
  }
});

// Access code verification endpoint
let currentAccessCode = process.env.ACCESS_CODE || 'CLAN2026';

app.get('/api/verify-code', (req, res) => {
  const code = req.query.code;
  res.json({ valid: code === currentAccessCode });
});

// Admin password verification (password never sent to client)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RA5ZC8erQ5hK';

app.post('/api/admin/verify', express.json(), (req, res) => {
  const { password } = req.body;
  res.json({ valid: password === ADMIN_PASSWORD });
});

// Get current access code (admin only)
app.post('/api/admin/get-code', express.json(), (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ code: currentAccessCode });
});

// Change access code (admin only)
app.post('/api/admin/change-code', express.json(), (req, res) => {
  const { password, newCode } = req.body;
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!newCode || newCode.length < 4) {
    return res.status(400).json({ error: 'Code must be at least 4 characters' });
  }
  
  currentAccessCode = newCode;
  console.log(`Access code changed to: ${newCode}`);
  res.json({ success: true, code: currentAccessCode });
});

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
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
  
  // If userId already exists (reconnect), broadcast leave for old entry so others clean up
  if (room.has(userId)) {
    broadcast(roomId, { type: 'user-left', userId }, userId);
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
