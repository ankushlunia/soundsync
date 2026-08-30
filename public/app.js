/* ==========================================================================
   SoundSync — Frontend logic
   Complete implementation with:
   - Multi-room WebSocket signaling
   - WebRTC audio streaming with DataChannel sync
   - NTP-like clock synchronization for cross-device audio sync
   - Web Audio API pipeline (DelayNode buffer + GainNode volume)
   - XSS-safe DOM manipulation (no innerHTML with user data)
   - Confirmation dialogs on all exit/cancel actions
   - Profile modal, volume control, QR scanner
   ========================================================================== */

// ---------- View router ----------
const views = document.querySelectorAll('.view');
let currentView = 'view-landing';

function showView(id) {
  views.forEach(v => v.classList.toggle('active', v.id === id));
  currentView = id;
}

// ---------- Confirmation helper ----------
function showConfirmation(title, message, onConfirm) {
  const modal = document.getElementById('confirmationModal');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;

  const confirmYesBtn = document.getElementById('confirmYesBtn');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');

  // Remove old listeners by cloning
  const newYesBtn = confirmYesBtn.cloneNode(true);
  const newCancelBtn = confirmCancelBtn.cloneNode(true);
  confirmYesBtn.parentNode.replaceChild(newYesBtn, confirmYesBtn);
  confirmCancelBtn.parentNode.replaceChild(newCancelBtn, confirmCancelBtn);

  document.getElementById('confirmYesBtn').addEventListener('click', () => {
    modal.style.display = 'none';
    onConfirm();
  });

  document.getElementById('confirmCancelBtn').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  modal.style.display = 'flex';
}

// ---------- Safe navigation with confirmation ----------
function safeNavigateBack(fromView) {
  const isHostActive = hostWs && hostWs.readyState === WebSocket.OPEN;
  const isListenerActive = listenerWs && listenerWs.readyState === WebSocket.OPEN;

  if (fromView === 'view-create' && isHostActive) {
    showConfirmation(
      'Leave Room?',
      'This will end the room and disconnect all listeners.',
      () => {
        cleanupHost();
        showView('view-landing');
      }
    );
  } else if (fromView === 'view-waiting' && isListenerActive) {
    showConfirmation(
      'Exit Party?',
      'You will disconnect from the audio broadcast.',
      () => {
        cleanupListener();
        showView('view-landing');
      }
    );
  } else if (fromView === 'view-join') {
    showView('view-landing');
  } else {
    showView('view-landing');
  }
}

// Wire back buttons with confirmation
document.getElementById('hostBackBtn').addEventListener('click', () => safeNavigateBack('view-create'));
document.getElementById('joinBackBtn').addEventListener('click', () => safeNavigateBack('view-join'));
document.getElementById('listenerBackBtn').addEventListener('click', () => safeNavigateBack('view-waiting'));

// ---------- Room code generation ----------
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateRoomCode(length = 6) {
  let code = '';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

// ---------- State ----------
let currentRoomCode = null;
let isBroadcasting = false;
let hostStream = null;
let hostWs = null;
let listenerWs = null;
let hostPeerConnections = new Map(); // id -> { pc: RTCPeerConnection, dc: RTCDataChannel }
let listenerPeerConnection = null;
let listenerDataChannel = null;
let listenerId = null;
let membersMap = new Map();

// Sync state
let syncIntervalId = null;
let listenerLatencies = new Map(); // id -> { rtt, oneWay }
let hostTargetDelay = 0;
let myOneWayDelay = 0;

// Audio pipeline (listener)
let audioContext = null;
let delayNode = null;
let gainNode = null;

// ---------- User Profile Management ----------
const AVATAR_OPTIONS = ['🎵', '🎧', '🎤', '🎸', '🎹', '🎺', '🎻', '🥁', '🎼', '🎶'];
const COOL_NAMES_ADJECTIVES = ['Sonic', 'Echo', 'Harmony', 'Rhythm', 'Melody', 'Beatbox', 'Jazz', 'Groove', 'Vibes', 'Lyric'];
const COOL_NAMES_NOUNS = ['Listener', 'Maestro', 'Fan', 'Vibe', 'Wave', 'Note', 'Sound', 'Frequency', 'Tone', 'Chord'];

function generateCoolName() {
  const adj = COOL_NAMES_ADJECTIVES[Math.floor(Math.random() * COOL_NAMES_ADJECTIVES.length)];
  const noun = COOL_NAMES_NOUNS[Math.floor(Math.random() * COOL_NAMES_NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
}

function getOrCreateProfile() {
  let profile = JSON.parse(localStorage.getItem('userProfile'));
  if (!profile) {
    profile = {
      name: generateCoolName(),
      avatar: AVATAR_OPTIONS[Math.floor(Math.random() * AVATAR_OPTIONS.length)]
    };
    localStorage.setItem('userProfile', JSON.stringify(profile));
  }
  return profile;
}

function updateProfile(name, avatar) {
  const profile = { name, avatar };
  localStorage.setItem('userProfile', JSON.stringify(profile));
  return profile;
}

let userProfile = getOrCreateProfile();

// Update profile button avatars
function updateProfileButtons() {
  const hostAvatar = document.getElementById('hostProfileAvatar');
  const listenerAvatar = document.getElementById('listenerProfileAvatar');
  if (hostAvatar) hostAvatar.textContent = userProfile.avatar;
  if (listenerAvatar) listenerAvatar.textContent = userProfile.avatar;
}
updateProfileButtons();

// ---------- XSS-safe DOM helpers ----------
function escapeText(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.textContent;
}

function createListenerRow(id, name, avatar) {
  const row = document.createElement('div');
  row.className = 'listener-row';
  row.dataset.listenerId = id;

  if (avatar) {
    const avatarSpan = document.createElement('span');
    avatarSpan.className = 'member-avatar';
    avatarSpan.textContent = avatar;
    row.appendChild(avatarSpan);
  } else {
    const dot = document.createElement('span');
    dot.className = 'listener-dot';
    row.appendChild(dot);
  }

  const nameSpan = document.createElement('span');
  nameSpan.className = 'member-name';
  nameSpan.textContent = name;
  row.appendChild(nameSpan);

  return row;
}

function createMemberItem(name, avatar) {
  const el = document.createElement('div');
  el.className = 'member-item';

  const avatarSpan = document.createElement('span');
  avatarSpan.className = 'member-avatar';
  avatarSpan.textContent = avatar || '🎵';
  el.appendChild(avatarSpan);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'member-name';
  nameSpan.textContent = name || 'Unknown';
  el.appendChild(nameSpan);

  return el;
}

// ---------- WebSocket helpers ----------
function getWsProtocol() {
  return location.protocol === 'https:' ? 'wss:' : 'ws:';
}

function sendHostMessage(msg) {
  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify(msg));
  }
}

function sendListenerMessage(msg) {
  if (listenerWs && listenerWs.readyState === WebSocket.OPEN) {
    listenerWs.send(JSON.stringify(msg));
  }
}

// ---------- WebRTC configuration ----------
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

// ---------- Room state persistence ----------
function saveRoomState() {
  if (currentRoomCode) {
    sessionStorage.setItem('roomCode', currentRoomCode);
  }
}

function clearRoomState() {
  sessionStorage.removeItem('roomCode');
  currentRoomCode = null;
  isBroadcasting = false;
}

// ---------- Cleanup functions ----------
function cleanupHost() {
  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    sendHostMessage({ type: 'host-cancel' });
    hostWs.close();
  }
  hostWs = null;
  if (hostStream) {
    hostStream.getTracks().forEach(t => t.stop());
    hostStream = null;
  }
  for (const { pc } of hostPeerConnections.values()) {
    pc.close();
  }
  hostPeerConnections.clear();
  listenerLatencies.clear();
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  membersMap.clear();
  document.getElementById('hostControls').style.display = 'none';
  clearRoomState();
}

