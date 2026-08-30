/* ==========================================================================
   Silent Broadcast — Frontend logic
   This is the FRONTEND ONLY stage: room codes, QR rendering, view flow, and
   system/tab audio capture are wired for real. Actual peer-to-peer
   connection to listeners (WebRTC signaling) is marked with TODO and will
   be connected once the signaling server is built.
   ========================================================================== */

// ---------- View router ----------
const views = document.querySelectorAll('.view');
function showView(id) {
  views.forEach(v => v.classList.toggle('active', v.id === id));
  
  // Clean up connections when leaving
  if (id === 'view-landing') {
    // Notify all listeners that host is disconnecting
    if (hostWs && hostWs.readyState === WebSocket.OPEN) {
      sendHostMessage({ type: 'host-cancel' });
    }
    if (hostWs) hostWs.close();
    if (listenerWs) listenerWs.close();
    hostWs = null;
    listenerWs = null;
    // Don't clear room state here - let endPartyBtn handle it
  }
}
document.querySelectorAll('[data-nav]').forEach(el => {
  el.addEventListener('click', () => showView(el.dataset.nav));
});

// ---------- Room code generation ----------
// Avoids visually ambiguous characters (0/O, 1/I/L).
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

let currentRoomCode = null;
let isBroadcasting = false; // track if host is actively broadcasting
let hostStream = null; // captured tab/system audio, set when broadcasting starts
let hostWs = null; // WebSocket connection for host
let listenerWs = null; // WebSocket connection for listener
let hostPeerConnections = new Map(); // id -> RTCPeerConnection for host
let listenerPeerConnection = null; // RTCPeerConnection for listener
let listenerId = null; // listener's own ID from server

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

// ---------- Room state persistence ----------
function saveRoomState() {
  if (currentRoomCode) {
    sessionStorage.setItem('roomCode', currentRoomCode);
  }
}

function restoreRoomState() {
  const savedCode = sessionStorage.getItem('roomCode');
  if (savedCode) {
    currentRoomCode = savedCode;
    return true;
  }
  return false;
}

function clearRoomState() {
  sessionStorage.removeItem('roomCode');
  currentRoomCode = null;
  isBroadcasting = false;
}

// ---------- WebSocket connection ----------
function getWsProtocol() {
  return location.protocol === 'https:' ? 'wss:' : 'ws:';
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

// Helper to send WebRTC signaling messages through WebSocket
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

// ---------- Create Room flow ----------
const freqCodeEl = document.getElementById('freqCode');
const qrCanvas = document.getElementById('qrCanvas');
const lobbyCountEl = document.getElementById('lobbyCount');
const listenerListEl = document.getElementById('listenerList');
const emptyHintEl = document.getElementById('emptyHint');
const startPartyBtn = document.getElementById('startPartyBtn');
const createErrEl = document.getElementById('createErr');

function enterCreateRoom() {
  currentRoomCode = generateRoomCode();
  saveRoomState(); // Save room code for refresh
  freqCodeEl.textContent = currentRoomCode.slice(0, 3) + ' ' + currentRoomCode.slice(3);

  // The QR encodes a joinable URL: whoever scans it lands directly on the
  // join view with the code pre-filled (join.html?code=XXXXXX once routing
  // supports deep links — for now it encodes the code itself as a fallback).
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

  showView('view-create');

  // Open WebSocket connection as host
  if (hostWs) hostWs.close();
  const wsProto = getWsProtocol();
  hostWs = new WebSocket(`${wsProto}//${location.host}/ws?role=host&room=${currentRoomCode}`);
  
  hostWs.onopen = () => {
    console.log('Host connected to signaling server');
  };

  hostWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'listener-join') {
      addListenerRow(msg.id, 'Guest ' + (listenerListEl.children.length + 1));
      // If already broadcasting, create peer connection for new listener
      if (hostStream) {
        createPeerConnectionForListener(msg.id, hostStream.getTracks()[0]);
      }
    } else if (msg.type === 'listener-leave') {
      removeListenerRow(msg.id);
      const pc = hostPeerConnections.get(msg.id);
      if (pc) {
        pc.close();
        hostPeerConnections.delete(msg.id);
      }
    } else if (msg.type === 'answer') {
      // Listener sent back an answer
      const pc = hostPeerConnections.get(msg.from);
      if (pc) {
        pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
          .catch(err => console.error(`Failed to set remote description for ${msg.from}:`, err));
      }
    } else if (msg.type === 'ice-candidate') {
      // Listener sent ICE candidate
      const pc = hostPeerConnections.get(msg.from);
      if (pc && msg.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          .catch(err => console.error(`Failed to add ICE candidate from ${msg.from}:`, err));
      }
    }
  };

  hostWs.onerror = (err) => {
    console.error('Host WebSocket error:', err);
    createErrEl.textContent = 'Failed to connect to server';
  };

  hostWs.onclose = () => {
    console.log('Host disconnected from server');
    hostWs = null;
  };
}

