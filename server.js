// Dark Terminal - Wisp proxy server.
// Gives the Scramjet browser a way to reach the internet.
// Also serves any files in a folder called "public" (optional).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = path.normalize(path.join(publicDir, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Dark Terminal wisp server is running.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

// every websocket connection is treated as a Wisp connection, whatever the path is
server.on("upgrade", (req, socket, head) => {
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, () => {
  console.log("Wisp server listening on port " + PORT);
});