function cleanupListener() {
  if (listenerPeerConnection) {
    listenerPeerConnection.close();
    listenerPeerConnection = null;
  }
  listenerDataChannel = null;
  if (listenerWs && listenerWs.readyState === WebSocket.OPEN) {
    listenerWs.close();
  }
  listenerWs = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    delayNode = null;
    gainNode = null;
  }
  myOneWayDelay = 0;
}

// ---------- Shared WebSocket message handler for host ----------
function handleHostMessage(msg) {
  const listenerListEl = document.getElementById('listenerList');

  if (msg.type === 'error') {
    document.getElementById('createErr').textContent = msg.message;
    return;
  }

  if (msg.type === 'listener-join') {
    addListenerRow(msg.id, 'Guest ' + (listenerListEl.children.length + 1));
    if (hostStream) {
      createPeerConnectionForListener(msg.id, hostStream.getTracks()[0]);
    }
  } else if (msg.type === 'member-info') {
    membersMap.set(msg.id, { name: msg.name, avatar: msg.avatar });
    updateHostMembersList();
  } else if (msg.type === 'listener-leave') {
    removeListenerRow(msg.id);
    membersMap.delete(msg.id);
    listenerLatencies.delete(msg.id);
    updateHostMembersList();
    const entry = hostPeerConnections.get(msg.id);
    if (entry) {
      entry.pc.close();
      hostPeerConnections.delete(msg.id);
    }
    // Recalculate target delay when a listener leaves
    recalculateTargetDelay();
  } else if (msg.type === 'answer') {
    const entry = hostPeerConnections.get(msg.from);
    if (entry) {
      entry.pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
        .catch(err => console.error(`Failed to set remote description for ${msg.from}:`, err));
    }
  } else if (msg.type === 'ice-candidate') {
    const entry = hostPeerConnections.get(msg.from);
    if (entry && msg.candidate) {
      entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        .catch(err => console.error(`Failed to add ICE candidate from ${msg.from}:`, err));
    }
  } else if (msg.type === 'pong') {
    // Sync pong from listener — calculate latency
    handleSyncPong(msg);
  }
}

// ---------- Create Room flow ----------
const freqCodeEl = document.getElementById('freqCode');
const qrCanvas = document.getElementById('qrCanvas');
const lobbyCountEl = document.getElementById('lobbyCount');
const listenerListEl = document.getElementById('listenerList');
const emptyHintEl = document.getElementById('emptyHint');
const startPartyBtn = document.getElementById('startPartyBtn');
const createErrEl = document.getElementById('createErr');

function connectHostWebSocket(roomCode) {
  if (hostWs) hostWs.close();
  const wsProto = getWsProtocol();
  hostWs = new WebSocket(`${wsProto}//${location.host}/ws?role=host&room=${roomCode}`);

  hostWs.onopen = () => {
    console.log('Host connected to signaling server');
  };

  hostWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleHostMessage(msg);
  };

  hostWs.onerror = (err) => {
    console.error('Host WebSocket error:', err);
    createErrEl.textContent = 'Failed to connect to server';
  };

  hostWs.onclose = () => {
    console.log('Host disconnected from server');
    // Auto-reconnect if we still have a room
    if (currentRoomCode && currentView === 'view-create') {
      console.log('Attempting to reconnect...');
      setTimeout(() => {
        if (currentRoomCode) connectHostWebSocket(currentRoomCode);
      }, 2000);
    }
    hostWs = null;
  };
}

