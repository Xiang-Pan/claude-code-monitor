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

import { Aggregator } from "./aggregator.js";
import { createWatcher } from "./watcher.js";
import { createCodexWatcher } from "./codex-watcher.js";
import { collectFromSSH, parseRemoteSessions } from "./ssh-collector.js";
import { collectTmuxLocal, collectTmuxSSH } from "./tmux-collector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readAppVersion() {
  try {
    const packagePath = path.join(ROOT, "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return parsed.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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
  const serverVersion = readAppVersion();
  const clientVersionCounts = new Map();

  const listConnectedClientVersions = () => [...clientVersionCounts.keys()];
  const addClientVersion = (version) => {
    clientVersionCounts.set(version, (clientVersionCounts.get(version) || 0) + 1);
  };
  const removeClientVersion = (version) => {
    const count = clientVersionCounts.get(version) || 0;
    if (count <= 1) clientVersionCounts.delete(version);
    else clientVersionCounts.set(version, count - 1);
  };

  console.log(`
  ⬡  Claude Code Monitor
  ─────────────────────────
  Hosts:    ${config.hosts.map((h) => h.name).join(", ")}
  Port:     ${port}
  Poll:     ${pollInterval}ms
  `);

  // ── Express app ──────────────────────────────────────────
  const app = express();
  const server = http.createServer(app);

  // ── Password auth ──────────────────────────────────────────
  const password = process.env.CCM_PASSWORD || config.server?.password || null;
  const hookToken = process.env.CCM_HOOK_TOKEN || config.server?.hookToken || null;
  const allowInsecureClientUpdates = process.env.CCM_ALLOW_INSECURE_CLIENT_UPDATES === "1" || config.server?.allowInsecureClientUpdates === true;
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
  if (!password) {
    console.warn("[security] No dashboard password set. Set CCM_PASSWORD.");
  }
  if (!allowInsecureClientUpdates && (!clientTokens || clientTokens.length === 0)) {
    console.warn("[security] clientTokens is empty while secure mode is enabled; /api/client-update will reject agents.");
  }
  if (!hookToken) {
    console.warn("[security] No hook token set. /api/hook is unauthenticated (set CCM_HOOK_TOKEN).");
  }

  // ── REST API ─────────────────────────────────────────────
  const aggregator = new Aggregator();

  app.get("/api/state", (req, res) => {
    res.json({
      ...aggregator.getState(),
      meta: {
        serverVersion,
        connectedClientVersions: listConnectedClientVersions(),
      },
    });
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), serverVersion });
  });

  app.get("/api/version", (req, res) => {
    res.json({
      serverVersion,
      connectedClientVersions: listConnectedClientVersions(),
      connectedClients: [...clientVersionCounts.values()].reduce((a, b) => a + b, 0),
    });
  });

  app.get("/api/metrics", (req, res) => {
    const st = aggregator.getState();
    const a = st.aggregate || {};
    const lines = [
      `ccm_sessions_total ${a.totalSessions || 0}`,
      `ccm_sessions_active ${a.active || 0}`,
      `ccm_sessions_idle ${a.idle || 0}`,
      `ccm_sessions_completed ${a.completed || 0}`,
      `ccm_sessions_errors ${a.errors || 0}`,
      `ccm_tool_calls_total ${a.totalToolCalls || 0}`,
      `ccm_tokens_input_total ${(a.totalTokens && a.totalTokens.input) || 0}`,
      `ccm_tokens_output_total ${(a.totalTokens && a.totalTokens.output) || 0}`,
      `ccm_tokens_cache_read_total ${(a.totalTokens && a.totalTokens.cacheRead) || 0}`,
      `ccm_connected_clients ${[...clientVersionCounts.values()].reduce((x, y) => x + y, 0)}`,
    ];
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.send(lines.join("\n") + "\n");
  });

  // ── Agent client tracking ─────────────────────────────────
  const clientTokens = config.server?.clientTokens || []; // empty means disabled unless explicitly allowed
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

    // Token auth (required by default)
    if (!allowInsecureClientUpdates) {
      if (!token || !clientTokens.includes(token)) {
        return res.status(401).json({ error: "Invalid or missing client token" });
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

    if (hookToken) {
      const supplied = req.headers["x-hook-token"] || req.headers["x-webhook-token"];
      if (supplied !== hookToken) {
        return res.status(401).json({ error: "Invalid hook token" });
      }
    }
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
          <p>WebSocket endpoint available at <code>ws://localhost:${port}/ws</code></p>
          <p style="margin-top:20px;color:#6b7280">Or run <code>npm run dev</code> to start both server + Vite dev server.</p>
        </body></html>
      `);
    });
  }

  // ── Start watchers and collectors ────────────────────────
  const watchers = [];
  const sshHosts = [];

  for (const hostConfig of config.hosts) {
    if (hostConfig.mode === "ssh") {
      sshHosts.push(hostConfig);
      const target = hostConfig.sshAlias || `${hostConfig.user}@${hostConfig.host}`;
      console.log(`[ssh] Will poll ${hostConfig.name} (${target})`);
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
  let sshPollInFlight = false;
  let tmuxPollInFlight = false;
  if (sshHosts.length > 0) {
    pollSSH = async () => {
      if (sshPollInFlight) return;
      sshPollInFlight = true;
      try {
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
      } finally {
        sshPollInFlight = false;
      }
    };

    // Initial poll
    pollSSH();
    // Recurring
    setInterval(pollSSH, pollInterval);
  }

  // ── Tmux status collection ─────────────────────────────
  const pollTmux = async () => {
    if (tmuxPollInFlight) return;
    tmuxPollInFlight = true;
    try {
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
    } finally {
      tmuxPollInFlight = false;
    }
  };

  // Initial tmux poll + recurring
  pollTmux();
  setInterval(pollTmux, pollInterval);

  // ── WebSocket ────────────────────────────────────────────
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    // Verify auth for WebSocket connections
    if (!isAuthenticatedWs(req)) {
      ws.close(4401, "Not authenticated");
      return;
    }
    const wsUrl = new URL(req.url || "/ws", `http://${req.headers.host || "localhost"}`);
    const clientVersion = (wsUrl.searchParams.get("clientVersion") || "").trim() || "unknown";
    ws.clientVersion = clientVersion;
    addClientVersion(clientVersion);
    console.log("[ws] Client connected");

    // Send current state immediately
    const withMeta = (s) => ({
      ...s,
      pollIntervalMs: pollInterval,
      meta: {
        serverVersion,
        connectedClientVersions: listConnectedClientVersions(),
      },
    });
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
      if (ws.clientVersion) {
        removeClientVersion(ws.clientVersion);
      }
      unsub();
    });

    ws.on("error", (err) => {
      console.error("[ws] Error:", err.message);
      unsub();
    });
  });

  // ── Start server ─────────────────────────────────────────
  server.listen(port, () => {
    console.log(`[server] Listening on http://localhost:${port}`);
    console.log(`[server] WebSocket at ws://localhost:${port}/ws`);
    console.log("");
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[server] Shutting down...");
    for (const w of watchers) w.close();
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
