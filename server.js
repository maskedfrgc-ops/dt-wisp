// Dark Terminal - Wisp proxy server.
// Gives the Scramjet browser a way to reach the internet, and also serves your site files.
// It looks for your site in a folder called "public" first, then next to this file.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [path.join(here, "public"), here];
const PORT = Number(process.env.PORT) || 3000;
const HOME_NAMES = ["index.html", "justgames.html"];
const PRIVATE = /^(server\.js|package(-lock)?\.json|node_modules|\.git.*)$/i;

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

// the home page: index.html, justgames.html, or (browsers sometimes add numbers like "justgames (13).html") any .html file
function homeNames(root) {
  const names = HOME_NAMES.slice();
  try {
    for (const n of fs.readdirSync(root).sort()) {
      if (/\.html?$/i.test(n) && !names.includes(n)) names.push(n);
    }
  } catch (e) {}
  return names;
}

function find(urlPath) {
  const names = urlPath === "/" ? null : [urlPath];
  for (const root of roots) {
    for (const name of names || homeNames(root)) {
      const file = path.normalize(path.join(root, name));
      if (!file.startsWith(root)) continue;
      const rel = path.relative(here, file).split(path.sep);
      if (rel.some((part) => PRIVATE.test(part))) continue;
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch (e) {}
    }
  }
  return null;
}

function list(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !PRIVATE.test(n)).join(", ") || "(empty)";
  } catch (e) {
    return "(folder not found)";
  }
}

const server = http.createServer((req, res) => {
  let urlPath = "/";
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (e) {}
  const file = find(urlPath);
  if (!file) {
    res.writeHead(urlPath === "/" ? 200 : 404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      urlPath === "/"
        ? "Dark Terminal wisp server is running, but I can't find your site files.\n\n" +
            "I looked for index.html, justgames.html, or any .html file.\n" +
            "Files in the public folder: " + list(roots[0]) + "\n" +
            "Files next to server.js: " + list(here) + "\n"
        : "Not found"
    );
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(file).pipe(res);
});

// every websocket connection is treated as a Wisp connection, whatever the path is
server.on("upgrade", (req, socket, head) => {
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, () => {
  console.log("Wisp server listening on port " + PORT);
});