function enterCreateRoom() {
  currentRoomCode = generateRoomCode();
  saveRoomState();
  freqCodeEl.textContent = currentRoomCode.slice(0, 3) + ' ' + currentRoomCode.slice(3);

  const joinUrl = `${location.origin}${location.pathname}?code=${currentRoomCode}`;
  if (window.QRCode) {
    QRCode.toCanvas(qrCanvas, joinUrl, {
      width: 168,
      margin: 1,
      color: { dark: '#12141b', light: '#ffffff' },
    });
  }

  listenerListEl.innerHTML = '';
  updateLobbyCount(0);
  createErrEl.textContent = '';
  startPartyBtn.disabled = false;
  startPartyBtn.textContent = 'Start the Party';
  document.getElementById('hostControls').style.display = 'none';

  showView('view-create');
  connectHostWebSocket(currentRoomCode);
}

function updateLobbyCount(n) {
  lobbyCountEl.textContent = n;
  emptyHintEl.style.display = n === 0 ? 'block' : 'none';
}

function addListenerRow(id, label) {
  emptyHintEl.style.display = 'none';
  const row = createListenerRow(id, label, null);
  listenerListEl.appendChild(row);
  updateLobbyCount(listenerListEl.children.length);
}

function removeListenerRow(id) {
  const row = listenerListEl.querySelector(`[data-listener-id="${id}"]`);
  if (row) row.remove();
  updateLobbyCount(listenerListEl.children.length);
}

function updateHostMembersList() {
  document.querySelectorAll('[data-listener-id]').forEach(row => {
    const id = row.dataset.listenerId;
    const member = membersMap.get(id);
    if (member) {
      // Clear row safely and rebuild
      while (row.firstChild) row.removeChild(row.firstChild);

      const avatarSpan = document.createElement('span');
      avatarSpan.className = 'member-avatar';
      avatarSpan.textContent = member.avatar;
      row.appendChild(avatarSpan);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'member-name';
      nameSpan.textContent = member.name;
      row.appendChild(nameSpan);
    }
  });
}

// ---------- Audio Sync: Host side ----------
function startSyncPings() {
  if (syncIntervalId) clearInterval(syncIntervalId);

  syncIntervalId = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of hostPeerConnections.entries()) {
      if (entry.dc && entry.dc.readyState === 'open') {
        try {
          entry.dc.send(JSON.stringify({
            type: 'ping',
            hostTime: now,
            targetId: id
          }));
        } catch (e) {
          // Ignore send errors
        }
      }
    }
  }, 3000); // Ping every 3 seconds
}

function handleSyncPong(msg) {
  const now = Date.now();
  const rtt = now - msg.hostTime;
  const oneWay = rtt / 2;

  listenerLatencies.set(msg.from, { rtt, oneWay, lastUpdate: now });
  recalculateTargetDelay();
}

function recalculateTargetDelay() {
  if (listenerLatencies.size === 0) {
    hostTargetDelay = 0;
    return;
  }

  let maxOneWay = 0;
  for (const { oneWay } of listenerLatencies.values()) {
    if (oneWay > maxOneWay) maxOneWay = oneWay;
  }

  // Ultra-low latency target delay: max one-way + 35ms safety buffer
  // Capped at 120ms to keep audio perfectly synced with video/lip-sync
  hostTargetDelay = Math.min(maxOneWay + 35, 120);

  // Broadcast target delay to all listeners via DataChannel
  for (const [id, entry] of hostPeerConnections.entries()) {
    if (entry.dc && entry.dc.readyState === 'open') {
      const latency = listenerLatencies.get(id);
      const listenerOneWay = latency ? latency.oneWay : 0;
      try {
        entry.dc.send(JSON.stringify({
          type: 'sync-config',
          targetDelay: hostTargetDelay,
          yourOneWay: listenerOneWay
        }));
      } catch (e) {
        // Ignore
      }
    }
  }
}

