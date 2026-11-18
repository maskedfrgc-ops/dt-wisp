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


// ---------- AI proxy: the page asks THIS server, and this server asks the AI company ----------
// Keys live in Render's Environment settings (never in the page). Set GROQ_API_KEY and/or GEMINI_API_KEY.
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const list2 = (v, d) => (v || d).split(",").map((x) => x.trim()).filter(Boolean);
const GROQ_TEXT = list2(process.env.GROQ_MODELS, "llama-3.3-70b-versatile,llama-3.1-8b-instant");
const GROQ_VISION = list2(process.env.GROQ_VISION_MODELS, "meta-llama/llama-4-scout-17b-16e-instruct");
const GEMINI_MODELS = list2(process.env.GEMINI_MODELS, "gemini-3.5-flash-lite,gemini-3.8-flash");
const MAX_BODY = 12 * 1024 * 1024;
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30; // 30 questions per minute per person
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too big"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function callGroq(model, system, msgs, image) {
  const messages = [{ role: "system", content: system }];
  msgs.forEach((m, i) => {
    if (image && i === msgs.length - 1 && m.role === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + image } }] });
    } else messages.push({ role: m.role, content: m.content });
  });
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + GROQ_KEY },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1500 }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((j && j.error && j.error.message) || "error " + r.status), { status: r.status });
  const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!t || !t.trim()) throw Object.assign(new Error("empty"), { status: 0 });
  return t;
}

async function callGemini(model, system, msgs, image) {
  const contents = [];
  msgs.forEach((m, i) => {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [{ text: m.content }];
    if (image && i === msgs.length - 1 && role === "user") parts.push({ inlineData: { mimeType: "image/jpeg", data: image } });
    if (contents.length && contents[contents.length - 1].role === role) contents[contents.length - 1].parts.push(...parts);
    else contents.push({ role, parts });
  });
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((j && j.error && j.error.message) || "error " + r.status), { status: r.status });
  const c = j && j.candidates && j.candidates[0];
  const t = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || "").join("") : "";
  if (!t.trim()) throw Object.assign(new Error("empty"), { status: 0 });
  return t;
}

async function answer(system, msgs, image) {
  const tries = [];
  if (GROQ_KEY) (image ? GROQ_VISION : GROQ_TEXT).forEach((m) => tries.push(() => callGroq(m, system, msgs, image)));
  if (GEMINI_KEY) GEMINI_MODELS.forEach((m) => tries.push(() => callGemini(m, system, msgs, image)));
  if (!tries.length) throw Object.assign(new Error("the AI isn't set up on the server yet (add GROQ_API_KEY in Render)"), { status: 503 });
  let last = null;
  for (const t of tries) {
    try {
      return await t();
    } catch (e) {
      last = e;
      console.error("AI try failed:", e.message);
    }
  }
  throw last;
}

async function handleAi(req, res) {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== "POST") return send(405, { error: "POST only" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(429, { error: "slow down a little, too many questions" });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return send(400, { error: "bad request" });
  }
  let msgs = Array.isArray(body.messages) ? body.messages : [];
  msgs = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send(400, { error: "no question" });
  const system = typeof body.system === "string" && body.system.trim() ? body.system.slice(0, 4000) : "You are a helpful assistant.";
  const image = typeof body.image === "string" && /^[A-Za-z0-9+/=]+$/.test(body.image) ? body.image : "";
  try {
    send(200, { reply: await answer(system, msgs, image) });
  } catch (e) {
    send(e.status && e.status >= 400 && e.status < 600 ? e.status : 502, { error: e.message || "the AI had a problem" });
  }
}

// ---------- online counter + who's online + typing indicator ----------
// Every open Dark Terminal page checks in here every 30 seconds (every 1.5 seconds while the Chat tab is open).
const online = new Map(); // visitor id -> { t: last check-in, name: chat username or "", guest: guest number }
const ONLINE_WINDOW = 90 * 1000; // counted as online if they checked in within the last 90 seconds
const typingNow = new Map(); // chat username -> time they stop counting as "typing"