function updateLobbyCount(n) {
  lobbyCountEl.textContent = n;
  emptyHintEl.style.display = n === 0 ? 'block' : 'none';
}

function addListenerRow(id, label) {
  emptyHintEl.style.display = 'none';
  const row = document.createElement('div');
  row.className = 'listener-row';
  row.dataset.listenerId = id;
  row.innerHTML = `<span class="listener-dot"></span><span>${label}</span>`;
  listenerListEl.appendChild(row);
  updateLobbyCount(listenerListEl.children.length);
}

function removeListenerRow(id) {
  const row = listenerListEl.querySelector(`[data-listener-id="${id}"]`);
  if (row) row.remove();
  updateLobbyCount(listenerListEl.children.length);
}

// Dev helper only — lets you sanity-check the lobby UI from the console
// without a real listener connected. Not called automatically.
window._simulateListenerJoin = () => {
  const id = 'demo-' + Math.random().toString(36).slice(2, 7);
  addListenerRow(id, 'Guest ' + (listenerListEl.children.length + 1));
};

startPartyBtn.addEventListener('click', async () => {
  createErrEl.textContent = '';
  try {
    // Captures the movie tab's audio directly from the browser with high-quality constraints
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
      createErrEl.textContent =
        'No audio was shared. When the picker opens, choose the movie\'s tab and enable "Share tab audio."';
      return;
    }

    // We only need the audio — stop the video track immediately so we're
    // not capturing/encoding screen frames we'll never use.
    displayStream.getVideoTracks().forEach(t => t.stop());
    hostStream = new MediaStream(audioTracks);

    startPartyBtn.textContent = 'Broadcasting…';
    startPartyBtn.disabled = true;
    document.getElementById('changeTabAudioBtn').style.display = 'block'; // Show change tab audio button

    // Create RTCPeerConnection for each connected listener and send the audio
    const audioTrack = audioTracks[0];
    for (const [listenerId, row] of Array.from(listenerListEl.querySelectorAll('[data-listener-id]')).entries()) {
      const id = row.dataset.listenerId;
      createPeerConnectionForListener(id, audioTrack);
    }

  } catch (err) {
    createErrEl.textContent = 'Couldn\'t capture audio: ' + err.message;
  }
});

async function createPeerConnectionForListener(listenerId, audioTrack) {
  try {
    const pc = new RTCPeerConnection(rtcConfig);
    hostPeerConnections.set(listenerId, pc);

    // Add the audio track
    const sender = pc.addTrack(audioTrack, hostStream);
    
    // Set high bitrate for audio quality
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = 320000; // 320 kbps for high quality
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

document.getElementById('copyCodeBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentRoomCode);
    const btn = document.getElementById('copyCodeBtn');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = original), 1200);
  } catch (e) { /* clipboard may be unavailable — silently ignore */ }
});

document.getElementById('endPartyBtn').addEventListener('click', () => {
  if (hostStream) hostStream.getTracks().forEach(t => t.stop());
  hostStream = null;
  if (hostWs) hostWs.close();
  hostWs = null;
  document.getElementById('changeTabAudioBtn').style.display = 'none'; // Hide change tab audio button
  clearRoomState(); // Clear saved room state
  showView('view-landing');
});