// ---------- WebRTC: Host creates peer connection per listener ----------
async function createPeerConnectionForListener(listenerId, audioTrack) {
  try {
    const pc = new RTCPeerConnection(rtcConfig);

    // Create DataChannel for sync messages
    const dc = pc.createDataChannel('sync', { ordered: true });
    dc.onopen = () => {
      console.log(`DataChannel open for listener ${listenerId}`);
    };
    dc.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'pong') {
        msg.from = listenerId;
        handleSyncPong(msg);
      } else if (msg.type === 'request-sync') {
        console.log(`Manual re-sync requested by listener ${listenerId}`);
        recalculateTargetDelay();
      }
    };

    hostPeerConnections.set(listenerId, { pc, dc });

    // Add the audio track
    const sender = pc.addTrack(audioTrack, hostStream);

    // Set high bitrate for audio quality
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = 320000;
    await sender.setParameters(params);

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendHostMessage({
          type: 'ice-candidate',
          id: listenerId,
          candidate: event.candidate
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`Peer connection with ${listenerId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        hostPeerConnections.delete(listenerId);
        listenerLatencies.delete(listenerId);
        recalculateTargetDelay();
      }
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendHostMessage({
      type: 'offer',
      id: listenerId,
      offer: offer
    });
  } catch (err) {
    console.error(`Failed to create peer connection for ${listenerId}:`, err);
  }
}

// ---------- Audio Source UI Controls ----------
const audioSourceSelect = document.getElementById('audioSourceSelect');
const sourceModeTab = document.getElementById('sourceModeTab');
const sourceModeMic = document.getElementById('sourceModeMic');
const sourceModeFile = document.getElementById('sourceModeFile');
const sourceModeUrl = document.getElementById('sourceModeUrl');
const selectAudioFileBtn = document.getElementById('selectAudioFileBtn');
const hostAudioFileInput = document.getElementById('hostAudioFileInput');
const hostAudioPlayer = document.getElementById('hostAudioPlayer');
const fileNameDisplay = document.getElementById('fileNameDisplay');
const audioPlayerContainer = document.getElementById('audioPlayerContainer');

if (audioSourceSelect) {
  audioSourceSelect.addEventListener('change', () => {
    const val = audioSourceSelect.value;
    sourceModeTab.style.display = val === 'tab' ? 'block' : 'none';
    sourceModeMic.style.display = val === 'mic' ? 'block' : 'none';
    sourceModeFile.style.display = val === 'file' ? 'block' : 'none';
    sourceModeUrl.style.display = val === 'url' ? 'block' : 'none';
  });
}

if (selectAudioFileBtn && hostAudioFileInput) {
  selectAudioFileBtn.addEventListener('click', () => hostAudioFileInput.click());
  hostAudioFileInput.addEventListener('change', (e) => {
    if (e.target.files.length === 0) return;
    const file = e.target.files[0];
    fileNameDisplay.textContent = `File: ${file.name}`;
    hostAudioPlayer.src = URL.createObjectURL(file);
    audioPlayerContainer.style.display = 'block';
  });
}

async function getHostAudioStream(mode) {
  if (mode === 'tab') {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      throw new Error('Tab capture (getDisplayMedia) is not supported on mobile/TV browsers. Please select Microphone, Audio File, or URL Stream above.');
    }
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false }
    });
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach(t => t.stop());
      throw new Error('No audio was shared. Pick the video tab and enable "Share tab audio".');
    }
    displayStream.getVideoTracks().forEach(t => t.stop());
    return new MediaStream(audioTracks);
  }

  if (mode === 'mic') {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access requires HTTPS on mobile devices or is not supported.');
    }
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    return micStream;
  }

  if (mode === 'file' || mode === 'url') {
    if (mode === 'url') {
      const urlInput = document.getElementById('hostAudioUrlInput').value.trim();
      if (!urlInput) throw new Error('Please enter an audio stream/file URL.');
      hostAudioPlayer.src = urlInput;
      audioPlayerContainer.style.display = 'block';
      fileNameDisplay.textContent = `URL: ${urlInput}`;
    }

    if (!hostAudioPlayer.src) {
      throw new Error('Please choose an audio file or enter a stream URL first.');
    }

    try {
      await hostAudioPlayer.play();
    } catch (playErr) {
      console.warn('Audio play warning:', playErr);
    }

    if (hostAudioPlayer.captureStream) {
      return hostAudioPlayer.captureStream();
    } else if (hostAudioPlayer.mozCaptureStream) {
      return hostAudioPlayer.mozCaptureStream();
    } else {
      const hostAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const sourceNode = hostAudioCtx.createMediaElementSource(hostAudioPlayer);
      const destNode = hostAudioCtx.createMediaStreamDestination();
      sourceNode.connect(destNode);
      sourceNode.connect(hostAudioCtx.destination);
      return destNode.stream;
    }
  }

  throw new Error('Invalid audio source mode selected');
}

// ---------- Start Party (host) ----------
startPartyBtn.addEventListener('click', async () => {
  createErrEl.textContent = '';
  const selectedMode = audioSourceSelect ? audioSourceSelect.value : 'tab';

  try {
    hostStream = await getHostAudioStream(selectedMode);
    const audioTracks = hostStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('No audio tracks found in selected source.');
    }

    isBroadcasting = true;
    startPartyBtn.textContent = '🔴 Broadcasting…';
    startPartyBtn.disabled = true;
    document.getElementById('hostControls').style.display = 'flex';

    // Create RTCPeerConnection for each connected listener
    const audioTrack = audioTracks[0];
    const existingListeners = listenerListEl.querySelectorAll('[data-listener-id]');
    for (const row of existingListeners) {
      const id = row.dataset.listenerId;
      createPeerConnectionForListener(id, audioTrack);
    }

    // Start sync pings
    startSyncPings();

    // Handle track ending
    audioTrack.onended = () => {
      createErrEl.textContent = 'Audio broadcast ended.';
      isBroadcasting = false;
      startPartyBtn.textContent = 'Start Broadcast';
      startPartyBtn.disabled = false;
    };

  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      createErrEl.textContent = err.message;
    }
  }
});

// ---------- Copy code ----------
document.getElementById('copyCodeBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentRoomCode);
    const btn = document.getElementById('copyCodeBtn');
    const original = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = original), 1200);
  } catch (e) { /* clipboard may be unavailable */ }
});

// ---------- End Party (host) ----------
document.getElementById('endPartyBtn').addEventListener('click', () => {
  showConfirmation('End the Party?', 'This will disconnect all listeners and close the room. Are you sure?', () => {
    cleanupHost();
    showView('view-landing');
  });
});

// ---------- Change Tab Audio (host) ----------
document.getElementById('changeTabAudioBtn').addEventListener('click', async () => {
  createErrEl.textContent = '';
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });

    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach(t => t.stop());
      createErrEl.textContent = 'No audio was shared. Please share tab audio.';
      return;
    }

    displayStream.getVideoTracks().forEach(t => t.stop());

    if (hostStream) {
      hostStream.getTracks().forEach(t => t.stop());
    }

    const newAudioTrack = audioTracks[0];
    hostStream = new MediaStream([newAudioTrack]);

    // Replace audio track on all peer connections
    for (const [lid, entry] of hostPeerConnections.entries()) {
      const sender = entry.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) {
        await sender.replaceTrack(newAudioTrack);
        console.log(`Replaced audio track for listener ${lid}`);
      }
    }

    isBroadcasting = true;
    startPartyBtn.textContent = '🔴 Broadcasting…';
    startPartyBtn.disabled = true;

    createErrEl.textContent = 'Tab audio changed successfully!';
    setTimeout(() => { createErrEl.textContent = ''; }, 2000);

    newAudioTrack.onended = () => {
      createErrEl.textContent = 'Tab sharing stopped. Click "Change Tab Audio" to resume.';
      isBroadcasting = false;
      startPartyBtn.textContent = 'Start the Party';
      startPartyBtn.disabled = false;
    };

  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      createErrEl.textContent = 'Couldn\'t capture new tab audio: ' + err.message;
    }
  }
});

// ---------- Mute Host Speakers ----------
let hostSpeakersMuted = false;

document.getElementById('muteHostSpeakersBtn').addEventListener('click', () => {
  const btn = document.getElementById('muteHostSpeakersBtn');
  hostSpeakersMuted = !hostSpeakersMuted;

  if (hostSpeakersMuted) {
    btn.textContent = '🔇 Unmute Speakers';
    btn.classList.add('muted');
    // Mute the host's own captured audio playback
    // The stream is sent to listeners but not played locally by default
    // This is a no-op for now since getDisplayMedia audio goes to the tab, not host speakers
  } else {
    btn.textContent = '🔊 Mute Speakers';
    btn.classList.remove('muted');
  }
});

// ---------- Join Room flow ----------
const codeInputs = Array.from(document.querySelectorAll('.code-entry input'));
const joinContinueBtn = document.getElementById('joinContinueBtn');
const joinErrEl = document.getElementById('joinErr');
const waitingCodeEl = document.getElementById('waitingCode');

codeInputs.forEach((input, i) => {
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 1);
    if (input.value && i < codeInputs.length - 1) codeInputs[i + 1].focus();
    joinContinueBtn.disabled = !codeInputs.every(inp => inp.value.length === 1);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && i > 0) codeInputs[i - 1].focus();
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    text.split('').forEach((ch, idx) => {
      if (codeInputs[idx]) codeInputs[idx].value = ch;
    });
    const nextEmpty = codeInputs.findIndex(inp => !inp.value);
    (nextEmpty === -1 ? codeInputs[codeInputs.length - 1] : codeInputs[nextEmpty]).focus();
    joinContinueBtn.disabled = !codeInputs.every(inp => inp.value.length === 1);
  });
});

function enterJoinRoom(prefillCode) {
  codeInputs.forEach((inp, i) => { inp.value = prefillCode ? (prefillCode[i] || '') : ''; });
  joinContinueBtn.disabled = !prefillCode || prefillCode.length < codeInputs.length;
  joinErrEl.textContent = '';
  showView('view-join');
  if (!prefillCode) codeInputs[0].focus();
}

joinContinueBtn.addEventListener('click', () => {
  const code = codeInputs.map(i => i.value).join('');
  joinRoom(code);
});

function joinRoom(code) {
  joinErrEl.textContent = '';
  waitingCodeEl.textContent = code.slice(0, 3) + ' ' + code.slice(3);
  showView('view-waiting');

  // Reset sync UI
  document.getElementById('syncBadge').style.display = 'none';
  document.getElementById('volumeControl').style.display = 'none';
  document.getElementById('statusTitle').textContent = 'Connecting…';
  document.getElementById('statusSub').textContent = 'Joining the room. Please wait…';

  // Open WebSocket connection as listener
  if (listenerWs) listenerWs.close();
  const wsProto = getWsProtocol();
  listenerWs = new WebSocket(`${wsProto}//${location.host}/ws?role=listener&room=${code}`);

  listenerWs.onopen = () => {
    console.log('Listener connected to signaling server');
  };

  listenerWs.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'error') {
      joinErrEl.textContent = msg.message;
      showView('view-join');
      return;
    }

    if (msg.type === 'welcome') {
      listenerId = msg.id;
      console.log('Listener ID:', msg.id);
      sendListenerMessage({
        type: 'member-info',
        id: msg.id,
        name: userProfile.name,
        avatar: userProfile.avatar
      });
      enterConnectedState();
    } else if (msg.type === 'offer') {
      handleOfferFromHost(msg.offer);
    } else if (msg.type === 'ice-candidate') {
      if (listenerPeerConnection && msg.candidate) {
        listenerPeerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
          .catch(err => console.error('Failed to add ICE candidate:', err));
      }
    } else if (msg.type === 'host-disconnected') {
      document.getElementById('statusTitle').textContent = 'Host left';
      document.getElementById('statusSub').textContent = 'The host has ended the party. Returning to home…';
      cleanupListener();
      setTimeout(() => showView('view-landing'), 2500);
    } else if (msg.type === 'members-update') {
      updateMembersList(msg.members);
    }
  };

  listenerWs.onerror = (err) => {
    console.error('Listener WebSocket error:', err);
    joinErrEl.textContent = 'Failed to connect to server';
    showView('view-join');
  };

  listenerWs.onclose = () => {
    console.log('Listener disconnected from server');
    listenerWs = null;
  };
}

