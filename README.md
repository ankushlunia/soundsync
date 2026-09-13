# SoundSync — Beginner Edition

A clean, highly readable, and educational implementation of **SoundSync** ("Silent Broadcast"). 

This project demonstrates how to build a **real-time audio broadcasting system** using **WebRTC**, **WebSockets**, and the **Web Audio API**.

---

## 📁 File Structure & Purpose

| File | Purpose |
|---|---|
| [`server.js`](file:///Users/ankushlunia/Desktop/soundsync/beginer_one/server.js) | Node.js signaling server. Manages rooms and routes WebRTC SDP offers/answers between clients. |
| [`public/index.html`](file:///Users/ankushlunia/Desktop/soundsync/beginer_one/public/index.html) | Clean, beginner-friendly HTML layout with 3 clear views (Role Select, Host Room, Join Room). |
| [`public/app.js`](file:///Users/ankushlunia/Desktop/soundsync/beginer_one/public/app.js) | Beginner-friendly JavaScript file containing Host WebRTC creation, Listener WebAudio pipeline, and NTP Sync. |
| [`public/style.css`](file:///Users/ankushlunia/Desktop/soundsync/beginer_one/public/style.css) | Minimalist CSS for clean component layout and responsive design. |

---

## 🚀 How to Run

1. Open your terminal in this folder:
   ```bash
   cd beginer_one
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser:
   - **Host (Laptop/PC/TV)**: Open `http://localhost:3000`
   - **Listeners (Phones/Headphones on same Wi-Fi)**: Open `http://<YOUR_LOCAL_IP>:3000`

---

## 💡 Key Educational Concepts Included

1. **Multi-Room WebSocket Signaling**: Server maps rooms via `rooms = new Map()` so multiple broadcasts can run independently.
2. **WebRTC Direct P2P Media**: Audio stream (`MediaStreamTrack`) bypasses the Node.js server and streams directly over Wi-Fi.
3. **Cross-Platform Audio Engine**: Supports Tab Capture (Desktop), Microphone/Aux (Mobile/TV), Audio Files (MP3), and Stream URLs.
4. **Zero Double-Echo Pipeline**: Combines muted `<audio>` element for iOS Safari background media sessions with single Web Audio `AudioContext` output.