document.getElementById('changeTabAudioBtn').addEventListener('click', async () => {
  createErrEl.textContent = '';
  try {
    // Capture new tab audio
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

    // Stop video immediately
    displayStream.getVideoTracks().forEach(t => t.stop());
    
    // Stop old audio tracks
    if (hostStream) {
      hostStream.getTracks().forEach(t => t.stop());
    }
    
    const newAudioTrack = audioTracks[0];
    hostStream = new MediaStream([newAudioTrack]);

    // Replace audio track on all peer connections
    for (const [listenerId, pc] of hostPeerConnections.entries()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) {
        await sender.replaceTrack(newAudioTrack);
        console.log(`Replaced audio track for listener ${listenerId}`);
      }
    }

    createErrEl.textContent = 'Tab audio changed!';
    setTimeout(() => {
      createErrEl.textContent = '';
    }, 2000);

  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      createErrEl.textContent = 'Couldn\'t capture new tab audio: ' + err.message;
    }
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
  joinErrEl.textContent = '';
  waitingCodeEl.textContent = code.slice(0, 3) + ' ' + code.slice(3);
  showView('view-waiting');

  // Open WebSocket connection as listener
  if (listenerWs) listenerWs.close();
  const wsProto = getWsProtocol();
  listenerWs = new WebSocket(`${wsProto}//${location.host}/ws?role=listener&room=${code}`);
  
  listenerWs.onopen = () => {
    console.log('Listener connected to signaling server');
  };

  listenerWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'welcome') {
      listenerId = msg.id;
      console.log('Listener ID:', msg.id);
      enterConnectedState();
    } else if (msg.type === 'offer') {
      // Host sent an offer with audio
      handleOfferFromHost(msg.offer);
    } else if (msg.type === 'ice-candidate') {
      // Host sent ICE candidate
      if (listenerPeerConnection && msg.candidate) {
        listenerPeerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
          .catch(err => console.error('Failed to add ICE candidate:', err));
      }
    } else if (msg.type === 'host-disconnected') {
      // Host closed the party
      joinErrEl.textContent = 'Host cancelled the party';
      if (listenerPeerConnection) listenerPeerConnection.close();
      listenerPeerConnection = null;
      listenerWs.close();
      setTimeout(() => showView('view-landing'), 2000);
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
});

document.getElementById('scanBtn').addEventListener('click', () => {
  joinErrEl.textContent = 'Camera scanning isn\'t wired up yet — enter the code manually for now.';
});

document.getElementById('exitPartyBtn').addEventListener('click', () => {
  // Close peer connection and WebSocket
  if (listenerPeerConnection) {
    listenerPeerConnection.close();
    listenerPeerConnection = null;
  }
  if (listenerWs && listenerWs.readyState === WebSocket.OPEN) {
    listenerWs.close();
  }
  listenerWs = null;
  // Return to landing page
  showView('view-landing');
});

// ---------- Connected state (listener) ----------
const statusPanel = document.getElementById('statusPanel');
function enterConnectedState() {
  statusPanel.classList.add('is-live');
  document.getElementById('statusTitle').textContent = 'Connected';
  document.getElementById('statusSub').textContent =
    'Audio is streaming live. Put your headphones on to listen in.';
}

// Hidden audio element for playing remote stream
let remoteAudio = null;

function initRemoteAudio() {
  if (!remoteAudio) {
    remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    remoteAudio.controls = false;
  }
  return remoteAudio;
}

