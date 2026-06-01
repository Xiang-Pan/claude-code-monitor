#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import https from "https";
import pty from "node-pty";

import { Aggregator } from "./aggregator.js";
import { createWatcher } from "./watcher.js";
import { createCodexWatcher } from "./codex-watcher.js";
import { collectFromSSH, parseRemoteSessions } from "./ssh-collector.js";
import { collectTmuxLocal, collectTmuxSSH } from "./tmux-collector.js";
import { SSHPool } from "./ssh-pool.js";
import { resume, fork, close } from "./actions.js";
import { searchTranscripts, searchTranscriptsSSH } from "./search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Load config ─────────────────────────────────────────────
function loadConfig() {
  const configPath = process.env.CCM_CONFIG || path.join(ROOT, "config.json");

  // Fall back to example config if no config.json exists
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    const examplePath = path.join(ROOT, "config.example.json");
    try {
      raw = fs.readFileSync(examplePath, "utf-8");
      console.log("[config] No config.json found, using config.example.json");
    } catch {
      // Minimal default: local only
      console.log("[config] No config files found, using local-only defaults");
      return {
        hosts: [{ name: "local", mode: "local", claudeDir: "~/.claude" }],
        server: { port: 3456, pollIntervalMs: 3000 },
      };
    }
  }

  const config = JSON.parse(raw);

  // Env overrides
  if (process.env.CCM_PORT) config.server.port = parseInt(process.env.CCM_PORT);
  if (process.env.CCM_POLL_INTERVAL) {
    config.server.pollIntervalMs = parseInt(process.env.CCM_POLL_INTERVAL);
  }

  return config;
}