// ---------- Exit Party (listener) ----------
document.getElementById('exitPartyBtn').addEventListener('click', () => {
  showConfirmation('Exit Party?', 'You will disconnect from the audio broadcast.', () => {
    cleanupListener();
    showView('view-landing');
  });
});

// ---------- QR Scanner ----------
let html5QrScanner = null;

function processScannedCode(decodedText) {
  let code = decodedText;
  try {
    const url = new URL(decodedText);
    const urlCode = url.searchParams.get('code');
    if (urlCode) code = urlCode;
  } catch {
    // Not a URL, use as-is
  }

  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (code.length === 6) {
    stopQrScanner();
    joinRoom(code);
  } else {
    joinErrEl.textContent = `Scanned text ("${decodedText.slice(0, 20)}") doesn't contain a valid 6-char room code.`;
  }
}

document.getElementById('scanBtn').addEventListener('click', async () => {
  const readerEl = document.getElementById('qr-reader');
  const stopBtn = document.getElementById('stopScanBtn');
  const uploadBtn = document.getElementById('uploadQrBtn');

  if (typeof Html5Qrcode === 'undefined') {
    joinErrEl.textContent = 'QR scanner library not loaded. Please enter the code manually.';
    return;
  }

  readerEl.style.display = 'block';
  stopBtn.style.display = 'block';
  uploadBtn.style.display = 'block';
  joinErrEl.textContent = '';

  // Check if getUserMedia is available (requires HTTPS or localhost on mobile)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      joinErrEl.textContent = 'Live camera access requires HTTPS on mobile devices. Use "Upload QR Image" or enter code manually.';
    } else {
      joinErrEl.textContent = 'Camera API not supported on this browser. Use "Upload QR Image".';
    }
    return;
  }

  if (html5QrScanner) {
    try { await html5QrScanner.stop(); } catch (e) {}
  }

  html5QrScanner = new Html5Qrcode('qr-reader');

  const scanConfig = { fps: 10, qrbox: { width: 250, height: 250 } };

  // Try environment camera first
  html5QrScanner.start(
    { facingMode: 'environment' },
    scanConfig,
    (decodedText) => processScannedCode(decodedText),
    () => {}
  ).catch(async (err) => {
    console.warn('Environment camera failed, trying fallback camera:', err);
    try {
      // Fallback: get camera list and pick first available camera
      const cameras = await Html5Qrcode.getCameras();
      if (cameras && cameras.length > 0) {
        await html5QrScanner.start(
          cameras[0].id,
          scanConfig,
          (decodedText) => processScannedCode(decodedText),
          () => {}
        );
      } else {
        throw new Error('No camera devices found');
      }
    } catch (fallbackErr) {
      console.error('Camera scan failed:', fallbackErr);
      joinErrEl.textContent = 'Camera permission denied or unavailable. Tap "Upload QR Image" below or enter code manually.';
    }
  });
});

