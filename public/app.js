/* ==========================================================================
   SoundSync — Classic P2P Audio Broadcast (Frontend Logic)
   Clean, functional JavaScript without modern icon/SVG dependencies.
   ========================================================================== */

// ---------- 1. View Router ----------
const views = document.querySelectorAll('.view');
function showView(viewId) {
  views.forEach(v => v.classList.toggle('active', v.id === viewId));
}

document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.back === 'view-landing') {
      cleanupHostSession();
    }
    showView(btn.dataset.back);
  });
});

document.getElementById('btnCreateRoom').addEventListener('click', enterHostRoom);
document.getElementById('btnJoinRoom').addEventListener('click', () => {
  showView('view-join');
  document.getElementById('joinCodeInput').focus();
});

// ---------- Global State ----------
let currentRoomCode = null;
let hostWs = null;
let listenerWs = null;
let hostStream = null;
let hostPeerConnections = new Map(); // id -> { pc, dc }
let listenerPeerConnection = null;
let listenerDataChannel = null;
let listenerId = null;

// Audio Pipeline (Listener)
let audioContext = null;
let delayNode = null;
let gainNode = null;

// WebRTC Configuration (Public Google STUN Servers)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Helper: Get WebSocket Protocol (ws: or wss:)
function getWsProtocol() {
  return location.protocol === 'https:' ? 'wss:' : 'ws:';
}

// Helper: Generate 6-Character Room Code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}


// ==========================================================================
// 2. HOST LOGIC (Broadcasting Audio)
// ==========================================================================

const hostRoomCodeEl = document.getElementById('hostRoomCode');
const listenerCountEl = document.getElementById('listenerCount');
const listenerListEl = document.getElementById('listenerList');
const hostStatusMsg = document.getElementById('hostStatusMsg');
const audioSourceSelect = document.getElementById('audioSourceSelect');
const sourceFileBox = document.getElementById('sourceFileBox');
const sourceUrlBox = document.getElementById('sourceUrlBox');
const hostFileInput = document.getElementById('hostFileInput');
const hostAudioPlayer = document.getElementById('hostAudioPlayer');
const btnStartBroadcast = document.getElementById('btnStartBroadcast');

audioSourceSelect.addEventListener('change', () => {
  const mode = audioSourceSelect.value;
  sourceFileBox.style.display = mode === 'file' ? 'block' : 'none';
  sourceUrlBox.style.display = mode === 'url' ? 'block' : 'none';
});

hostFileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    hostAudioPlayer.src = URL.createObjectURL(e.target.files[0]);
  }
});

function resetBroadcastButton() {
  btnStartBroadcast.disabled = false;
  btnStartBroadcast.textContent = 'Start Broadcast';
}

function enterHostRoom() {
  currentRoomCode = generateRoomCode();
  hostRoomCodeEl.textContent = currentRoomCode;

  // Render QR Code
  const qrCanvas = document.getElementById('qrCanvas');
  const joinUrl = `${location.origin}${location.pathname}?code=${currentRoomCode}`;
  if (window.QRCode) {
    QRCode.toCanvas(qrCanvas, joinUrl, { width: 110, margin: 1 });
  }

  listenerListEl.innerHTML = '<p class="text-muted" style="font-style: italic; color: #777;">No listeners connected yet.</p>';
  listenerCountEl.textContent = '0';
  hostStatusMsg.textContent = '';
  resetBroadcastButton();
  
  showView('view-host');
  connectHostWebSocket(currentRoomCode);
}

// Open WebSocket Connection for Host
function connectHostWebSocket(roomCode) {
  if (hostWs) hostWs.close();
  const wsProto = getWsProtocol();
  hostWs = new WebSocket(`${wsProto}//${location.host}/ws?role=host&room=${roomCode}`);

  hostWs.onopen = () => {
    console.log('[HOST] Connected to signaling server');
  };

  hostWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'listener-join') {
      addListenerItem(msg.id);
      if (hostStream) {
        createPeerConnectionForListener(msg.id, hostStream.getAudioTracks()[0]);
      }
    } else if (msg.type === 'listener-leave') {
      removeListenerItem(msg.id);
      const entry = hostPeerConnections.get(msg.id);
      if (entry) {
        entry.pc.close();
        hostPeerConnections.delete(msg.id);
      }
    } else if (msg.type === 'answer') {
      const entry = hostPeerConnections.get(msg.from);
      if (entry) {
        entry.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
      }
    } else if (msg.type === 'ice-candidate') {
      const entry = hostPeerConnections.get(msg.from);
      if (entry && msg.candidate) {
        entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    }
  };
}

function addListenerItem(id) {
  if (listenerListEl.querySelector('.text-muted')) {
    listenerListEl.innerHTML = '';
  }
  const item = document.createElement('div');
  item.className = 'listener-item';
  item.dataset.id = id;
  item.textContent = `Listener [ID: ${id.slice(0, 5)}]`;
  listenerListEl.appendChild(item);
  listenerCountEl.textContent = listenerListEl.children.length;
}

