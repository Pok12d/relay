// relay-server.js
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.get("/", (req, res) => res.send("Relay server alive"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/intercept" });

// Map: browserWS -> connId -> serverWS
const browserMaps = new Map();

wss.on("connection", (browserWs, req) => {
  console.log("[relay] Browser connected:", req.socket.remoteAddress);
  browserMaps.set(browserWs, new Map());

  browserWs.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) {
      console.warn("[relay] Invalid JSON from browser:", e);
      return;
    }

    const { type, connId, target, protocols, isBinary, payload, code, reason } = msg;

    // Ignore messages without connId except 'open'
    if (!connId && type !== "open") return;

    if (type === "open") {
      console.log(`[relay] Browser wants to open: ${target} (connId: ${connId})`);
      
      // Open real WebSocket to ExitGames
      const serverWs = new WebSocket(target, protocols || []);
      browserMaps.get(browserWs).set(connId, serverWs);

      // Forward open
      serverWs.on("open", () => {
        console.log(`[relay] Connected to target: ${target}`);
        browserWs.send(JSON.stringify({ type: "open", connId }));
      });

      // Forward messages both ways
      serverWs.on("message", (msgData, isBinaryFrm) => {
        if (isBinaryFrm) {
          browserWs.send(JSON.stringify({ type: "message", connId, isBinary: true, payload: Buffer.from(msgData).toString("base64") }));
        } else {
          browserWs.send(JSON.stringify({ type: "message", connId, isBinary: false, payload: msgData.toString() }));
        }
      });

      // Forward close
      serverWs.on("close", (c,r) => {
        browserWs.send(JSON.stringify({ type: "close", connId, code: c, reason: r }));
        browserMaps.get(browserWs).delete(connId);
      });

      // Forward error
      serverWs.on("error", (err) => {
        browserWs.send(JSON.stringify({ type: "error", connId, message: String(err) }));
        console.error("[relay] Server WS error:", err);
      });

    } else if (type === "send") {
      const m = browserMaps.get(browserWs);
      if (!m) return;
      const serverWs = m.get(connId);
      if (!serverWs) return;

      if (isBinary) serverWs.send(Buffer.from(payload, "base64"), { binary: true });
      else serverWs.send(payload);

    } else if (type === "close") {
      const m = browserMaps.get(browserWs);
      if (!m) return;
      const serverWs = m.get(connId);
      if (serverWs && serverWs.readyState !== serverWs.CLOSED) serverWs.close(code || 1000, reason || "client requested close");
      m.delete(connId);
      browserWs.send(JSON.stringify({ type: "close", connId, code: code || 1000, reason: reason || "closed" }));
    }
  });

  browserWs.on("close", () => {
    console.log("[relay] Browser disconnected");
    const m = browserMaps.get(browserWs);
    if (m) for (const [, serverWs] of m) try { serverWs.close(); } catch(e){}
    browserMaps.delete(browserWs);
  });

  browserWs.on("error", (err) => console.error("[relay] Browser WS error:", err));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`[relay] Listening on port ${PORT}`));
