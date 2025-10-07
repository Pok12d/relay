

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { URL } from "url";

const app = express();
app.get("/", (req,res) => res.send("Relay server alive"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/intercept" });

// Map of browser websocket -> { connId -> serverWs }
const browserMaps = new Map(); // ws(browser) => Map(connId => serverWs)

wss.on("connection", (clientWs, req) => {
  const remote = req.socket.remoteAddress + ":" + req.socket.remotePort;
  console.log("[relay] browser connected:", remote);

  // create empty map for this browser connection
  browserMaps.set(clientWs, new Map());

  clientWs.on("message", async (data) => {
    // control messages are JSON text
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) {
      console.warn("[relay] invalid json from browser:", e);
      return;
    }

    const { type, connId, target, protocols, isBinary, payload, code, reason } = msg;

    // validate connId presence for most messages
    if (!connId && type !== "open") {
      console.warn("[relay] missing connId", msg);
      return;
    }

    if (type === "open") {
      // Browser requests opening a server-side websocket to `target`
      try {
        const u = new URL(target);
        if (!/\.?exitgames\.com$/i.test(u.hostname)) {
          clientWs.send(JSON.stringify({ type:"error", connId, message:"target not allowed" }));
          return;
        }
      } catch (e) {
        clientWs.send(JSON.stringify({ type:"error", connId, message:"invalid target url" }));
        return;
      }

      // create server ws to target
      const WebSocket = (await import("ws")).WebSocket;
      const serverWs = new WebSocket(target, protocols || []);

      // store mapping
      browserMaps.get(clientWs).set(connId, serverWs);

      serverWs.on("open", () => {
        // notify browser stub that open succeeded
        clientWs.send(JSON.stringify({ type: "open", connId }));
        console.log(`[relay] opened ${target} for connId ${connId}`);
      });

      serverWs.on("message", (msgData, isBinaryFrm) => {
        // forward to browser; if binary -> base64 encode
        if (isBinaryFrm) {
          const b64 = Buffer.from(msgData).toString("base64");
          clientWs.send(JSON.stringify({ type: "message", connId, isBinary: true, payload: b64 }));
        } else {
          // text message
          clientWs.send(JSON.stringify({ type: "message", connId, isBinary: false, payload: msgData.toString() }));
        }
      });

      serverWs.on("close", (c, r) => {
        clientWs.send(JSON.stringify({ type: "close", connId, code: c, reason: r }));
        browserMaps.get(clientWs).delete(connId);
        console.log(`[relay] serverWs closed for connId ${connId} (${c})`);
      });

      serverWs.on("error", (err) => {
        clientWs.send(JSON.stringify({ type: "error", connId, message: String(err) }));
        console.error("[relay] serverWs error for connId", connId, err);
      });

    } else if (type === "send") {
      // Browser instructs server to send payload to serverWs
      const m = browserMaps.get(clientWs);
      if (!m) return;
      const serverWs = m.get(connId);
      if (!serverWs) {
        clientWs.send(JSON.stringify({ type:"error", connId, message:"no such connection" }));
        return;
      }
      if (isBinary) {
        // payload is base64
        const buf = Buffer.from(payload, "base64");
        serverWs.send(buf, { binary: true }, (err) => {
          if (err) clientWs.send(JSON.stringify({ type:"error", connId, message:String(err) }));
        });
      } else {
        serverWs.send(payload, (err) => {
          if (err) clientWs.send(JSON.stringify({ type:"error", connId, message:String(err) }));
        });
      }
    } else if (type === "close") {
      // Close server side WS
      const m = browserMaps.get(clientWs);
      if (!m) return;
      const serverWs = m.get(connId);
      if (serverWs && serverWs.readyState !== serverWs.CLOSED) {
        try { serverWs.close(code || 1000, reason || "client requested close"); }
        catch(e){}
      }
      // send close ack
      clientWs.send(JSON.stringify({ type: "close", connId, code: code || 1000, reason: reason || "closed" }));
      m.delete(connId);
    } else {
      clientWs.send(JSON.stringify({ type: "error", message: "unknown type" }));
    }

  });

  clientWs.on("close", () => {
    console.log("[relay] browser disconnected:", remote);
    // cleanup: close all serverWs
    const m = browserMaps.get(clientWs);
    if (m) {
      for (const [connId, serverWs] of m) {
        try { serverWs.close(); } catch(e) {}
      }
    }
    browserMaps.delete(clientWs);
  });

  clientWs.on("error", (err) => {
    console.error("[relay] browser socket error", err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`[relay] listening on :${PORT} (wss path /intercept)`));
