#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";

const CCM_URL = process.env.CCM_URL || "ws://localhost:3456/ws";
const RECONNECT_MS = 5000;

// ── State ───────────────────────────────────────────────────
let state = { sessions: [], aggregate: {}, tmux: [], updatedAt: null };
let prevStatuses = new Map(); // sessionId → status

// ── Diff helper (exported for testing) ──────────────────────
export function diffStatuses(prev, current) {
  const events = [];
  const currentMap = new Map();

  for (const s of current) {
    currentMap.set(s.sessionId, s.status);
    const old = prev.get(s.sessionId);
    // Only emit when a *known* session changes status
    if (old && old !== s.status) {
      events.push({
        sessionId: s.sessionId,
        project: s.project?.name || null,
        host: s.host,
        from: old,
        to: s.status,
      });
    }
  }

  return events;
}

// ── WebSocket connection to monitor ─────────────────────────
let ws = null;
let mcpServer = null;

function log(...args) {
  console.error("[mcp]", ...args);
}

function connectWs() {
  log(`Connecting to ${CCM_URL}`);
  ws = new WebSocket(CCM_URL);

  ws.on("open", () => log("Connected to monitor"));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "state" && msg.data) {
        const newSessions = msg.data.sessions || [];

        // Diff before updating
        const events = diffStatuses(prevStatuses, newSessions);

        // Update cached state
        state = msg.data;

        // Update previous statuses map
        prevStatuses = new Map();
        for (const s of newSessions) {
          prevStatuses.set(s.sessionId, s.status);
        }

        // Notify MCP client if any transitions occurred
        if (events.length > 0 && mcpServer) {
          log(`Status changes: ${events.map((e) => `${e.project || e.sessionId} ${e.from}→${e.to}`).join(", ")}`);
          mcpServer.server.sendResourceListChanged();
        }
      }
    } catch (err) {
      log("Parse error:", err.message);
    }
  });

  ws.on("close", () => {
    log(`Disconnected, reconnecting in ${RECONNECT_MS}ms`);
    setTimeout(connectWs, RECONNECT_MS);
  });

  ws.on("error", (err) => {
    log("WS error:", err.message);
    ws.close();
  });
}

// ── Formatting helpers ──────────────────────────────────────
function formatSummary() {
  const agg = state.aggregate || {};
  const lines = [];
  lines.push(`Sessions: ${agg.totalSessions || 0} total — ${agg.active || 0} active, ${agg.idle || 0} idle, ${agg.errors || 0} errors`);

  for (const s of state.sessions || []) {
    const proj = s.project?.name || "unknown";
    const host = s.host || "local";
    const age = s.lastTimestamp ? timeSince(s.lastTimestamp) : "n/a";
    lines.push(`  [${s.status}] ${proj} on ${host} (${age} ago, ${s.messages || 0} msgs)`);
  }

  if ((state.sessions || []).length === 0) {
    lines.push("  No sessions found.");
  }

  return lines.join("\n");
}