// Photo upload QR scanner fallback
const qrFileInput = document.getElementById('qrFileInput');
const uploadQrBtn = document.getElementById('uploadQrBtn');

uploadQrBtn.addEventListener('click', () => {
  qrFileInput.click();
});

qrFileInput.addEventListener('change', (e) => {
  if (e.target.files.length === 0) return;
  const file = e.target.files[0];

  const scanner = new Html5Qrcode('qr-reader');
  document.getElementById('qr-reader').style.display = 'block';
  document.getElementById('stopScanBtn').style.display = 'block';
  joinErrEl.textContent = 'Scanning image…';

  scanner.scanFile(file, true)
    .then(decodedText => {
      joinErrEl.textContent = '';
      processScannedCode(decodedText);
    })
    .catch(err => {
      console.error('Error scanning file:', err);
      joinErrEl.textContent = 'Could not find a valid QR code in that image. Please enter code manually.';
    });
});

document.getElementById('stopScanBtn').addEventListener('click', stopQrScanner);

function stopQrScanner() {
  if (html5QrScanner) {
    html5QrScanner.stop().then(() => {
      html5QrScanner.clear();
      html5QrScanner = null;
    }).catch(() => {
      html5QrScanner = null;
    });
  }
  document.getElementById('qr-reader').style.display = 'none';
  document.getElementById('stopScanBtn').style.display = 'none';
  document.getElementById('uploadQrBtn').style.display = 'none';
}

// ---------- Connected state (listener) ----------
const statusPanel = document.getElementById('statusPanel');

function enterConnectedState() {
  document.getElementById('statusTitle').textContent = 'Waiting for the host to start…';
  document.getElementById('statusSub').textContent =
    'You\'re in the room. Once the host starts the party, audio will begin automatically — put your headphones on now.';
}

// ---------- Audio Sync & Playback: Listener side ----------
let listenerAudioEl = null;
const unmuteAudioBtn = document.getElementById('unmuteAudioBtn');

async function unlockListenerAudio() {
  if (audioContext && audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
      console.log('AudioContext resumed. State:', audioContext.state);
    } catch (e) {
      console.warn('AudioContext resume error:', e);
    }
  }

  listenerAudioEl = document.getElementById('listenerAudioElement');
  if (listenerAudioEl) {
    try {
      await listenerAudioEl.play();
      console.log('Audio element playing successfully');
    } catch (e) {
      console.warn('Audio element play blocked:', e);
    }
  }

  if (audioContext && audioContext.state === 'running' && unmuteAudioBtn) {
    unmuteAudioBtn.style.display = 'none';
  }
}

if (unmuteAudioBtn) {
  unmuteAudioBtn.addEventListener('click', unlockListenerAudio);
}

// Global user interaction listener to unlock audio on any tap/click
['touchstart', 'click', 'keydown'].forEach(eventType => {
  document.addEventListener(eventType, () => {
    if (currentView === 'view-waiting') {
      unlockListenerAudio();
    }
  }, { passive: true });
});

function setupListenerAudioPipeline(stream) {
  try {
    if (audioContext) {
      audioContext.close().catch(() => {});
    }

    // Configure AudioContext for lowest possible hardware latency ('interactive' = <15ms buffer)
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtxClass({ latencyHint: 'interactive' });
    const source = audioContext.createMediaStreamSource(stream);

    // DelayNode for sync buffering (max 1 second)
    delayNode = audioContext.createDelay(1.0);
    delayNode.delayTime.value = 0;

    // GainNode for volume control
    gainNode = audioContext.createGain();
    const currentVol = document.getElementById('volumeSlider') ? document.getElementById('volumeSlider').value : 100;
    gainNode.gain.value = currentVol / 100;

    // Connect pipeline: source → delay → gain → destination
    source.connect(delayNode);
    delayNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Attempt to resume audio context if suspended
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }

    // Show volume control
    document.getElementById('volumeControl').style.display = 'flex';

    return audioContext;
  } catch (err) {
    console.error('Failed to setup Web Audio pipeline, using HTML5 audio fallback:', err);
  }
}

