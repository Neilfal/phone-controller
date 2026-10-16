// Pairing + relay server.
// The laptop ("host") creates a room, the phone joins it with the code,
// and the server forwards sensor packets from phone -> host.
//
// Message protocol (JSON):
//   host  -> server : {type:"create"}                 -> {type:"created", code}
//   host  -> server : {type:"resume", code}           -> {type:"created", code} | {type:"error"}
//   phone -> server : {type:"join", code}             -> {type:"joined"} | {type:"error", reason}
//   phone -> server : {type:"s", ...sensor fields}    (relayed as-is to host)
//   either-> server : {type:"ping", t}                -> {type:"pong", t}
//   server-> peers  : {type:"peer", connected:true|false}

const express = require("express");
const http = require("http");
const path = require("path");
const QRCode = require("qrcode");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const GRACE_MS = 30000; // keep a room alive this long after the host drops

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.redirect("/host.html"));

// /qr?text=... -> PNG QR code (so the laptop page needs no extra libraries)
app.get("/qr", async (req, res) => {
  try {
    const png = await QRCode.toBuffer(String(req.query.text || ""), { width: 300, margin: 1 });
    res.type("png").send(png);
  } catch {
    res.status(400).end();
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const rooms = new Map(); // code -> { host, phone, timer }

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/I)
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

wss.on("connection", (ws) => {
  ws._socket.setNoDelay(true); // disable Nagle: send small packets immediately
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Latency probe: echo straight back
    if (msg.type === "ping") return send(ws, { type: "pong", t: msg.t });

    // Hot path first: phone sensor packets go to the host untouched
    if (msg.type === "s") {
      const room = rooms.get(ws.room);
      if (room && ws.role === "phone") send(room.host, msg);
      return;
    }

    // Host -> phone: vibration feedback
    if (msg.type === "vibrate") {
      const room = rooms.get(ws.room);
      if (room && ws.role === "host") send(room.phone, msg);
      return;
    }

    if (msg.type === "create") {
      const code = makeCode();
      rooms.set(code, { host: ws, phone: null, timer: null });
      ws.role = "host"; ws.room = code;
      return send(ws, { type: "created", code });
    }

    if (msg.type === "resume") { // host reconnecting after a drop
      const room = rooms.get(msg.code);
      if (!room) return send(ws, { type: "error", reason: "room_expired" });
      clearTimeout(room.timer);
      room.host = ws; ws.role = "host"; ws.room = msg.code;
      send(ws, { type: "created", code: msg.code });
      return send(ws, { type: "peer", connected: !!room.phone });
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "error", reason: "no_such_room" });
      if (room.phone && room.phone !== ws && room.phone.readyState === 1) {
        return send(ws, { type: "error", reason: "room_full" });
      }
      room.phone = ws; ws.role = "phone"; ws.room = code;
      send(ws, { type: "joined" });
      send(room.host, { type: "peer", connected: true });
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.role === "phone" && room.phone === ws) {
      room.phone = null;
      send(room.host, { type: "peer", connected: false });
    } else if (ws.role === "host" && room.host === ws) {
      // keep the room for a grace period so the host can resume
      send(room.phone, { type: "peer", connected: false });
      room.timer = setTimeout(() => rooms.delete(ws.room), GRACE_MS);
    }
  });
});

// Drop dead connections (e.g. phone went to sleep) every 10s
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
