#!/usr/bin/env node

import fs from "fs";
import path from "path";
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
  const server = http.createServer(app);

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

    console.log(`[hook] ${event}${project ? ` (${project})` : ""}${toolName ? ` tool=${toolName}` : ""}`);

    // Broadcast to all connected dashboard clients
    const notification = {
      type: "hook",
      data: { event, sessionId, project, cwd, toolName, error, stopReason, timestamp: Date.now(), raw: payload },
    };
    const msg = JSON.stringify(notification);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    }

    res.json({ ok: true });
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
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
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