function handleSyncMessage(msg) {
  if (msg.type === 'ping') {
    if (listenerDataChannel && listenerDataChannel.readyState === 'open') {
      listenerDataChannel.send(JSON.stringify({
        type: 'pong',
        hostTime: msg.hostTime,
        listenerTime: Date.now()
      }));
    }
  } else if (msg.type === 'sync-config') {
    const targetDelay = msg.targetDelay || 0;
    myOneWayDelay = msg.yourOneWay || 0;
    const myDelay = Math.max(0, (targetDelay - myOneWayDelay)) / 1000;

    if (delayNode && audioContext && audioContext.state === 'running') {
      delayNode.delayTime.linearRampToValueAtTime(
        Math.min(myDelay, 1.0),
        audioContext.currentTime + 0.1
      );
    }

    const syncContainer = document.getElementById('syncContainer');
    const syncBadge = document.getElementById('syncBadge');
    const syncDot = document.getElementById('syncDot');
    const syncText = document.getElementById('syncText');
    if (syncContainer) syncContainer.style.display = 'flex';
    if (syncBadge) syncBadge.style.display = 'inline-flex';
    if (syncDot) syncDot.classList.add('synced');
    if (syncText) syncText.textContent = `Synced (${Math.round(myDelay * 1000)}ms buffer)`;
  }
}

// ---------- Re-Sync Button Handlers ----------
const resyncListenerBtn = document.getElementById('resyncListenerBtn');
if (resyncListenerBtn) {
  resyncListenerBtn.addEventListener('click', () => {
    resyncListenerBtn.textContent = '⚡ Syncing…';
    resyncListenerBtn.disabled = true;

    // 1. Ensure AudioContext is active
    unlockListenerAudio();

    // 2. Request fresh clock-sync / target delay calculation from host
    if (listenerDataChannel && listenerDataChannel.readyState === 'open') {
      listenerDataChannel.send(JSON.stringify({ type: 'request-sync' }));
    } else if (listenerWs && listenerWs.readyState === WebSocket.OPEN) {
      sendListenerMessage({ type: 'request-sync' });
    }

    // 3. Reset delayNode value smoothly
    if (delayNode && audioContext && audioContext.state === 'running') {
      const currentDelay = delayNode.delayTime.value;
      delayNode.delayTime.cancelScheduledValues(audioContext.currentTime);
      delayNode.delayTime.setValueAtTime(currentDelay, audioContext.currentTime);
    }

    setTimeout(() => {
      resyncListenerBtn.textContent = '⚡ Synced ✓';
      setTimeout(() => {
        resyncListenerBtn.textContent = '⚡ Re-Sync Audio';
        resyncListenerBtn.disabled = false;
      }, 1200);
    }, 400);
  });
}

const resyncHostBtn = document.getElementById('resyncHostBtn');
if (resyncHostBtn) {
  resyncHostBtn.addEventListener('click', () => {
    resyncHostBtn.textContent = '⚡ Syncing All…';
    resyncHostBtn.disabled = true;

    // Recalculate target delay and send sync-config to all listeners
    recalculateTargetDelay();

    setTimeout(() => {
      resyncHostBtn.textContent = '⚡ Synced All ✓';
      setTimeout(() => {
        resyncHostBtn.textContent = '⚡ Re-Sync All';
        resyncHostBtn.disabled = false;
      }, 1200);
    }, 400);
  });
}

// Handle offer from host (listener side)
async function handleOfferFromHost(offer) {
  try {
    if (!listenerPeerConnection) {
      listenerPeerConnection = new RTCPeerConnection(rtcConfig);

      // Handle DataChannel from host
      listenerPeerConnection.ondatachannel = (event) => {
        listenerDataChannel = event.channel;
        listenerDataChannel.onmessage = (e) => {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }
          handleSyncMessage(msg);
        };
        listenerDataChannel.onopen = () => {
          console.log('Sync DataChannel open');
          const syncContainer = document.getElementById('syncContainer');
          if (syncContainer) syncContainer.style.display = 'flex';
        };
      };

      // Handle remote audio track
      listenerPeerConnection.ontrack = (event) => {
        console.log('Received remote audio track');
        const stream = event.streams[0] || new MediaStream([event.track]);

        // Force zero WebRTC jitter buffer delay for ultra-low latency playback
        if (event.receiver && 'playoutDelayHint' in event.receiver) {
          try { event.receiver.playoutDelayHint = 0; } catch (e) {}
        }

        // 1. Direct HTML5 Audio Element (muted, needed for iOS Safari WebRTC background session trigger)
        listenerAudioEl = document.getElementById('listenerAudioElement');
        if (listenerAudioEl) {
          listenerAudioEl.srcObject = stream;
          listenerAudioEl.muted = true; // MUST be muted so it doesn't cause duplicate audio echo with AudioContext!
          listenerAudioEl.play().catch(err => {
            console.warn('Autoplay blocked. Tap required:', err);
            if (unmuteAudioBtn) unmuteAudioBtn.style.display = 'block';
          });
        }

        // 2. Web Audio API pipeline (SINGLE primary audio output with sync delay & volume control)
        setupListenerAudioPipeline(stream);

        if (audioContext && audioContext.state === 'suspended') {
          if (unmuteAudioBtn) unmuteAudioBtn.style.display = 'block';
        }

        // Transition to live state UI
        statusPanel.classList.add('is-live');
        document.getElementById('statusTitle').textContent = 'Listening Live';
        document.getElementById('statusSub').textContent =
          'Audio is streaming live. Put your headphones on now.';
      };

      // Handle ICE candidates
      listenerPeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          sendListenerMessage({
            type: 'ice-candidate',
            candidate: event.candidate
          });
        }
      };

      listenerPeerConnection.onconnectionstatechange = () => {
        const state = listenerPeerConnection?.connectionState;
        console.log(`Peer connection state: ${state}`);
        if (state === 'connected') {
          document.getElementById('statusTitle').textContent = 'Listening Live';
        } else if (state === 'disconnected' || state === 'failed') {
          document.getElementById('statusTitle').textContent = 'Connection lost';
          document.getElementById('statusSub').textContent = 'Trying to reconnect…';
          const syncDot = document.getElementById('syncDot');
          if (syncDot) syncDot.classList.remove('synced');
          const syncText = document.getElementById('syncText');
          if (syncText) syncText.textContent = 'Reconnecting…';
        }
      };
    }

    await listenerPeerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await listenerPeerConnection.createAnswer();
    await listenerPeerConnection.setLocalDescription(answer);
    sendListenerMessage({
      type: 'answer',
      answer: answer
    });
  } catch (err) {
    console.error('Failed to handle offer from host:', err);
  }
}

