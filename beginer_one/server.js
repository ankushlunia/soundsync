/* ==========================================================================
   SoundSync — Beginner Edition (Signaling Server)
   
   WHAT THIS FILE DOES:
   1. Serves the static web files in the /public directory via Express.
   2. Listens for WebSocket connections on the /ws path.
   3. Manages multiple rooms using a simple JavaScript Map.
   4. Relays WebRTC signaling messages (offers, answers, ICE candidates)
      between the Host and Listeners in the same room.
   ========================================================================== */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Serve frontend static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Handle WebSocket upgrade requests on /ws
server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/ws')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ---------- Room State ----------
// Storage for all active rooms:
// Map<roomCode, { host: ws, listeners: Map<id, ws>, memberInfo: Map<id, {name, avatar}> }>
const rooms = new Map();

// Helper: send JSON object to a WebSocket client safely
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Helper: broadcast room status to host and all listeners
function broadcastRoomStatus(room) {
  const status = {
    type: 'status',
    hostConnected: !!room.host,
    listenerCount: room.listeners.size
  };
  send(room.host, status);
  for (const ws of room.listeners.values()) {
    send(ws, status);
  }
}

// Helper: broadcast members list to everyone in room
function broadcastMembers(room) {
  const members = Array.from(room.memberInfo.entries()).map(([id, info]) => ({
    id,
    name: info.name,
    avatar: info.avatar
  }));

  send(room.host, { type: 'members-update', members });
  for (const ws of room.listeners.values()) {
    send(ws, { type: 'members-update', members });
  }
}

// ---------- WebSocket Connection Handler ----------
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role'); // 'host' or 'listener'
  const roomCode = url.searchParams.get('room'); // e.g. 'ABC123'

  if (!roomCode || roomCode.length < 4) {
    send(ws, { type: 'error', message: 'Invalid room code' });
    ws.close();
    return;
  }

  // --- HOST CLIENT ---
  if (role === 'host') {
    let room = rooms.get(roomCode);
    if (!room) {
      room = {
        host: ws,
        listeners: new Map(),
        memberInfo: new Map(),
        createdAt: Date.now()
      };
      rooms.set(roomCode, room);
    } else {
      room.host = ws;
    }

    console.log(`[SERVER] Host created/joined room ${roomCode}`);

    // Inform host of any existing listeners
    for (const id of room.listeners.keys()) {
      send(ws, { type: 'listener-join', id });
    }
    broadcastRoomStatus(room);

    // Messages from Host
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // Host cancels/ends room
      if (msg.type === 'host-cancel') {
        for (const lWs of room.listeners.values()) {
          send(lWs, { type: 'host-disconnected' });
        }
        rooms.delete(roomCode);
        return;
      }

      // Relay WebRTC Offer or ICE candidate to targeted listener
      if (msg.type === 'offer' || msg.type === 'ice-candidate') {
        const targetListener = room.listeners.get(msg.id);
        if (targetListener) {
          msg.from = 'host';
          send(targetListener, msg);
        }
      }
    });

    ws.on('close', () => {
      console.log(`[SERVER] Host left room ${roomCode}`);
      const r = rooms.get(roomCode);
      if (r && r.host === ws) {
        for (const lWs of r.listeners.values()) {
          send(lWs, { type: 'host-disconnected' });
        }
        rooms.delete(roomCode);
      }
    });

  } else {
    // --- LISTENER CLIENT ---
    const room = rooms.get(roomCode);
    if (!room) {
      send(ws, { type: 'error', message: 'Room not found. Please check the code.' });
      ws.close();
      return;
    }

    const listenerId = crypto.randomUUID();
    room.listeners.set(listenerId, ws);

    send(ws, { type: 'welcome', id: listenerId, roomCode });
    console.log(`[SERVER] Listener ${listenerId} joined room ${roomCode}`);

    if (room.host) {
      send(room.host, { type: 'listener-join', id: listenerId });
    }
    broadcastRoomStatus(room);

    // Messages from Listener
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      const currentRoom = rooms.get(roomCode);
      if (!currentRoom) return;

      // Relay Answer or ICE Candidate to Host
      if (msg.type === 'answer' || msg.type === 'ice-candidate') {
        msg.from = listenerId;
        send(currentRoom.host, msg);
      } else if (msg.type === 'member-info') {
        currentRoom.memberInfo.set(listenerId, { name: msg.name, avatar: msg.avatar });
        broadcastMembers(currentRoom);
      }
    });

    ws.on('close', () => {
      const currentRoom = rooms.get(roomCode);
      if (!currentRoom) return;
      currentRoom.listeners.delete(listenerId);
      currentRoom.memberInfo.delete(listenerId);
      console.log(`[SERVER] Listener ${listenerId} left room ${roomCode}`);

      if (currentRoom.host) {
        send(currentRoom.host, { type: 'listener-leave', id: listenerId });
      }
      broadcastMembers(currentRoom);
      broadcastRoomStatus(currentRoom);
    });
  }

  ws.on('error', (err) => console.error('[SERVER ERROR]', err.message));
});

// Helper: Get local network IP addresses
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const ips = getLocalIPs();
  console.log(`\n==================================================`);
  console.log(`  SoundSync Beginner Edition Server Running!`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  if (ips.length) {
    console.log(`  WiFi Network URL: http://${ips[0]}:${PORT}`);
  }
  console.log(`==================================================\n`);
});
