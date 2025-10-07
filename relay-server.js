// relay-server-debug.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { URL } from "url";

const app = express();
app.get("/", (req,res) => res.send("Relay server alive (debug)"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/intercept" });

// Map of browser ws -> connId -> serverWs
const browserMaps = new Map();

wss.on("connection", (clientWs, req) => {
  console.log("[relay] Browser connected:", req.socket.remoteAddress);
  browserMaps.set(clientWs, new Map());

  clientWs.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) {
      console.warn("[relay] Invalid JSON from browser:", e);
      return;
    }

    const { type, connId, target, protocols, isBinary, payload, code, reason } = msg;

    if (!connId && type !== "open") return;

    if (type === "open") {
      console.log(`[relay DEBUG] Browser wants to open URL: ${target} (connId: ${connId})`);

      // Send debug back to browser console
      clientWs.send(JSON.stringify({
        type: "debug",
        connId,
        message: `[relay debug] Received URL: ${target}`
      }));

      // Optional: actually open server WebSocket (still proxies)
      const WebSocket = (await import("ws")).WebSocket;
      const serverWs = new WebSocket(target, protocols || []);
      browserMaps.get(clientWs).set(connId, serverWs);

      serverWs.on("open", () => clientWs.send(JSON.stringify({ type: "open", connId })));
      serverWs.on("message", (msgData, isBinaryFrm) => {
        if (isBinaryFrm) {
          clientWs.send(JSON.stringify({ type: "message", connId, isBinary: true, payload: Buffer.from(msgData).toString("base64") }));
        } else {
          clientWs.send(JSON.stringify({ type: "message", connId, isBinary: false, payload: msgData.toString() }));
        }
      });
      serverWs.on("close", (c,r) => {
        clientWs.send(JSON.stringify({ type: "close", connId, code: c, reason: r }));
        browserMaps.get(clientWs).delete(connId);
      });
      serverWs.on("error", (err) => {
        clientWs.send(JSON.stringify({ type: "error", connId, message: String(err) }));
        console.error("[relay] Server WS error:", err);
      });

    } else if (type === "send") {
      const m = browserMaps.get(clientWs);
      if (!m) return;
      const serverWs = m.get(connId);
      if (!serverWs) return;
      if (isBinary) {
        serverWs.send(Buffer.from(payload, "base64"), { binary: true });
      } else {
        serverWs.send(payload);
      }
    } else if (type === "close") {
      const m = browserMaps.get(clientWs);
      if (!m) return;
      const serverWs = m.get(connId);
      if (serverWs && serverWs.readyState !== serverWs.CLOSED) serverWs.close(code || 1000, reason || "client requested close");
      clientWs.send(JSON.stringify({ type: "close", connId, code: code || 1000, reason: reason || "closed" }));
      m.delete(connId);
    }
  });

  clientWs.on("close", () => {
    console.log("[relay] Browser disconnected");
    const m = browserMaps.get(clientWs);
    if (m) for (const [, serverWs] of m) try { serverWs.close(); } catch(e){}
    browserMaps.delete(clientWs);
  });

  clientWs.on("error", (err) => console.error("[relay] Browser socket error:", err));
});

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0"; // Bind to all interfaces for Render
server.listen(PORT, HOST, () => console.log(`[relay DEBUG] Listening on ${HOST}:${PORT}`));