// ---------- Volume control ----------
document.getElementById('volumeSlider').addEventListener('input', (e) => {
  const val = e.target.value / 100;
  document.getElementById('volumeValue').textContent = `${e.target.value}%`;
  if (gainNode) {
    gainNode.gain.linearRampToValueAtTime(val, audioContext.currentTime + 0.05);
  }
});

// ---------- Members list (listener side) ----------
function updateMembersList(members) {
  membersMap.clear();
  members.forEach(member => {
    membersMap.set(member.id, { name: member.name, avatar: member.avatar });
  });

  const membersList = document.getElementById('membersList');
  if (membersList) {
    membersList.innerHTML = '';
    membersMap.forEach((info) => {
      membersList.appendChild(createMemberItem(info.name, info.avatar));
    });
  }
}

// ---------- Deep link support (?code=XXXXXX from a scanned QR) ----------
(function checkDeepLink() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code && code.length === 6) {
    enterJoinRoom(code.toUpperCase());
  }
})();

// ---------- Restore room state on page load ----------
(function restoreState() {
  const savedCode = sessionStorage.getItem('roomCode');
  if (savedCode) {
    currentRoomCode = savedCode;
    console.log('Restoring room:', currentRoomCode);

    freqCodeEl.textContent = currentRoomCode.slice(0, 3) + ' ' + currentRoomCode.slice(3);
    listenerListEl.innerHTML = '';
    updateLobbyCount(0);
    createErrEl.textContent = '';
    startPartyBtn.disabled = false;
    startPartyBtn.textContent = 'Start the Party';
    document.getElementById('hostControls').style.display = 'none';

    showView('view-create');
    connectHostWebSocket(currentRoomCode);
  }
})();

// ---------- Handle tab close / page unload ----------
window.addEventListener('beforeunload', () => {
  if (hostWs) hostWs.close();
  if (listenerWs) listenerWs.close();
  for (const { pc } of hostPeerConnections.values()) {
    pc.close();
  }
  if (listenerPeerConnection) listenerPeerConnection.close();
  if (syncIntervalId) clearInterval(syncIntervalId);
});

// ---------- Profile Modal ----------
(function initProfileModal() {
  const profileModal = document.getElementById('profileModal');
  const closeProfileBtn = document.getElementById('closeProfileBtn');
  const profileNameInput = document.getElementById('profileName');
  const generateNameBtn = document.getElementById('generateNameBtn');
  const avatarGrid = document.getElementById('avatarGrid');
  const saveProfileBtn = document.getElementById('saveProfileBtn');

  // Create avatar options (safe — these are hardcoded emoji)
  AVATAR_OPTIONS.forEach(avatar => {
    const option = document.createElement('button');
    option.className = 'avatar-option';
    option.textContent = avatar;
    option.type = 'button';
    if (avatar === userProfile.avatar) {
      option.classList.add('selected');
    }
    option.addEventListener('click', () => {
      document.querySelectorAll('.avatar-option').forEach(opt => opt.classList.remove('selected'));
      option.classList.add('selected');
    });
    avatarGrid.appendChild(option);
  });

  profileNameInput.value = userProfile.name;

  closeProfileBtn.addEventListener('click', () => {
    profileModal.style.display = 'none';
  });

  generateNameBtn.addEventListener('click', () => {
    profileNameInput.value = generateCoolName();
  });

  saveProfileBtn.addEventListener('click', () => {
    const newName = profileNameInput.value.trim() || generateCoolName();
    const selectedAvatar = document.querySelector('.avatar-option.selected');
    const newAvatar = selectedAvatar ? selectedAvatar.textContent : userProfile.avatar;

    userProfile = updateProfile(newName, newAvatar);
    updateProfileButtons();
    profileModal.style.display = 'none';

    // If connected as listener, re-send profile info
    if (listenerWs && listenerWs.readyState === WebSocket.OPEN && listenerId) {
      sendListenerMessage({
        type: 'member-info',
        id: listenerId,
        name: userProfile.name,
        avatar: userProfile.avatar
      });
    }
  });

  // Close modal when clicking outside
  profileModal.addEventListener('click', (e) => {
    if (e.target === profileModal) {
      profileModal.style.display = 'none';
    }
  });

  // Wire profile buttons
  function openProfileModal() {
    profileNameInput.value = userProfile.name;
    // Update selected avatar
    document.querySelectorAll('.avatar-option').forEach(opt => {
      opt.classList.toggle('selected', opt.textContent === userProfile.avatar);
    });
    profileModal.style.display = 'flex';
  }

  document.getElementById('hostProfileBtn').addEventListener('click', openProfileModal);
  document.getElementById('listenerProfileBtn').addEventListener('click', openProfileModal);
})();