function removeListenerItem(id) {
  const item = listenerListEl.querySelector(`[data-id="${id}"]`);
  if (item) item.remove();
  listenerCountEl.textContent = listenerListEl.children.length;
  if (listenerListEl.children.length === 0) {
    listenerListEl.innerHTML = '<p class="text-muted" style="font-style: italic; color: #777;">No listeners connected yet.</p>';
  }
}

// Host Audio Stream Capture Handler
async function getHostAudioStream(mode) {
  if (mode === 'tab') {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      throw new Error('Tab capture requires desktop browser. Select Microphone or Audio File on mobile/TV.');
    }
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false }
    });
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach(t => t.stop());
      throw new Error('No audio was shared. Please check "Share tab audio".');
    }
    displayStream.getVideoTracks().forEach(t => t.stop());
    return new MediaStream(audioTracks);
  }

  if (mode === 'mic') {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  }

  if (mode === 'file' || mode === 'url') {
    if (mode === 'url') {
      const url = document.getElementById('hostUrlInput').value.trim();
      if (!url) throw new Error('Please enter an audio stream URL.');
      hostAudioPlayer.src = url;
    }
    if (!hostAudioPlayer.src) throw new Error('Please choose an audio file first.');
    await hostAudioPlayer.play();

    const hostAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const sourceNode = hostAudioCtx.createMediaElementSource(hostAudioPlayer);
    const destNode = hostAudioCtx.createMediaStreamDestination();
    sourceNode.connect(destNode);
    sourceNode.connect(hostAudioCtx.destination);
    return destNode.stream;
  }
}

// Start Broadcast Button Handler
btnStartBroadcast.addEventListener('click', async () => {
  hostStatusMsg.textContent = '';
  const mode = audioSourceSelect.value;

  try {
    hostStream = await getHostAudioStream(mode);
    const audioTrack = hostStream.getAudioTracks()[0];

    btnStartBroadcast.disabled = true;
    btnStartBroadcast.textContent = '[Broadcasting Live...]';
    hostStatusMsg.textContent = 'Broadcast active. Audio is now transmitting to listeners.';

    const listenerItems = listenerListEl.querySelectorAll('[data-id]');
    listenerItems.forEach(item => {
      createPeerConnectionForListener(item.dataset.id, audioTrack);
    });

    startNtpSyncPing();

  } catch (err) {
    hostStatusMsg.textContent = 'Error: ' + err.message;
  }
});

// Create RTCPeerConnection for a Listener
async function createPeerConnectionForListener(listenerId, audioTrack) {
  const pc = new RTCPeerConnection(rtcConfig);
  const dc = pc.createDataChannel('sync', { ordered: true });

  hostPeerConnections.set(listenerId, { pc, dc });
  pc.addTrack(audioTrack, hostStream);

  pc.onicecandidate = (e) => {
    if (e.candidate && hostWs && hostWs.readyState === WebSocket.OPEN) {
      hostWs.send(JSON.stringify({
        type: 'ice-candidate',
        id: listenerId,
        candidate: e.candidate
      }));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify({
      type: 'offer',
      id: listenerId,
      offer: offer
    }));
  }
}

// NTP Ping Interval (Host -> Listener)
let syncInterval = null;
function startNtpSyncPing() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of hostPeerConnections.entries()) {
      if (entry.dc && entry.dc.readyState === 'open') {
        entry.dc.send(JSON.stringify({ type: 'ping', hostTime: now }));
      }
    }
  }, 3000);
}

// Copy Code Button
const btnCopyCode = document.getElementById('btnCopyCode');
btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(currentRoomCode);
  btnCopyCode.textContent = 'Copied!';
  setTimeout(() => {
    btnCopyCode.textContent = 'Copy Room Code';
  }, 1400);
});

function cleanupHostSession() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (hostStream) {
    hostStream.getTracks().forEach(t => t.stop());
    hostStream = null;
  }
  for (const entry of hostPeerConnections.values()) {
    if (entry.pc) entry.pc.close();
  }
  hostPeerConnections.clear();
  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify({ type: 'host-cancel' }));
    hostWs.close();
    hostWs = null;
  }
}

// End Room Button
document.getElementById('btnEndRoom').addEventListener('click', () => {
  if (confirm('Are you sure you want to end this broadcast room?')) {
    cleanupHostSession();
    showView('view-landing');
  }
});


// ==========================================================================
// 3. LISTENER LOGIC (Receiving & Playing Audio)
// ==========================================================================

const joinCodeInput = document.getElementById('joinCodeInput');
const btnConnectListener = document.getElementById('btnConnectListener');
const joinStatusMsg = document.getElementById('joinStatusMsg');
const listenerConnectedBox = document.getElementById('listenerConnectedBox');
const btnUnmuteAudio = document.getElementById('btnUnmuteAudio');

joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    btnConnectListener.click();
  }
});

btnConnectListener.addEventListener('click', () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== 6) {
    joinStatusMsg.textContent = 'Please enter a valid 6-character room code.';
    return;
  }
  connectListenerRoom(code);
});

