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

let hostSocket = null;
const listeners = new Map(); // id -> ws
const memberInfo = new Map(); // id -> {name, avatar}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastStatus() {
  const status = { type: 'status', hostConnected: !!hostSocket, listenerCount: listeners.size };
  send(hostSocket, status);
  for (const ws of listeners.values()) send(ws, status);
}

function broadcastMembersList() {
  // Send current members list to all connected users
  const members = Array.from(memberInfo.entries()).map(([id, info]) => ({
    id,
    name: info.name,
    avatar: info.avatar
  }));
  
  send(hostSocket, { type: 'members-update', members });
  for (const ws of listeners.values()) {
    send(ws, { type: 'members-update', members });
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');

  if (role === 'host') {
    hostSocket = ws;
    console.log('Host connected.');
    for (const id of listeners.keys()) {
      send(hostSocket, { type: 'listener-join', id });
    }
    broadcastStatus();

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      
      // Host cancel party
      if (msg.type === 'host-cancel') {
        for (const listenerWs of listeners.values()) {
          send(listenerWs, { type: 'host-disconnected' });
        }
        listeners.clear();
        return;
      }
      
      // WebRTC signaling: forward to specific listener
      if (msg.type === 'offer' || msg.type === 'ice-candidate') {
        const target = listeners.get(msg.id);
        if (target) {
          // Add sender info for listener
          msg.from = 'host';
          send(target, msg);
        }
      } else {
        // Other messages
        const target = listeners.get(msg.id);
        if (target) send(target, msg);
      }
    });

    ws.on('close', () => {
      console.log('Host disconnected.');
      if (hostSocket === ws) {
        // Notify all listeners that host has disconnected
        for (const listenerWs of listeners.values()) {
          send(listenerWs, { type: 'host-disconnected' });
        }
        hostSocket = null;
        listeners.clear(); // Clear all listeners when host disconnects
        memberInfo.clear(); // Clear member info
      }
      broadcastStatus();
    });

  } else {
    const id = crypto.randomUUID();
    listeners.set(id, ws);
    send(ws, { type: 'welcome', id });
    console.log(`Listener ${id} connected. Total: ${listeners.size}`);

    if (hostSocket) send(hostSocket, { type: 'listener-join', id });
    broadcastStatus();

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      
      // WebRTC signaling: forward to host with sender ID
      if (msg.type === 'answer' || msg.type === 'ice-candidate') {
        msg.from = id;
        send(hostSocket, msg);
      } else if (msg.type === 'member-info') {
        // Store member info and broadcast to all
        memberInfo.set(id, { name: msg.name, avatar: msg.avatar });
        // Broadcast to host
        if (hostSocket) send(hostSocket, { type: 'member-info', id, name: msg.name, avatar: msg.avatar });
        // Broadcast to all listeners
        broadcastMembersList();
      } else {
        // Other messages
        msg.id = id;
        send(hostSocket, msg);
      }
    });

    ws.on('close', () => {
      listeners.delete(id);
      memberInfo.delete(id);
      console.log(`Listener ${id} disconnected. Total: ${listeners.size}`);
      if (hostSocket) send(hostSocket, { type: 'listener-leave', id });
      broadcastMembersList();
      broadcastStatus();
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
  console.log(`  http://localhost:${PORT}/host.html`);
  if (ips.length) {
    console.log('\nOn LISTENER phones (same WiFi), open one of:');
    ips.forEach((ip) => console.log(`  http://${ip}:${PORT}/client.html`));
  } else {
    console.log('\nCould not detect a local network IP. Run `ipconfig` / `ifconfig` to find it manually.');
  }
  console.log('');
});