// Handle offer from host (listener side)
async function handleOfferFromHost(offer) {
  try {
    if (!listenerPeerConnection) {
      listenerPeerConnection = new RTCPeerConnection(rtcConfig);
      const audio = initRemoteAudio();

      // Handle remote audio track
      listenerPeerConnection.ontrack = (event) => {
        console.log('Received remote audio track');
        // Set the remote stream to the audio element for playback
        audio.srcObject = event.streams[0];
        audio.play().catch(err => console.error('Failed to play audio:', err));
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
        console.log(`Peer connection state: ${listenerPeerConnection.connectionState}`);
      };
    }

    // Set remote description (the offer from host)
    await listenerPeerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // Create and send answer
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
  if (restoreRoomState()) {
    // Reconnect to the same room if it was saved
    console.log('Restoring room:', currentRoomCode);
    
    // Update UI to show the room
    freqCodeEl.textContent = currentRoomCode.slice(0, 3) + ' ' + currentRoomCode.slice(3);
    listenerListEl.innerHTML = '';
    updateLobbyCount(0);
    createErrEl.textContent = '';
    startPartyBtn.disabled = false;
    startPartyBtn.textContent = 'Start the Party';
    
    showView('view-create');
    
    // Reconnect WebSocket
    if (hostWs) hostWs.close();
    const wsProto = getWsProtocol();
    hostWs = new WebSocket(`${wsProto}//${location.host}/ws?role=host&room=${currentRoomCode}`);
    
    hostWs.onopen = () => {
      console.log('Host reconnected to signaling server');
    };

    hostWs.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'listener-join') {
        addListenerRow(msg.id, 'Guest ' + (listenerListEl.children.length + 1));
        if (hostStream) {
          createPeerConnectionForListener(msg.id, hostStream.getTracks()[0]);
        }
      } else if (msg.type === 'listener-leave') {
        removeListenerRow(msg.id);
        const pc = hostPeerConnections.get(msg.id);
        if (pc) {
          pc.close();
          hostPeerConnections.delete(msg.id);
        }
      }
    };

    hostWs.onerror = (err) => {
      console.error('Host WebSocket error:', err);
      createErrEl.textContent = 'Failed to reconnect to server';
    };

    hostWs.onclose = () => {
      console.log('Host disconnected from server');
      hostWs = null;
    };
  }
})();

// ---------- Handle tab close / page unload ----------
window.addEventListener('beforeunload', () => {
  // Close host WebSocket to notify all listeners
  if (hostWs) {
    hostWs.close();
  }
  // Close listener WebSocket
  if (listenerWs) {
    listenerWs.close();
  }
  // Close peer connections
  for (const pc of hostPeerConnections.values()) {
    pc.close();
  }
  if (listenerPeerConnection) {
    listenerPeerConnection.close();
  }
});

// ---------- Profile Modal Initialization ----------
(function initProfileModal() {
  const profileModal = document.getElementById('profileModal');
  const closeProfileBtn = document.getElementById('closeProfileBtn');
  const profileNameInput = document.getElementById('profileName');
  const generateNameBtn = document.getElementById('generateNameBtn');
  const avatarGrid = document.getElementById('avatarGrid');
  const saveProfileBtn = document.getElementById('saveProfileBtn');

  // Create avatar options
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

  // Initialize profile display
  profileNameInput.value = userProfile.name;

  // Close modal
  closeProfileBtn.addEventListener('click', () => {
    profileModal.style.display = 'none';
  });

  // Generate new name
  generateNameBtn.addEventListener('click', () => {
    const newName = generateCoolName();
    profileNameInput.value = newName;
  });

  // Save profile
  saveProfileBtn.addEventListener('click', () => {
    const newName = profileNameInput.value.trim() || generateCoolName();
    const selectedAvatar = document.querySelector('.avatar-option.selected');
    const newAvatar = selectedAvatar ? selectedAvatar.textContent : userProfile.avatar;
    
    userProfile = updateProfile(newName, newAvatar);
    profileModal.style.display = 'none';
  });

  // Expose function to open profile modal
  window.openProfileModal = () => {
    profileNameInput.value = userProfile.name;
    profileModal.style.display = 'flex';
  };

  // Close modal when clicking outside
  profileModal.addEventListener('click', (e) => {
    if (e.target === profileModal) {
      profileModal.style.display = 'none';
    }
  });
})();
