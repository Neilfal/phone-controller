# Tilt Controller: Anything but a Game Controller

Turn your phone into a real-time motion controller for a browser game on your laptop. Tilt the phone to roll the ball, shake it to jump.

- **Live game (laptop):** `https://YOUR-APP.onrender.com/host.html`
- **Android APK:** [`releases/app-debug.apk`](releases/app-debug.apk) (or the GitHub Releases page)
- **Demo video:** `ADD-LINK-HERE`

---

## How to play (quick steps)

1. On your **laptop**, open the live game link above. A room code and QR code appear.
2. On your **Android phone**, install the APK and open **Tilt Controller**.
3. Type the 4-letter room code and tap **Join**. Allow motion access if asked.
4. The pairing screen disappears and both devices show a green "connected" badge.
5. **Tilt** the phone to roll the blue ball into the yellow star.
6. **Shake** the phone (or tap **JUMP**) to hop over the red pits.
7. Tap **Calibrate** any time to set your current holding position as neutral.

Tip: hold the phone like a tray, tilted slightly toward you, not fully upright.

---

## Features

| Requirement | How it is done |
|---|---|
| Gyroscope and accelerometer mapped to controls | `deviceorientation` gives tilt (steering), `devicemotion` gives acceleration (shake = jump) |
| Pairing via QR or room code | Laptop shows a 4-character code and a QR code that opens the phone page with the code pre-filled |
| Real-time streaming over WebSockets | Phone sends ~60 packets per second to a Node.js relay server, which forwards them to the laptop |
| Browser game controlled by the phone | Canvas ball game with a goal and hazards, driven entirely by phone input |
| Calibration | Calibrate button stores the current tilt as the neutral position and subtracts it from every reading |
| Connection status and auto-reconnect | Status badges on both devices; both sides reconnect automatically with exponential backoff |

**Bonus items included:** vibration feedback (phone buzzes when you collect a star, fall in a pit, or jump), on-screen JUMP button, and a live latency display.

---

## Tech stack

- **Phone app:** HTML/JavaScript page using the browser sensor APIs, packaged as an Android APK with **Capacitor**
- **Game (laptop):** HTML5 Canvas + vanilla JavaScript
- **Server:** Node.js, **Express** (static files and QR images), **ws** (WebSockets), **qrcode** (QR generation)
- **Hosting:** Render (any Node host works)

---

## Architecture

```
 Phone (Android app)                Server (Node.js)               Laptop (browser)
 +------------------+   WebSocket   +----------------+  WebSocket  +------------------+
 | sensors -> tilt  | ------------> |  room "AB7K"   | ----------> |  game + canvas   |
 | calibrate/filter |               |  relays only   |             |  QR + status     |
 | vibration        | <------------ |  the latest    | <---------- |  vibrate cmds    |
 +------------------+   vibrate     +----------------+    ping     +------------------+
```

### Pairing approach

1. The laptop connects and sends `create`. The server makes a random 4-character room code (letters and digits without look-alikes such as `0/O` and `1/I`) and replies with it.
2. The laptop shows the code and a QR code that points to `/phone.html?room=CODE`.
3. The phone sends `join` with the code. The server links the two sockets in one room and tells the laptop the phone is connected.
4. From then on the server only relays messages inside that room. One phone per room.

### Latency approach

- **Small packets:** each sensor message is a tiny JSON object (`x`, `y`, `shake`, timestamp).
- **High send rate:** the phone sends about 60 times per second.
- **Low smoothing delay:** a light low-pass filter removes jitter without adding noticeable lag.
- **No Nagle delay:** the server calls `setNoDelay(true)` on every socket so small packets are sent immediately.
- **Latest value wins:** the game always uses the most recent tilt and never queues old packets.
- **Snappy physics:** the ball uses frame-rate-independent drag, so it reacts and stops quickly.
- **Measured, not guessed:** a ping/pong round trip runs every second and the latency is shown on screen.

### Calibration and orientation

Raw `gamma`/`beta` angles are converted to "tilt as seen on the phone screen" for the current rotation (portrait or landscape), then the calibrated neutral position is subtracted. The app locks to landscape and recalibrates automatically when the phone is rotated.

### Reconnection

- **Phone:** if the socket drops, it retries after 1s, 2s, 4s, up to 8s, and re-joins the same room automatically.
- **Laptop:** reconnects the same way and sends `resume` with its saved room code.
- **Server:** keeps a room alive for 30 seconds after the laptop disconnects, and removes dead sockets with a 10-second heartbeat.

---

## Message protocol

| Direction | Message | Purpose |
|---|---|---|
| laptop -> server | `{type:"create"}` | make a room |
| laptop -> server | `{type:"resume", code}` | reclaim a room after a drop |
| phone -> server | `{type:"join", code}` | join a room |
| phone -> server -> laptop | `{type:"s", x, y, shake, t}` | sensor data |
| laptop -> server -> phone | `{type:"vibrate", ms}` | vibration feedback |
| either -> server | `{type:"ping", t}` / `{type:"pong", t}` | latency measurement |
| server -> peers | `{type:"peer", connected}` | connection status |

---

## Repository structure

```
phone-controller/
  server.js            WebSocket relay + static file server + QR endpoint
  package.json
  public/
    host.html          Laptop page: pairing screen + game
    phone.html         Phone controller page (sensors, calibration, reconnect)
  phone-app/           Capacitor project that wraps phone.html as an Android app
    capacitor.config.json
    www/index.html
    android/           Generated Android Studio project
  releases/
    app-debug.apk      Built Android app
```

---

## Run it locally

You need [Node.js](https://nodejs.org) (LTS).

```bash
git clone https://github.com/Neilfal/phone-controller.git
cd phone-controller
npm install
npm start
```

Open `http://localhost:3000/host.html`. You can test the game right away with the arrow keys and Space.

**Testing with a real phone:** phones only allow motion sensors on HTTPS, so a plain `http://192.168.x.x` link will not work. Open a second terminal and run:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Use the `https://...trycloudflare.com` address it prints: open `/host.html` on that address on the laptop, then scan the QR code with the phone.

---

## Deploy the server (Render)

1. Push the repo to GitHub.
2. On render.com choose **New > Web Service** and select this repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Pick the free plan and the region closest to you, then deploy.
5. Open `https://YOUR-APP.onrender.com/host.html`.

The free plan sleeps when idle, so the first load can take about 30 seconds.

---

## Build the Android APK

1. Deploy the server first and note its address.
2. In `phone-app/capacitor.config.json`, set `server.url` to `https://YOUR-APP.onrender.com/phone.html`.
3. In `phone-app/android/app/src/main/AndroidManifest.xml`, make sure it contains:
   - `<uses-permission android:name="android.permission.VIBRATE" />` above `<application`
   - `android:screenOrientation="sensorLandscape"` inside the `<activity` tag
4. Install [Android Studio](https://developer.android.com/studio).
5. In a terminal inside `phone-app`:
   ```bash
   npm install
   npx cap sync
   npx cap open android
   ```
6. In Android Studio, wait for the Gradle sync, then choose **Build > Generate App Bundles or APKs > Generate APKs**.
7. The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## Known limitations

- One phone per room (local multiplayer with several phones is not implemented).
- The Android app loads the controller page from the deployed server, so it needs an internet connection.
- The free Render plan may take about 30 seconds to wake up on first use.
- Hold the phone like a tray. Tilt readings are unreliable when the phone is held fully upright on its side.