function timeSince(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function activeSessions() {
  return (state.sessions || []).filter((s) => s.status === "active" || s.status === "idle");
}

function sessionsByHost(hostName) {
  return (state.sessions || []).filter((s) => s.host === hostName);
}

// ── Relative time parser (exported for testing) ─────────────
export function resolveRelativeTime(input) {
  if (input === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const match = input.match(/^(\d+)\s*(m|min|h|hr|d|day)s?$/i);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2][0].toLowerCase();
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  return input; // assume ISO string
}

// ── Time filter helper (exported for testing) ───────────────
export function filterByTime(sessions, since) {
  const cutoff = new Date(since).getTime();
  if (isNaN(cutoff)) return sessions;
  return sessions.filter((s) => {
    const created = s.firstTimestamp ? new Date(s.firstTimestamp).getTime() : 0;
    return created >= cutoff;
  });
}

// ── Context window formatting ───────────────────────────────
function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatContextSummary() {
  const sessions = state.sessions || [];
  if (sessions.length === 0) return "No sessions found.";

  const lines = [];
  for (const s of sessions) {
    const t = s.tokens || {};
    const proj = s.project?.name || "unknown";
    const host = s.host || "local";
    const lastInput = t.lastInput || 0;
    const totalIn = t.input || 0;
    const totalOut = t.output || 0;
    const cacheRead = t.cacheRead || 0;
    const total = totalIn + totalOut;

    lines.push(`[${s.status}] ${proj} on ${host}`);
    lines.push(`  Context (last request): ${formatTokens(lastInput)} input tokens`);
    lines.push(`  Total: ${formatTokens(totalIn)} in + ${formatTokens(totalOut)} out = ${formatTokens(total)} | Cache: ${formatTokens(cacheRead)} read`);
  }

  return lines.join("\n");
}

// ── MCP Server ──────────────────────────────────────────────
async function main() {
  mcpServer = new McpServer({
    name: "claude-code-monitor",
    version: "0.1.0",
  });

  // — Resources —

  mcpServer.resource("all-sessions", "sessions://all", {
    description: "All monitored sessions with aggregate stats",
  }, () => ({
    contents: [{
      uri: "sessions://all",
      mimeType: "application/json",
      text: JSON.stringify({ sessions: state.sessions, aggregate: state.aggregate, updatedAt: state.updatedAt }, null, 2),
    }],
  }));

  mcpServer.resource("active-sessions", "sessions://active", {
    description: "Currently active and idle sessions only",
  }, () => ({
    contents: [{
      uri: "sessions://active",
      mimeType: "application/json",
      text: JSON.stringify({ sessions: activeSessions(), updatedAt: state.updatedAt }, null, 2),
    }],
  }));

  mcpServer.resource("host-sessions", "sessions://host/{name}", {
    description: "Sessions for a specific host",
    list: () => {
      const hosts = (state.aggregate?.hosts || []).map((h) => ({
        uri: `sessions://host/${h.name}`,
        name: `Sessions on ${h.name}`,
      }));
      return { resources: hosts };
    },
  }, ({ name }) => ({
    contents: [{
      uri: `sessions://host/${name}`,
      mimeType: "application/json",
      text: JSON.stringify({ host: name, sessions: sessionsByHost(name), updatedAt: state.updatedAt }, null, 2),
    }],
  }));

  // — Tools —

  mcpServer.tool("get_session_status", "Get a concise text summary of all monitored Claude Code sessions", {}, () => ({
    content: [{ type: "text", text: formatSummary() }],
  }));

  mcpServer.tool(
    "get_session_details",
    "Get full JSON details for a specific session by ID",
    { sessionId: z.string().describe("The session ID to look up") },
    ({ sessionId }) => {
      const session = (state.sessions || []).find((s) => s.sessionId === sessionId);
      if (!session) {
        return { content: [{ type: "text", text: `Session ${sessionId} not found.` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(session, null, 2) }] };
    },
  );

  mcpServer.tool(
    "get_sessions_since",
    "Get sessions created since a given time (ISO string or relative like 'today', '1h', '30m')",
    { since: z.string().describe("ISO datetime, or relative: 'today', '1h', '30m', '7d'") },
    ({ since }) => {
      const resolved = resolveRelativeTime(since);
      const filtered = filterByTime(state.sessions || [], resolved);
      const lines = [`Sessions since ${since} (${filtered.length} found):`];
      for (const s of filtered) {
        const proj = s.project?.name || "unknown";
        const host = s.host || "local";
        const created = s.firstTimestamp || "n/a";
        lines.push(`  [${s.status}] ${proj} on ${host} — created ${created}, ${s.messages || 0} msgs`);
      }
      if (filtered.length === 0) lines.push("  None.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  mcpServer.tool(
    "get_context_window",
    "Get token usage and context window info for all sessions (or one specific session)",
    { sessionId: z.string().optional().describe("Optional session ID — omit for all sessions") },
    ({ sessionId }) => {
      if (sessionId) {
        const s = (state.sessions || []).find((x) => x.sessionId === sessionId);
        if (!s) return { content: [{ type: "text", text: `Session ${sessionId} not found.` }], isError: true };
        const t = s.tokens || {};
        const text = [
          `${s.project?.name || "unknown"} on ${s.host || "local"} [${s.status}]`,
          `Context (last request): ${formatTokens(t.lastInput || 0)} input tokens`,
          `Total: ${formatTokens(t.input || 0)} in + ${formatTokens(t.output || 0)} out = ${formatTokens((t.input || 0) + (t.output || 0))}`,
          `Cache read: ${formatTokens(t.cacheRead || 0)}`,
          `Messages: ${s.messages || 0} | Tool calls: ${s.toolCalls || 0}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }
      return { content: [{ type: "text", text: formatContextSummary() }] };
    },
  );

  // — Start —

  connectWs();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
