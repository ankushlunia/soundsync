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
let hostStream = null; // captured tab/system audio, set when broadcasting starts

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

  // TODO: open WebSocket to signaling server as role=host with currentRoomCode
  // ws = new WebSocket(`${wsProto}://${location.host}/ws?role=host&room=${currentRoomCode}`)
  // On 'listener-join' messages -> addListenerRow(id, label)
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
    // Captures the movie tab's audio directly from the browser (see project
    // overview: getDisplayMedia with tab-audio sharing enabled by the host).
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
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

    // TODO: for each connected listener id, create an RTCPeerConnection,
    // addTrack(audioTracks[0], hostStream), create + send an offer.

  } catch (err) {
    createErrEl.textContent = 'Couldn\'t capture audio: ' + err.message;
  }
});

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
  showView('view-landing');
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

  // TODO: open WebSocket to signaling server as role=listener&room=${code}
  // On 'offer' -> create RTCPeerConnection, setRemoteDescription, answer.
  // On successful connection -> call enterConnectedState().
});

document.getElementById('scanBtn').addEventListener('click', () => {
  joinErrEl.textContent = 'Camera scanning isn\'t wired up yet — enter the code manually for now.';
});

// ---------- Connected state (listener) ----------
const statusPanel = document.getElementById('statusPanel');
function enterConnectedState() {
  statusPanel.classList.add('is-live');
  document.getElementById('statusTitle').textContent = 'Connected';
  document.getElementById('statusSub').textContent =
    'Audio is streaming live. Put your headphones on to listen in.';
}

// ---------- Deep link support (?code=XXXXXX from a scanned QR) ----------
(function checkDeepLink() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code && code.length === 6) {
    enterJoinRoom(code.toUpperCase());
  }
})();