function cleanName(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
}
function pruneOnline() {
  const now = Date.now();
  for (const [id, v] of online) if (now - v.t > ONLINE_WINDOW) online.delete(id);
}
function freeGuestNumber() {
  const used = new Set();
  for (const v of online.values()) if (v.guest) used.add(v.guest);
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
// everyone online: chat users first (A-Z, each name once even on two devices), then guest1, guest2...
function onlinePeople() {
  pruneOnline();
  const names = new Set(), guests = [];
  for (const v of online.values()) {
    if (v.name) names.add(v.name);
    else if (v.guest) guests.push(v.guest);
  }
  const users = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  guests.sort((a, b) => a - b);
  return users.map((name) => ({ name })).concat(guests.map((g) => ({ name: "guest" + g, guest: true })));
}
function checkIn(body) {
  const id = typeof body.id === "string" && /^[a-z0-9]{8,40}$/.test(body.id) ? body.id : "";
  if (!id) return null;
  if (body.leave) {
    online.delete(id);
    return null;
  }
  pruneOnline();
  let v = online.get(id);
  if (!v) {
    if (online.size >= 50000) return null;
    v = { t: 0, name: "", guest: 0 };
    online.set(id, v);
  }
  v.t = Date.now();
  v.name = cleanName(body.name);
  if (v.name) v.guest = 0;
  else if (!v.guest) v.guest = freeGuestNumber();
  return v;
}
async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || "{}") || {};
  } catch (e) {
    return {};
  }
}
function sendJson(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
async function handleOnline(req, res) {
  let me = null;
  if (req.method === "POST") me = checkIn(await readJson(req));
  const people = onlinePeople();
  sendJson(res, {
    online: people.length,
    you: me ? me.name || "guest" + me.guest : "",
    people: people.slice(0, 300),
  });
}
async function handleTyping(req, res) {
  if (req.method !== "POST") return sendJson(res, { typing: [] });
  const body = await readJson(req);
  const me = checkIn(body); // also keeps them on the online list
  const name = me ? me.name : "";
  const now = Date.now();
  if (name) {
    if (body.typing === true) typingNow.set(name, now + 5000);
    else typingNow.delete(name);
  }
  const list = [];
  for (const [n, until] of typingNow) {
    if (until < now) typingNow.delete(n);
    else if (n !== name) list.push(n);
  }
  sendJson(res, { typing: list.slice(0, 10) });
}

// ---------- game list relay: /gn/<assets|covers|html>/<path> -> jsdelivr (for networks that block the CDN) ----------
const GN_REPOS = { assets: "freebuisness/assets@main", covers: "freebuisness/covers@main", html: "freebuisness/html@main" };
const gnCache = new Map(); // small in-memory cache for the game list and html files
async function handleGn(urlPath, res) {
  const m = urlPath.match(/^\/gn\/(assets|covers|html)\/([A-Za-z0-9._\-@ %+()\/]+)$/);
  if (!m || m[2].includes("..")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const target = "https://cdn.jsdelivr.net/gh/" + GN_REPOS[m[1]] + "/" + m[2];
  const hit = gnCache.get(target);
  const send = (type, buf, ttl) => {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=" + ttl, "Access-Control-Allow-Origin": "*" });
    res.end(buf);
  };
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return send(hit.type, hit.buf, m[1] === "assets" ? 600 : 86400);
  try {
    const r = await fetch(target);
    if (!r.ok) {
      res.writeHead(r.status === 404 ? 404 : 502, { "Content-Type": "text/plain" });
      res.end("upstream " + r.status);
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("too big");
      return;
    }
    const type = r.headers.get("content-type") || "application/octet-stream";
    if (m[1] !== "covers" || gnCache.size < 300) gnCache.set(target, { t: Date.now(), type, buf });
    if (gnCache.size > 600) gnCache.clear();
    send(type, buf, m[1] === "assets" ? 600 : 86400);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("couldn't reach the game host");
  }
}

const server = http.createServer((req, res) => {
  let urlPath = "/";
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (e) {}
  if (urlPath.startsWith("/gn/")) {
    handleGn(urlPath, res);
    return;
  }
  if (urlPath === "/api/ai") {
    handleAi(req, res);
    return;
  }
  if (urlPath === "/api/online" || urlPath === "/api/typing") {
    (urlPath === "/api/online" ? handleOnline : handleTyping)(req, res).catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("{}");
    });
    return;
  }
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