// ── Resolve ~ in paths ──────────────────────────────────────
function expandHome(p) {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME || "/root", p.slice(2));
  }
  return p;
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const port = config.server?.port || 3456;
  const pollInterval = config.server?.pollIntervalMs || 3000;

  console.log(`
  ⬡  Claude Code Monitor
  ─────────────────────────
  Hosts:    ${config.hosts.map((h) => h.name).join(", ")}
  Port:     ${port}
  Poll:     ${pollInterval}ms
  `);

  // ── Express app ──────────────────────────────────────────
  const app = express();

  // ── TLS / HTTPS support ─────────────────────────────────
  // Config: server.tls.cert / server.tls.key (file paths)
  // Or env: CCM_TLS_CERT / CCM_TLS_KEY
  // If no cert provided, auto-generates a self-signed cert
  const tlsConfig = config.server?.tls || {};
  const tlsCert = process.env.CCM_TLS_CERT || tlsConfig.cert || null;
  const tlsKey = process.env.CCM_TLS_KEY || tlsConfig.key || null;
  const enableHttps = !!(process.env.CCM_HTTPS || tlsConfig.enabled || tlsCert);

  let server;
  if (enableHttps) {
    let certPem, keyPem;
    if (tlsCert && tlsKey) {
      certPem = fs.readFileSync(path.resolve(ROOT, tlsCert));
      keyPem = fs.readFileSync(path.resolve(ROOT, tlsKey));
      console.log(`  TLS:      Using ${tlsCert}`);
    } else {
      // Auto-generate self-signed cert
      const certDir = path.join(ROOT, ".certs");
      const certPath = path.join(certDir, "server.crt");
      const keyPath = path.join(certDir, "server.key");
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        certPem = fs.readFileSync(certPath);
        keyPem = fs.readFileSync(keyPath);
        console.log("  TLS:      Using existing self-signed cert (.certs/)");
      } else {
        // Generate with openssl
        fs.mkdirSync(certDir, { recursive: true });
        const { execFileSync } = await import("child_process");
        execFileSync("openssl", [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes",
          "-keyout", keyPath, "-out", certPath,
          "-days", "365", "-subj", "/CN=localhost",
          "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ]);
        certPem = fs.readFileSync(certPath);
        keyPem = fs.readFileSync(keyPath);
        console.log("  TLS:      Generated self-signed cert (.certs/)");
      }
    }
    server = https.createServer({ cert: certPem, key: keyPem }, app);
  } else {
    server = http.createServer(app);
  }

  const proto = enableHttps ? "https" : "http";
  const wsProto = enableHttps ? "wss" : "ws";

  // ── Password auth ──────────────────────────────────────────
  const password = process.env.CCM_PASSWORD || config.server?.password || null;
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const validSessions = new Map(); // token → expiresAt

  function createSessionToken() {
    const token = crypto.randomBytes(32).toString("hex");
    validSessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  function validateSessionToken(token) {
    if (!token) return false;
    const expiresAt = validSessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) { validSessions.delete(token); return false; }
    return true;
  }

  // Prune expired tokens every hour
  setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of validSessions) { if (exp <= now) validSessions.delete(token); }
  }, 3600_000);

  function isAuthenticated(req) {
    if (!password) return true;
    const cookie = req.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)ccm_session=([^;]+)/);
    return !!(match && validateSessionToken(match[1]));
  }

  function isAuthenticatedWs(req) {
    if (!password) return true;
    const cookie = req.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)ccm_session=([^;]+)/);
    return !!(match && validateSessionToken(match[1]));
  }

  // Login endpoint
  app.use("/api/login", express.json());
  app.post("/api/login", (req, res) => {
    if (!password) return res.json({ ok: true });
    const { password: pw } = req.body || {};
    if (pw !== password) {
      return res.status(401).json({ error: "Wrong password" });
    }
    const token = createSessionToken();
    let cookie = `ccm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`;
    if (req.secure || (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") {
      cookie += "; Secure";
    }
    res.setHeader("Set-Cookie", cookie);
    res.json({ ok: true });
  });

  // Auth check endpoint (for client to test if authenticated)
  app.get("/api/auth", (req, res) => {
    if (!password) return res.json({ ok: true, authRequired: false });
    if (isAuthenticated(req)) return res.json({ ok: true, authRequired: true });
    return res.status(401).json({ error: "Not authenticated", authRequired: true });
  });

  // Auth middleware — protect everything except login, hook, and client-update
  app.use((req, res, next) => {
    if (!password) return next();
    // Skip auth for these paths (they have their own auth)
    if (req.path === "/api/login" || req.path === "/api/auth" ||
        req.path === "/api/hook" || req.path === "/api/client-update" ||
        req.path === "/api/health") {
      return next();
    }
    if (isAuthenticated(req)) return next();
    // For API requests, return 401 JSON
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    // For page requests, serve a login page
    return res.status(401).send(loginPageHtml());
  });

  function loginPageHtml() {
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — Claude Code Monitor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0c10; color: #c8cdd8; font-family: 'Inter', -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .login-box { background: #12151c; border: 1px solid #1e2330; border-radius: 12px; padding: 40px; width: 360px; text-align: center; }
  .login-box h1 { font-size: 20px; font-weight: 700; color: #e2e5eb; font-family: 'JetBrains Mono', monospace; margin-bottom: 8px; }
  .login-box .accent { color: #60a5fa; }
  .login-box p { font-size: 12px; color: #6b7280; margin-bottom: 24px; }
  .login-box input { width: 100%; padding: 10px 14px; border-radius: 6px; border: 1px solid #1e2330; background: #0a0c10; color: #c8cdd8; font-family: 'JetBrains Mono', monospace; font-size: 13px; outline: none; margin-bottom: 12px; }
  .login-box input:focus { border-color: #60a5fa; }
  .login-box button { width: 100%; padding: 10px; border-radius: 6px; border: none; background: #60a5fa; color: #0a0c10; font-weight: 600; font-size: 13px; cursor: pointer; font-family: 'JetBrains Mono', monospace; }
  .login-box button:hover { background: #93c5fd; }
  .error { color: #f87171; font-size: 12px; margin-bottom: 12px; display: none; font-family: monospace; }
</style>
</head><body>
<div class="login-box">
  <h1><span class="accent">⬡</span> Claude Code Monitor</h1>
  <p>Enter password to access the dashboard</p>
  <div class="error" id="err"></div>
  <form id="form">
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password" />
    <button type="submit">Log In</button>
  </form>
</div>
<script>
document.getElementById("form").onsubmit = async (e) => {
  e.preventDefault();
  const pw = document.getElementById("pw").value;
  const err = document.getElementById("err");
  err.style.display = "none";
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (res.ok) { window.location.reload(); }
    else { err.textContent = "Wrong password"; err.style.display = "block"; }
  } catch { err.textContent = "Connection error"; err.style.display = "block"; }
};
</script>
</body></html>`;
  }

  if (password) {
    console.log(`  Auth:     Password-protected`);
  }

  // ── REST API ─────────────────────────────────────────────
  const aggregator = new Aggregator();

  app.get("/api/state", (req, res) => {
    res.json(aggregator.getState());
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // ── Agent client tracking ─────────────────────────────────
  const clientTokens = config.server?.clientTokens || null; // null = no auth required
  const clientStaleMs = config.server?.clientStaleMs || 15_000;
  const agentClients = new Map(); // clientId → { lastSeen, online }

  // Per-client rate limiting: 30 req/min
  const clientRateLimits = new Map(); // clientId → { count, resetAt }

  app.use("/api/client-update", express.json({ limit: "1mb" }));
  app.post("/api/client-update", (req, res) => {
    const { clientId, token, hostData } = req.body || {};

    if (!clientId || !hostData) {
      return res.status(400).json({ error: "Missing clientId or hostData" });
    }

    // Token auth (if configured)
    if (clientTokens && clientTokens.length > 0) {
      if (!token || !clientTokens.includes(token)) {
        return res.status(401).json({ error: "Invalid token" });
      }
    }

    // Per-client rate limiting: 30 req/min
    const now = Date.now();
    let rl = clientRateLimits.get(clientId);
    if (!rl || now > rl.resetAt) {
      rl = { count: 0, resetAt: now + 60_000 };
      clientRateLimits.set(clientId, rl);
    }
    if (++rl.count > 30) {
      return res.status(429).json({ error: "Too many updates" });
    }

    // Feed into aggregator (same path as local watcher / SSH)
    aggregator.update(hostData);

    // Track heartbeat
    agentClients.set(clientId, { lastSeen: now, online: true });

    console.log(`[client] ${clientId}: ${hostData.sessions?.length || 0} session(s)`);
    res.json({ ok: true });
  });

  // Mark stale clients periodically
  setInterval(() => {
    const now = Date.now();
    for (const [id, info] of agentClients) {
      if (info.online && now - info.lastSeen > clientStaleMs) {
        info.online = false;
        console.log(`[client] ${id} went offline (no heartbeat for ${clientStaleMs}ms)`);
      }
    }
  }, 5_000);

  app.get("/api/clients", (req, res) => {
    const clients = [];
    for (const [id, info] of agentClients) {
      clients.push({
        clientId: id,
        online: info.online,
        lastSeen: info.lastSeen,
        staleSince: info.online ? null : info.lastSeen,
      });
    }
    res.json({ clients });
  });

  // ── Hook endpoint — Claude Code hooks POST here ────────
  const hookRateLimit = { count: 0, resetAt: 0 };
  app.use("/api/hook", express.json({ limit: "16kb" }));
  app.post("/api/hook", (req, res) => {
    // Basic rate limiting: max 60 requests per minute
    const now = Date.now();
    if (now > hookRateLimit.resetAt) {
      hookRateLimit.count = 0;
      hookRateLimit.resetAt = now + 60_000;
    }
    if (++hookRateLimit.count > 60) {
      return res.status(429).json({ error: "Too many hook events" });
    }

    const payload = req.body || {};
    const event = payload.hook_event_name || "unknown";
    const sessionId = payload.session_id || null;
    const cwd = payload.cwd || null;
    const project = cwd ? path.basename(cwd) : null;
    const toolName = payload.tool_name || null;
    const error = payload.tool_input?.error || payload.error || null;
    const stopReason = payload.stop_reason || null;

    const openClients = [...wss.clients].filter(c => c.readyState === 1).length;
    console.log(`[hook] ${event}${project ? ` (${project})` : ""}${toolName ? ` tool=${toolName}` : ""} → broadcasting to ${openClients} client(s)`);

    // Broadcast to all connected dashboard clients
    const notification = {
      type: "hook",
      data: { event, sessionId, project, cwd, toolName, error, stopReason, timestamp: Date.now(), raw: payload },
    };
    const msg = JSON.stringify(notification);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }

    res.json({ ok: true });
  });

  // ── SSH-capable hosts ────────────────────────────────────
  app.get("/api/ssh-hosts", (req, res) => {
    const sshHosts = config.hosts
      .filter((h) => h.ssh)
      .map((h) => ({ name: h.name, alias: h.ssh?.alias || h.name }));
    res.json({ hosts: sshHosts });
  });

  // ── SSH Connection Pool ──────────────────────────────────
  const sshPool = new SSHPool();

  app.get("/api/ssh-pool", (req, res) => {
    res.json({ pool: sshPool.getStatus() });
  });

  // ── Session actions (resume / fork / close) ───────────────
  const ACTION_MAP = { resume, fork, close };

  app.use("/api/actions", express.json());

  for (const [action, handler] of Object.entries(ACTION_MAP)) {
    app.post(`/api/actions/${action}`, async (req, res) => {
      const { sessionId, host } = req.body || {};
      if (!sessionId) {
        return res.status(400).json({ ok: false, error: "Missing sessionId" });
      }

      const hostConfig = host
        ? config.hosts.find((h) => h.name === host) || null
        : null;

      try {
        const result = await handler(sessionId, hostConfig);
        console.log(`[action] ${action} ${sessionId.slice(0, 8)} on ${host || "local"}: ${result.ok ? "ok" : result.error}`);
        res.json(result);
      } catch (err) {
        console.error(`[action] ${action} error:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  }

  // ── Short-lived WebSocket tokens (for ssh terminal auth) ─
  const wsTokens = new Map(); // token → expiresAt
  const WS_TOKEN_TTL_MS = 60_000; // 60s one-time use

  function createWsToken() {
    const token = crypto.randomBytes(16).toString("hex");
    wsTokens.set(token, Date.now() + WS_TOKEN_TTL_MS);
    return token;
  }

  function validateWsToken(token) {
    if (!token) return false;
    const expiresAt = wsTokens.get(token);
    if (!expiresAt) return false;
    wsTokens.delete(token); // one-time use
    if (expiresAt <= Date.now()) return false;
    return true;
  }

  // Prune expired ws tokens every minute
  setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of wsTokens) { if (exp <= now) wsTokens.delete(token); }
  }, 60_000);

  // Endpoint: get a short-lived token for WebSocket auth (requires session cookie)
  app.get("/api/ssh-token", (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: "Not authenticated" });
    res.json({ token: createWsToken() });
  });

  // ── TTS endpoint — Edge TTS via CLI ─────────────────────
  app.get("/api/tts", (req, res) => {
    const text = (req.query.text || "").slice(0, 200);
    if (!text) return res.status(400).json({ error: "text required" });
    const voice = req.query.voice || "zh-CN-XiaoxiaoNeural";
    const tmpFile = path.join(os.tmpdir(), `tts-${Date.now()}.mp3`);
    execFile("edge-tts", ["--text", text, "--voice", voice, "--write-media", tmpFile], { timeout: 10000 }, (err) => {
      if (err) {
        console.error("[tts] edge-tts error:", err.message);
        return res.status(500).json({ error: "TTS failed" });
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=60");
      const stream = fs.createReadStream(tmpFile);
      stream.pipe(res);
      stream.on("end", () => fs.unlink(tmpFile, () => {}));
      stream.on("error", () => { fs.unlink(tmpFile, () => {}); res.end(); });
    });
  });

  // ── Serve agent files (for install-agent.sh) ─────────────
  // Exposes agent/ and server/ source files so remote machines can self-install
  const AGENT_ALLOWED = new Set([
    "agent/index.js",
    "agent/package.json",
    "server/watcher.js",
    "server/parser.js",
    "server/codex-watcher.js",
    "server/codex-parser.js",
    "server/constants.js",
    "scripts/install-agent.sh",
  ]);

  app.get("/agent-files/:dir/:file", (req, res) => {
    const rel = `${req.params.dir}/${req.params.file}`;
    if (!AGENT_ALLOWED.has(rel)) return res.status(404).end();
    const filePath = path.join(ROOT, rel);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(filePath);
  });

  // Serve install-agent.sh directly at /install-agent.sh
  app.get("/install-agent.sh", (req, res) => {
    const filePath = path.join(ROOT, "scripts", "install-agent.sh");
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(filePath);
  });

  // ── Search endpoint — ripgrep across JSONL transcripts ────
  app.get("/api/search", async (req, res) => {
    const q = (req.query.q || "").trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    if (q.length < 2) {
      return res.status(400).json({ error: "Query must be at least 2 characters" });
    }
    if (q.length > 200) {
      return res.status(400).json({ error: "Query must be at most 200 characters" });
    }

    const startTime = Date.now();

    try {
      const localResults = [];
      const remoteResults = [];

      for (const hostConfig of config.hosts) {
        if (hostConfig.mode === "ssh") {
          remoteResults.push(
            searchTranscriptsSSH(q, hostConfig, { limit })
              .then((r) => ({ host: hostConfig.name, ...r }))
              .catch(() => ({ host: hostConfig.name, sessions: [], total: 0 }))
          );
        } else if (hostConfig.mode !== "agent" && hostConfig.tool !== "codex") {
          const claudeDir = expandHome(hostConfig.claudeDir || "~/.claude");
          localResults.push(
            searchTranscripts(q, { claudeDir, limit })
              .then((r) => ({ host: hostConfig.name, ...r }))
              .catch(() => ({ host: hostConfig.name, sessions: [], total: 0 }))
          );
        }
      }

      const allResults = await Promise.all([...localResults, ...remoteResults]);

      const merged = [];
      let total = 0;
      for (const result of allResults) {
        total += result.total;
        for (const session of result.sessions) {
          session.host = session.host || result.host;
          merged.push(session);
        }
      }

      merged.sort((a, b) => b.matchCount - a.matchCount);

      const took = Date.now() - startTime;
      res.json({ results: merged.slice(0, limit), total, took });
    } catch (err) {
      console.error("[search] Error:", err.message);
      res.status(500).json({ error: "Search failed" });
    }
  });

  // Serve the built client (production) or proxy to Vite (dev)
  const clientDist = path.join(ROOT, "client", "dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  } else {
    app.get("/", (req, res) => {
      res.send(`
        <html><body style="background:#0a0c10;color:#c8cdd8;font-family:monospace;padding:40px">
          <h2>⬡ Claude Code Monitor</h2>
          <p>Client not built yet. Run <code>npm run build</code> or use <code>npm run dev</code> for development.</p>
          <p>WebSocket endpoint available at <code>${wsProto}://localhost:${port}/ws</code></p>
          <p style="margin-top:20px;color:#6b7280">Or run <code>npm run dev</code> to start both server + Vite dev server.</p>
        </body></html>
      `);
    });
  }

  // ── Start SSH connection pool ─────────────────────────────
  // Explicit pool host list from config.server.sshPool.hosts, or fall back to all hosts with ssh config
  const poolConfig = config.server?.sshPool || {};
  const poolEnabled = poolConfig.enabled !== false;
  const allSshHosts = config.hosts.filter((h) => h.ssh);

  let poolHosts;
  if (poolConfig.hosts && Array.isArray(poolConfig.hosts)) {
    // Explicit list: only connect to named hosts
    const poolSet = new Set(poolConfig.hosts);
    poolHosts = allSshHosts.filter((h) => poolSet.has(h.name));
    const missing = poolConfig.hosts.filter((n) => !allSshHosts.find((h) => h.name === n));
    if (missing.length > 0) {
      console.warn(`[ssh-pool] Hosts not found in config: ${missing.join(", ")}`);
    }
  } else {
    poolHosts = allSshHosts;
  }

  if (poolEnabled && poolHosts.length > 0) {
    // Inject ControlPath into ALL ssh host configs (not just pool hosts)
    // so collectors and WebSSH can reuse any active master
    const controlPath = sshPool.getControlPath();
    for (const h of allSshHosts) {
      h._controlPath = controlPath;
    }
    // Subscribe pool status changes to aggregator
    sshPool.onStatusChange((status) => {
      aggregator.updateSSHPool(status);
    });
    // Start pool (non-blocking — connections establish in background)
    console.log(`[ssh-pool] Pool hosts: ${poolHosts.map((h) => h.name).join(", ")}`);
    sshPool.start(poolHosts).catch((err) => {
      console.error("[ssh-pool] Start error:", err.message);
    });
  } else if (!poolEnabled) {
    console.log("[ssh-pool] Disabled by config");
  }

  // ── Start watchers and collectors ────────────────────────
  const watchers = [];
  const sshHosts = [];

  for (const hostConfig of config.hosts) {
    if (hostConfig.mode === "ssh") {
      sshHosts.push(hostConfig);
      const target = hostConfig.sshAlias || `${hostConfig.user}@${hostConfig.host}`;
      console.log(`[ssh] Will poll ${hostConfig.name} (${target})`);
    } else if (hostConfig.mode === "agent") {
      // Agent mode: data arrives via /api/client-update push or SSH pool
      // No local watcher needed — just register host with empty state
      console.log(`[agent] ${hostConfig.name} (push mode, no local watcher)`);
      aggregator.update({
        host: hostConfig.name,
        status: "waiting",
        sessions: [],
        statsCache: null,
        collectedAt: Date.now(),
      });
    } else if (hostConfig.tool === "codex") {
      // Local Codex mode
      const codexDir = expandHome(hostConfig.codexDir || "~/.codex");
      if (fs.existsSync(codexDir)) {
        console.log(`[local] Watching Codex ${codexDir} as "${hostConfig.name}"`);
        const watcher = createCodexWatcher(codexDir, hostConfig.name, (data) => {
          aggregator.update(data);
        });
        watchers.push(watcher);
      } else {
        console.warn(`[local] ${codexDir} does not exist, skipping "${hostConfig.name}"`);
        aggregator.update({
          host: hostConfig.name,
          status: "error",
          error: `${codexDir} not found`,
          sessions: [],
          statsCache: null,
          collectedAt: Date.now(),
        });
      }
    } else {
      // Local Claude mode (default)
      const claudeDir = expandHome(hostConfig.claudeDir || "~/.claude");
      if (fs.existsSync(claudeDir)) {
        console.log(`[local] Watching ${claudeDir} as "${hostConfig.name}"`);
        const watcher = createWatcher(claudeDir, hostConfig.name, (data) => {
          aggregator.update(data);
        });
        watchers.push(watcher);
      } else {
        console.warn(`[local] ${claudeDir} does not exist, skipping "${hostConfig.name}"`);
        aggregator.update({
          host: hostConfig.name,
          status: "error",
          error: `${claudeDir} not found`,
          sessions: [],
          statsCache: null,
          collectedAt: Date.now(),
        });
      }
    }
  }

  // Poll SSH hosts on interval
  let pollSSH = null;
  if (sshHosts.length > 0) {
    pollSSH = async () => {
      const results = await Promise.allSettled(
        sshHosts.map(async (hostConfig) => {
          const raw = await collectFromSSH(hostConfig);
          console.log(`[ssh] ${hostConfig.name}: status=${raw.status}, sessions=${raw.sessions?.length || 0}${raw.error ? ', error=' + raw.error : ''}`);
          const sessions = parseRemoteSessions(raw);
          aggregator.update({
            ...raw,
            sessions,
          });
        })
      );

      for (const [i, result] of results.entries()) {
        if (result.status === "rejected") {
          console.error(`[ssh] Failed to poll ${sshHosts[i].name}:`, result.reason?.message);
        }
      }
    };

    // Initial poll
    pollSSH();
    // Recurring
    setInterval(pollSSH, pollInterval);
  }

  // ── Tmux status collection ─────────────────────────────
  const pollTmux = async () => {
    const tmuxJobs = config.hosts.map(async (hostConfig) => {
      try {
        const data = hostConfig.mode === "ssh"
          ? await collectTmuxSSH(hostConfig)
          : await collectTmuxLocal(hostConfig.name);
        aggregator.updateTmux(data);
      } catch (err) {
        console.error(`[tmux] Failed to collect from ${hostConfig.name}:`, err.message);
      }
    });
    await Promise.allSettled(tmuxJobs);
  };

  // Initial tmux poll + recurring
  pollTmux();
  setInterval(pollTmux, pollInterval);

  // ── WebSocket ────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    // Verify auth for WebSocket connections
    if (!isAuthenticatedWs(req)) {
      ws.close(4401, "Not authenticated");
      return;
    }
    console.log("[ws] Client connected");

    // Send current state immediately
    const withMeta = (s) => ({ ...s, pollIntervalMs: pollInterval });
    ws.send(JSON.stringify({ type: "state", data: withMeta(aggregator.getState()) }));

    // Subscribe to updates
    const unsub = aggregator.onUpdate((state) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "state", data: withMeta(state) }));
      }
    });

    // Handle client messages (e.g. manual refresh)
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "refresh") {
          console.log("[ws] Manual refresh requested");
          // Re-scan local watchers + re-poll SSH hosts + tmux, then send fresh state
          await Promise.allSettled([
            ...watchers.map((w) => w.rescan()),
            ...(pollSSH ? [pollSSH()] : []),
            pollTmux(),
          ]);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "state", data: withMeta(aggregator.getState()) }));
          }
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.on("close", () => {
      console.log("[ws] Client disconnected");
      unsub();
    });

    ws.on("error", (err) => {
      console.error("[ws] Error:", err.message);
      unsub();
    });
  });

  // ── WebSSH WebSocket handler (node-pty + ssh binary) ────
  // Uses ~/.ssh/config natively — supports ProxyJump, aliases, certs, etc.
  const wssSsh = new WebSocketServer({ noServer: true });

  wssSsh.on("connection", (ws, req, hostConfig) => {
    const sshAlias = hostConfig.ssh?.alias || hostConfig.name;
    const qs = new URL(req.url, "http://localhost").searchParams;
    const fixMode = qs.get("fix") === "1";
    const tmuxCmd = fixMode ? null : (qs.get("cmd") || hostConfig.ssh?.command || "tmux new-session -A -s main");
    console.log(`[ws-ssh] Spawning ssh ${sshAlias}${fixMode ? " (fix mode — no ControlMaster, interactive)" : ""}`);

    let cols = 220, rows = 50;
    const sshArgs = ["-tt"]; // force TTY allocation
    if (fixMode) {
      // Fix mode: no ControlMaster, longer timeout, allow interactive auth
      sshArgs.push("-o", "ConnectTimeout=60");
    } else if (hostConfig._controlPath) {
      // Reuse persistent ControlMaster connection if available
      sshArgs.push("-o", `ControlPath=${hostConfig._controlPath}`);
    }
    sshArgs.push(sshAlias);
    if (tmuxCmd) sshArgs.push(tmuxCmd);
    const proc = pty.spawn("ssh", sshArgs, {
      name: "xterm-256color",
      cols,
      rows,
      env: { ...process.env, TERM: "xterm-256color" },
    });

    // Track password prompt state
    let awaitingPassword = false;
    let outputBuf = "";
    const PASSWORD_RE = /[Pp]assword[^:]*:\s*$|[Pp]assphrase[^:]*:\s*$/;

    // PTY → WebSocket: send as binary so client can distinguish from JSON text control msgs
    proc.onData((data) => {
      if (ws.readyState !== ws.OPEN) return;

      // Accumulate recent output to detect password prompts
      outputBuf += data;
      if (outputBuf.length > 512) outputBuf = outputBuf.slice(-512);

      // Send terminal bytes as binary frame
      ws.send(Buffer.from(data));

      // Detect SSH password/passphrase prompt and signal the client
      if (!awaitingPassword && PASSWORD_RE.test(outputBuf.trimEnd())) {
        awaitingPassword = true;
        ws.send(JSON.stringify({ type: "password-prompt" }));
      }
    });

    proc.onExit(({ exitCode }) => {
      console.log(`[ws-ssh] ssh exited (${exitCode}) for ${sshAlias}`);
      if (ws.readyState === ws.OPEN) ws.close();
    });

    // WebSocket → PTY
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "resize") {
          cols = msg.cols; rows = msg.rows;
          proc.resize(cols, rows);
        } else if (msg.type === "password-input") {
          awaitingPassword = false;
          outputBuf = "";
          proc.write((msg.value || "") + "\r");
        }
      } catch {
        proc.write(typeof data === "string" ? data : data.toString());
      }
    });

    ws.on("close", () => {
      console.log(`[ws-ssh] WebSocket closed for ${sshAlias}`);
      try { proc.kill(); } catch {}
    });

    ws.on("error", (err) => {
      console.error(`[ws-ssh] WebSocket error for ${sshAlias}:`, err.message);
      try { proc.kill(); } catch {}
    });
  });

  // ── Handle HTTP upgrade for both /ws and /ws/ssh/:hostId ─
  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";

    // Check for /ws/ssh/:hostId first (more specific)
    const sshMatch = url.match(/^\/ws\/ssh\/([^/?]+)/);
    if (sshMatch) {
      const hostId = decodeURIComponent(sshMatch[1]);

      // Auth check: accept cookie OR short-lived ?token= query param
      const qs = new URL(url, "http://localhost").searchParams;
      const wsToken = qs.get("token");
      const authed = isAuthenticatedWs(req) || validateWsToken(wsToken);
      if (!authed) {
        console.log(`[ws-ssh] Auth failed for ${hostId} (no valid cookie or token)`);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // Find host config
      const hostConfig = config.hosts.find(
        (h) => h.name === hostId && h.ssh
      );
      if (!hostConfig) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      wssSsh.handleUpgrade(req, socket, head, (ws) => {
        wssSsh.emit("connection", ws, req, hostConfig);
      });
      return;
    }

    // Default /ws handler is handled by wss (path: "/ws" matches automatically)
    // but since we're taking over the upgrade event, we need to forward it
    if (url === "/ws" || url.startsWith("/ws?")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  // ── Start server ─────────────────────────────────────────
  server.listen(port, () => {
    console.log(`[server] Listening on ${proto}://localhost:${port}`);
    console.log(`[server] WebSocket at ${wsProto}://localhost:${port}/ws`);
    console.log("");
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[server] Shutting down...");
    for (const w of watchers) w.close();
    await sshPool.stop();
    wss.close();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
