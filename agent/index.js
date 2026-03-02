#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";
import { createWatcher } from "../server/watcher.js";
import { createCodexWatcher } from "../server/codex-watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI argument parsing ────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    server: null,
    name: null,
    token: null,
    tool: "claude",
    claudeDir: path.join(process.env.HOME || "/root", ".claude"),
    codexDir: path.join(process.env.HOME || "/root", ".codex"),
    interval: 5000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
      case "-s":
        opts.server = args[++i];
        break;
      case "--name":
      case "-n":
        opts.name = args[++i];
        break;
      case "--token":
      case "-t":
        opts.token = args[++i];
        break;
      case "--tool":
        opts.tool = args[++i];
        break;
      case "--claude-dir":
        opts.claudeDir = args[++i];
        break;
      case "--codex-dir":
        opts.codexDir = args[++i];
        break;
      case "--interval":
        opts.interval = parseInt(args[++i], 10);
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }

  // Expand ~ in paths
  if (opts.claudeDir.startsWith("~/")) {
    opts.claudeDir = path.join(
      process.env.HOME || "/root",
      opts.claudeDir.slice(2)
    );
  }
  if (opts.codexDir.startsWith("~/")) {
    opts.codexDir = path.join(
      process.env.HOME || "/root",
      opts.codexDir.slice(2)
    );
  }

  return opts;
}

function printUsage() {
  console.log(`
  Usage: claude-code-monitor-agent [options]

  Options:
    --server, -s <url>     Server URL (required), e.g. http://server:3456
    --name, -n <name>      Client name / host identifier (required)
    --token, -t <token>    Authentication token (optional)
    --tool <name>          Tool to monitor: "claude" or "codex" (default: claude)
    --claude-dir <path>    Path to ~/.claude directory (default: ~/.claude)
    --codex-dir <path>     Path to ~/.codex directory (default: ~/.codex)
    --interval <ms>        Minimum push interval in ms (default: 5000)
    --help, -h             Show this help message

  Examples:
    node agent/index.js --server http://localhost:3456 --name my-machine
    node agent/index.js -s http://10.0.0.5:3456 -n gpu-box -t mysecret
    node agent/index.js -s http://localhost:3456 -n my-box --tool codex
  `);
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.server) {
    console.error("Error: --server is required");
    printUsage();
    process.exit(1);
  }
  if (!opts.name) {
    console.error("Error: --name is required");
    printUsage();
    process.exit(1);
  }

  // Normalize server URL (strip trailing slash)
  const serverUrl = opts.server.replace(/\/+$/, "");
  const endpoint = `${serverUrl}/api/client-update`;

  const watchDir = opts.tool === "codex" ? opts.codexDir : opts.claudeDir;

  console.log(`
  Claude Code Monitor Agent
  ─────────────────────────
  Name:       ${opts.name}
  Tool:       ${opts.tool}
  Server:     ${serverUrl}
  Watch dir:  ${watchDir}
  Interval:   ${opts.interval}ms
  Auth:       ${opts.token ? "yes" : "no"}
  `);

  // Throttle: don't push more often than --interval
  let lastPushTime = 0;
  let pendingData = null;
  let pushTimer = null;
  let pushing = false;

  async function pushToServer(hostData) {
    const body = JSON.stringify({
      clientId: opts.name,
      token: opts.token || undefined,
      hostData,
    });

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[agent] Push failed: ${res.status} ${text}`);
      }
    } catch (err) {
      console.error(`[agent] Push error: ${err.message}`);
    }
  }

  function schedulePush(hostData) {
    pendingData = hostData;
    if (pushing || pushTimer) return;

    const elapsed = Date.now() - lastPushTime;
    const delay = Math.max(0, opts.interval - elapsed);

    pushTimer = setTimeout(async () => {
      pushTimer = null;
      if (!pendingData) return;

      const data = pendingData;
      pendingData = null;
      pushing = true;
      lastPushTime = Date.now();

      await pushToServer(data);
      pushing = false;

      // If new data arrived while pushing, schedule again
      if (pendingData) schedulePush(pendingData);
    }, delay);
  }

  // Track last known state for heartbeat
  let lastHostData = null;

  // Start the file watcher
  const createWatcherFn = opts.tool === "codex" ? createCodexWatcher : createWatcher;
  const watcher = createWatcherFn(watchDir, opts.name, (hostData) => {
    lastHostData = hostData;
    const sessionCount = hostData.sessions?.length || 0;
    console.log(
      `[agent] Update: ${sessionCount} session(s), status=${hostData.status}`
    );
    schedulePush(hostData);
  });

  console.log(`[agent] Watching ${watchDir}, pushing to ${endpoint}`);

  // Periodic heartbeat: re-push last known data to keep "online" status.
  // Fires every interval; only actually pushes if no recent push occurred.
  const heartbeatTimer = setInterval(() => {
    if (lastHostData && Date.now() - lastPushTime >= opts.interval) {
      lastHostData.collectedAt = Date.now();
      pushToServer(lastHostData);
      lastPushTime = Date.now();
    }
  }, opts.interval);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[agent] Shutting down...");
    if (pushTimer) clearTimeout(pushTimer);
    clearInterval(heartbeatTimer);
    watcher.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