function connectListenerRoom(code) {
  joinStatusMsg.textContent = 'Connecting to room...';
  if (listenerWs) listenerWs.close();

  const wsProto = getWsProtocol();
  listenerWs = new WebSocket(`${wsProto}//${location.host}/ws?role=listener&room=${code}`);

  listenerWs.onopen = () => {
    console.log('[LISTENER] Connected to signaling server');
  };

  listenerWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'error') {
      joinStatusMsg.textContent = msg.message;
      return;
    }

    if (msg.type === 'welcome') {
      listenerId = msg.id;
      joinStatusMsg.textContent = '';
      listenerConnectedBox.style.display = 'block';
    } else if (msg.type === 'offer') {
      handleHostOffer(msg.offer);
    } else if (msg.type === 'ice-candidate') {
      if (listenerPeerConnection && msg.candidate) {
        listenerPeerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    } else if (msg.type === 'host-disconnected') {
      document.getElementById('listenerStateTitle').textContent = 'Host Disconnected';
      document.getElementById('listenerStateSub').textContent = 'The host has ended this broadcast session.';
      setTimeout(() => showView('view-landing'), 2000);
    }
  };
}

// Handle WebRTC Offer from Host
async function handleHostOffer(offer) {
  if (!listenerPeerConnection) {
    listenerPeerConnection = new RTCPeerConnection(rtcConfig);

    listenerPeerConnection.ondatachannel = (e) => {
      listenerDataChannel = e.channel;
      listenerDataChannel.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'ping') {
          if (listenerDataChannel.readyState === 'open') {
            listenerDataChannel.send(JSON.stringify({ type: 'pong', hostTime: msg.hostTime }));
          }
        }
      };
    };

    listenerPeerConnection.ontrack = (e) => {
      console.log('[LISTENER] Received remote audio track');
      const stream = e.streams[0] || new MediaStream([e.track]);

      const listenerAudioEl = document.getElementById('listenerAudioElement');
      if (listenerAudioEl) {
        listenerAudioEl.srcObject = stream;
        listenerAudioEl.muted = true;
        listenerAudioEl.play().catch(() => {
          btnUnmuteAudio.style.display = 'block';
        });
      }

      setupAudioPipeline(stream);

      document.getElementById('listenerStateTitle').textContent = 'Audio Streaming Live';
      document.getElementById('listenerStateSub').textContent = 'Playing broadcast in real-time.';
    };

    listenerPeerConnection.onicecandidate = (e) => {
      if (e.candidate && listenerWs && listenerWs.readyState === WebSocket.OPEN) {
        listenerWs.send(JSON.stringify({
          type: 'ice-candidate',
          candidate: e.candidate
        }));
      }
    };
  }

  await listenerPeerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await listenerPeerConnection.createAnswer();
  await listenerPeerConnection.setLocalDescription(answer);

  if (listenerWs && listenerWs.readyState === WebSocket.OPEN) {
    listenerWs.send(JSON.stringify({ type: 'answer', answer: answer }));
  }
}

// Setup Listener Web Audio API Pipeline
function setupAudioPipeline(stream) {
  if (audioContext) audioContext.close().catch(() => {});

  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioCtxClass({ latencyHint: 'interactive' });
  
  const source = audioContext.createMediaStreamSource(stream);
  delayNode = audioContext.createDelay(1.0);
  delayNode.delayTime.value = 0.035; // 35ms low latency buffer

  gainNode = audioContext.createGain();
  gainNode.gain.value = document.getElementById('volumeSlider').value / 100;

  source.connect(delayNode);
  delayNode.connect(gainNode);
  gainNode.connect(audioContext.destination);

  if (audioContext.state === 'suspended') {
    btnUnmuteAudio.style.display = 'block';
  }
}

// Autoplay Unlock Handler
function unlockAudio() {
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume();
  }
  const el = document.getElementById('listenerAudioElement');
  if (el) el.play().catch(() => {});
  btnUnmuteAudio.style.display = 'none';
}

btnUnmuteAudio.addEventListener('click', unlockAudio);
['touchstart', 'click'].forEach(evt => {
  document.addEventListener(evt, () => {
    if (document.getElementById('view-join').classList.contains('active')) {
      unlockAudio();
    }
  }, { passive: true });
});

// Re-Sync Button
const btnResyncAudio = document.getElementById('btnResyncAudio');
btnResyncAudio.addEventListener('click', () => {
  unlockAudio();
  btnResyncAudio.textContent = 'Synced!';
  setTimeout(() => {
    btnResyncAudio.textContent = 'Re-Sync Audio';
  }, 1400);
});

// Volume Slider
document.getElementById('volumeSlider').addEventListener('input', (e) => {
  const vol = e.target.value / 100;
  document.getElementById('volumeValue').textContent = `${e.target.value}%`;
  if (gainNode) gainNode.gain.value = vol;
});

// Exit Button
document.getElementById('btnExitParty').addEventListener('click', () => {
  if (listenerPeerConnection) listenerPeerConnection.close();
  if (listenerWs) listenerWs.close();
  showView('view-landing');
});

// Check URL query parameters for direct QR deep links (?code=ABC123)
(function checkUrlDeepLink() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code && code.length === 6) {
    showView('view-join');
    joinCodeInput.value = code.toUpperCase();
    connectListenerRoom(code.toUpperCase());
  }
})();
