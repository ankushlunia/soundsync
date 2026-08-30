const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.static(path.join(__dirname, 'public')));

// Handle WebSocket upgrade requests on /ws path
server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/ws')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ---------- Multi-room state ----------
// rooms: Map<roomCode, { host: ws, listeners: Map<id, ws>, memberInfo: Map<id, {name, avatar}>, createdAt: number }>
const rooms = new Map();

const ROOM_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getRoom(roomCode) {
  return rooms.get(roomCode);
}

function createRoom(roomCode, hostWs) {
  const room = {
    host: hostWs,
    listeners: new Map(),
    memberInfo: new Map(),
    createdAt: Date.now(),
  };
  rooms.set(roomCode, room);
  return room;
}

function destroyRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) {
    // Notify all listeners
    for (const listenerWs of room.listeners.values()) {
      send(listenerWs, { type: 'host-disconnected' });
    }
    room.listeners.clear();
    room.memberInfo.clear();
    rooms.delete(roomCode);
    console.log(`Room ${roomCode} destroyed. Active rooms: ${rooms.size}`);
  }
}

function broadcastStatus(room) {
  const status = { type: 'status', hostConnected: !!room.host, listenerCount: room.listeners.size };
  send(room.host, status);
  for (const ws of room.listeners.values()) send(ws, status);
}

function broadcastMembersList(room) {
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

// ---------- Room expiry cleanup (every 30 minutes) ----------
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_EXPIRY_MS) {
      console.log(`Room ${code} expired after 4 hours.`);
      destroyRoom(code);
    }
  }
}, 30 * 60 * 1000);

// ---------- WebSocket connection handling ----------
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');
  const roomCode = url.searchParams.get('room');

  if (!roomCode || roomCode.length < 4) {
    send(ws, { type: 'error', message: 'Invalid room code' });
    ws.close();
    return;
  }

  if (role === 'host') {
    // If room already exists with an active host, reject
    const existing = getRoom(roomCode);
    if (existing && existing.host && existing.host.readyState === WebSocket.OPEN) {
      send(ws, { type: 'error', message: 'Room already has a host' });
      ws.close();
      return;
    }

    // Create or reclaim room
    const room = existing || createRoom(roomCode, ws);
    room.host = ws;
    if (!existing) rooms.set(roomCode, room);
    console.log(`Host connected to room ${roomCode}. Active rooms: ${rooms.size}`);

    // Inform host of existing listeners
    for (const id of room.listeners.keys()) {
      send(ws, { type: 'listener-join', id });
    }
    // Send existing member info
    for (const [id, info] of room.memberInfo.entries()) {
      send(ws, { type: 'member-info', id, name: info.name, avatar: info.avatar });
    }
    broadcastStatus(room);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // Host cancel party
      if (msg.type === 'host-cancel') {
        destroyRoom(roomCode);
        return;
      }

      // WebRTC signaling: forward to specific listener
      if (msg.type === 'offer' || msg.type === 'ice-candidate') {
        const target = room.listeners.get(msg.id);
        if (target) {
          msg.from = 'host';
          send(target, msg);
        }
      } else {
        // Other messages (including sync messages) — forward to specific listener
        if (msg.id) {
          const target = room.listeners.get(msg.id);
          if (target) send(target, msg);
        } else if (msg.type === 'sync-config') {
          // Broadcast sync config to all listeners
          for (const listenerWs of room.listeners.values()) {
            send(listenerWs, msg);
          }
        }
      }
    });

    ws.on('close', () => {
      console.log(`Host disconnected from room ${roomCode}.`);
      const r = getRoom(roomCode);
      if (r && r.host === ws) {
        destroyRoom(roomCode);
      }
    });

  } else {
    // Listener joining
    const room = getRoom(roomCode);
    if (!room) {
      send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
      ws.close();
      return;
    }

    const id = crypto.randomUUID();
    room.listeners.set(id, ws);
    send(ws, { type: 'welcome', id, roomCode });
    console.log(`Listener ${id} joined room ${roomCode}. Listeners: ${room.listeners.size}`);

    if (room.host) send(room.host, { type: 'listener-join', id });
    broadcastStatus(room);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      const currentRoom = getRoom(roomCode);
      if (!currentRoom) return;

      // WebRTC signaling: forward to host with sender ID
      if (msg.type === 'answer' || msg.type === 'ice-candidate') {
        msg.from = id;
        send(currentRoom.host, msg);
      } else if (msg.type === 'member-info') {
        // Store member info and broadcast to all
        currentRoom.memberInfo.set(id, { name: msg.name, avatar: msg.avatar });
        if (currentRoom.host) send(currentRoom.host, { type: 'member-info', id, name: msg.name, avatar: msg.avatar });
        broadcastMembersList(currentRoom);
      } else if (msg.type === 'pong') {
        // Sync pong — forward to host with sender ID
        msg.from = id;
        send(currentRoom.host, msg);
      } else {
        // Other messages
        msg.id = id;
        send(currentRoom.host, msg);
      }
    });

    ws.on('close', () => {
      const currentRoom = getRoom(roomCode);
      if (!currentRoom) return;
      currentRoom.listeners.delete(id);
      currentRoom.memberInfo.delete(id);
      console.log(`Listener ${id} left room ${roomCode}. Listeners: ${currentRoom.listeners.size}`);
      if (currentRoom.host) send(currentRoom.host, { type: 'listener-leave', id });
      broadcastMembersList(currentRoom);
      broadcastStatus(currentRoom);
    });
  }

  ws.on('error', (err) => console.error('WS error:', err.message));
});

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
  console.log(`\nSoundSync running on port ${PORT}\n`);
  console.log('On the HOST device, open:');
  console.log(`  http://localhost:${PORT}`);
  if (ips.length) {
    console.log('\nOn LISTENER phones (same WiFi), open one of:');
    ips.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
  } else {
    console.log('\nCould not detect a local network IP. Run `ipconfig` / `ifconfig` to find it manually.');
  }
  console.log('');
});
