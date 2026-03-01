import { useState, useEffect, useRef, useCallback } from "react";
import { useMonitorSocket } from "./hooks/useMonitorSocket.js";

// ─── Color Tokens ───────────────────────────────────────────
const C = {
  bg: "#0a0c10",
  surface: "#12151c",
  surfaceHover: "#181c26",
  border: "#1e2330",
  borderAccent: "#2a3040",
  text: "#c8cdd8",
  textMuted: "#6b7280",
  textDim: "#3d4452",
  accent: "#22d3ee",
  accentDim: "rgba(34,211,238,0.08)",
  green: "#34d399",
  greenDim: "rgba(52,211,153,0.10)",
  amber: "#fbbf24",
  amberDim: "rgba(251,191,36,0.10)",
  red: "#f87171",
  redDim: "rgba(248,113,113,0.10)",
  purple: "#a78bfa",
  purpleDim: "rgba(167,139,250,0.10)",
};

const STATUS_MAP = {
  active: { label: "Active", color: C.green, bg: C.greenDim, pulse: true },
  idle: { label: "Idle", color: C.amber, bg: C.amberDim, pulse: false },
  completed: { label: "Done", color: C.textMuted, bg: "rgba(107,114,128,0.08)", pulse: false },
  error: { label: "Error", color: C.red, bg: C.redDim, pulse: false },
};

// ─── Demo data for when server isn't connected ──────────────
function generateDemoSessions() {
  const items = [
    { name: "api-gateway", path: "/home/dev/projects/api-gateway", branch: "feat/auth-v2", host: "dev-server-1", status: "active", model: "claude-sonnet-4-6", msg: "Implementing JWT refresh token rotation" },
    { name: "web-frontend", path: "/home/dev/projects/web-frontend", branch: "main", host: "dev-server-2", status: "active", model: "claude-opus-4-6", msg: "Refactoring component tree" },
    { name: "ml-pipeline", path: "/home/dev/projects/ml-pipeline", branch: "fix/tokenizer", host: "gpu-box", status: "active", model: "claude-sonnet-4-6", msg: "Fixing tokenizer edge case" },
    { name: "infra-config", path: "/home/dev/projects/infra-config", branch: "chore/k8s", host: "dev-server-1", status: "idle", model: "claude-opus-4-5", msg: "Waiting for user input on node pool sizing" },
    { name: "mobile-app", path: "/home/dev/projects/mobile-app", branch: "feat/push", host: "dev-server-2", status: "completed", model: "claude-sonnet-4-6", msg: "All 47 tests passing, PR ready" },
    { name: "data-service", path: "/home/dev/projects/data-service", branch: "refactor/db", host: "dev-server-1", status: "error", model: "claude-sonnet-4-6", msg: "ECONNREFUSED connecting to PostgreSQL" },
    { name: "api-gateway", path: "/home/dev/projects/api-gateway", branch: "feat/auth-v2", host: "dev-server-1", status: "active", model: "claude-sonnet-4-6", msg: "Running auth middleware tests", isAgent: true, parentSessionId: "demo-0" },
  ];

  return items.map((item, i) => ({
    sessionId: `demo-${i}`,
    isAgent: item.isAgent || false,
    parentSessionId: item.parentSessionId || null,
    status: item.status,
    project: { name: item.name, path: item.path, encoded: item.path.replace(/\//g, "-") },
    branch: item.branch,
    host: item.host,
    model: item.model,
    messages: Math.floor(Math.random() * 180) + 20,
    userMessages: Math.floor(Math.random() * 60) + 10,
    assistantMessages: Math.floor(Math.random() * 100) + 10,
    toolCalls: Math.floor(Math.random() * 80) + 5,
    tokens: {
      input: Math.floor(Math.random() * 600000) + 50000,
      output: Math.floor(Math.random() * 150000) + 10000,
      cacheRead: Math.floor(Math.random() * 2000000) + 100000,
    },
    firstTimestamp: new Date(Date.now() - Math.floor(Math.random() * 7200000) - 600000).toISOString(),
    lastTimestamp: item.status === "active"
      ? new Date(Date.now() - Math.floor(Math.random() * 20000)).toISOString()
      : new Date(Date.now() - Math.floor(Math.random() * 3600000) - 60000).toISOString(),
    lastAssistantMessage: item.msg,
    summary: null,
  }));
}

// ─── Helpers ────────────────────────────────────────────────
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 5000) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

// ─── Cost Estimation (Part 2A) ──────────────────────────────
// Pricing per million tokens (USD) — input / output / cacheRead
const MODEL_PRICING = {
  "opus":   { input: 15, output: 75, cacheRead: 1.5 },
  "sonnet": { input: 3, output: 15, cacheRead: 0.3 },
  "haiku":  { input: 0.8, output: 4, cacheRead: 0.08 },
};

function getModelTier(model) {
  if (!model) return "sonnet";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

function estimateCost(model, tokens) {
  if (!tokens) return 0;
  const tier = getModelTier(model);
  const pricing = MODEL_PRICING[tier];
  const inputCost = ((tokens.input || 0) / 1_000_000) * pricing.input;
  const outputCost = ((tokens.output || 0) / 1_000_000) * pricing.output;
  const cacheCost = ((tokens.cacheRead || 0) / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheCost;
}

function formatCost(cost) {
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

// ─── Copy-to-clipboard command box ──────────────────────────
function CopyCommand({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <div
      onClick={handleCopy}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 10px", borderRadius: 4,
        backgroundColor: C.accentDim, border: `1px solid ${C.accent}20`,
        fontSize: 11, color: C.accent, fontFamily: "monospace",
        cursor: "pointer", userSelect: "all",
      }}
      title="Click to copy"
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
      <span style={{
        flexShrink: 0, marginLeft: 8, fontSize: 10, padding: "2px 6px",
        borderRadius: 3, backgroundColor: copied ? C.greenDim : `${C.accent}15`,
        color: copied ? C.green : C.accent, transition: "all 0.2s",
      }}>
        {copied ? "Copied!" : "Copy"}
      </span>
    </div>
  );
}

// ─── Persistent localStorage hook (Part 2F) ─────────────────
function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(`ccm:${key}`);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(`ccm:${key}`, JSON.stringify(value));
    } catch { /* ignore quota errors */ }
  }, [key, value]);

  return [value, setValue];
}

// ─── Sub-Agent Grouping (Part 2B) ───────────────────────────
function groupSessions(sessions) {
  const mainSessions = [];
  const agentMap = new Map(); // parentKey -> agent sessions

  // First pass: separate agents from main sessions
  for (const s of sessions) {
    if (s.isAgent && s.parentSessionId) {
      const key = s.parentSessionId;
      if (!agentMap.has(key)) agentMap.set(key, []);
      agentMap.get(key).push(s);
    } else {
      mainSessions.push(s);
    }
  }

  // Second pass: attach agents to their parent, or promote orphan agents
  const grouped = [];
  for (const main of mainSessions) {
    const agents = agentMap.get(main.sessionId) || [];
    agentMap.delete(main.sessionId);
    grouped.push({ ...main, _agents: agents });
  }

  // Orphan agents (no parent found) become standalone
  for (const [, agents] of agentMap) {
    for (const a of agents) {
      grouped.push({ ...a, _agents: [] });
    }
  }

  return grouped;
}

// ─── Small Components ───────────────────────────────────────

function StatusDot({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.completed;
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 10, height: 10 }}>
      {s.pulse && <span style={{ position: "absolute", width: 10, height: 10, borderRadius: "50%", backgroundColor: s.color, opacity: 0.4, animation: "pulse 2s ease-in-out infinite" }} />}
      <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: s.color, position: "relative", zIndex: 1 }} />
    </span>
  );
}

function Badge({ children, color, bg }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 500, letterSpacing: "0.02em", color, backgroundColor: bg, fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      {children}
    </span>
  );
}

function TokenBar({ input, output, cacheRead }) {
  const total = (input || 0) + (output || 0) + (cacheRead || 0);
  if (total === 0) return null;
  const pI = ((input || 0) / total) * 100;
  const pO = ((output || 0) / total) * 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: C.border }}>
        <div style={{ width: `${pI}%`, backgroundColor: C.accent, transition: "width 0.5s" }} />
        <div style={{ width: `${pO}%`, backgroundColor: C.purple, transition: "width 0.5s" }} />
        <div style={{ flex: 1, backgroundColor: "rgba(107,114,128,0.2)" }} />
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 10, color: C.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
        <span><span style={{ color: C.accent }}>●</span> In: {formatTokens(input)}</span>
        <span><span style={{ color: C.purple }}>●</span> Out: {formatTokens(output)}</span>
        <span><span style={{ color: C.textDim }}>●</span> Cache: {formatTokens(cacheRead)}</span>
      </div>
    </div>
  );
}

function DetailCell({ label, value, full }) {
  return (
    <div style={full ? { gridColumn: "1 / -1" } : {}}>
      <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, color: C.text, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
}

function StatItem({ label, value, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
      <span style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
    </div>
  );
}

// ─── Countdown Timer (Part 2C) ──────────────────────────────

function CountdownTimer({ pollIntervalMs, lastUpdated, onRefresh }) {
  const [remaining, setRemaining] = useState(pollIntervalMs || 3000);

  useEffect(() => {
    if (!pollIntervalMs || !lastUpdated) return;
    const tick = () => {
      const elapsed = Date.now() - lastUpdated;
      const r = Math.max(0, pollIntervalMs - elapsed);
      setRemaining(r);
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [pollIntervalMs, lastUpdated]);

  if (!pollIntervalMs) return null;

  const secs = Math.ceil(remaining / 1000);
  const fraction = remaining / pollIntervalMs;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  return (
    <button
      onClick={onRefresh}
      title={`Next poll in ${secs}s — click to refresh now`}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        background: "none", border: `1px solid ${C.border}`, borderRadius: 6,
        padding: "4px 8px", cursor: "pointer", transition: "all 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent + "60"; e.currentTarget.style.backgroundColor = C.accentDim; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="10" cy="10" r={radius} fill="none" stroke={C.border} strokeWidth="2" />
        <circle cx="10" cy="10" r={radius} fill="none" stroke={C.accent} strokeWidth="2"
          strokeDasharray={circumference} strokeDashoffset={dashOffset}
          strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.2s" }} />
      </svg>
      <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>{secs}s</span>
    </button>
  );
}

// ─── Session Card ───────────────────────────────────────────

function SessionCard({ session, expanded, onToggle, isAgent }) {
  const s = STATUS_MAP[session.status] || STATUS_MAP.completed;
  const elapsed = session.firstTimestamp ? Date.now() - new Date(session.firstTimestamp).getTime() : 0;
  const cost = estimateCost(session.model, session.tokens);
  const agentCount = session._agents?.length || 0;

  return (
    <div
      onClick={onToggle}
      style={{
        backgroundColor: C.surface, border: `1px solid ${expanded ? s.color + "40" : C.border}`,
        borderRadius: 8, padding: isAgent ? "12px 16px" : 16, cursor: "pointer", transition: "all 0.2s ease",
        position: "relative", overflow: "hidden",
        marginLeft: isAgent ? 28 : 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = s.color + "60"; e.currentTarget.style.backgroundColor = C.surfaceHover; }}
      onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.borderColor = C.border; e.currentTarget.style.backgroundColor = C.surface; }}
    >
      {/* Visual connector for agents */}
      {isAgent && (
        <div style={{ position: "absolute", left: -14, top: 0, bottom: 0, width: 2, backgroundColor: C.border }} />
      )}
      {isAgent && (
        <div style={{ position: "absolute", left: -14, top: "50%", width: 12, height: 2, backgroundColor: C.border }} />
      )}

      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, backgroundColor: s.color, opacity: session.status === "active" ? 0.8 : 0.3 }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <StatusDot status={session.status} />
          <span style={{ color: "#e2e5eb", fontWeight: 600, fontSize: isAgent ? 12 : 14, fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {isAgent && <span style={{ color: C.textDim, marginRight: 4 }}>↳</span>}
            {session.project?.name || session.sessionId?.slice(0, 8)}
          </span>
          {session.branch && <Badge color={C.textMuted} bg={C.border}>{session.branch}</Badge>}
          {isAgent && <Badge color={C.purple} bg={C.purpleDim}>agent</Badge>}
          {agentCount > 0 && (
            <Badge color={C.purple} bg={C.purpleDim}>{agentCount} agent{agentCount > 1 ? "s" : ""}</Badge>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Badge color={s.color} bg={s.bg}>{s.label}</Badge>
          <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>{session.host}</span>
        </div>
      </div>

      {/* Last message */}
      <div style={{
        fontSize: 12, color: session.status === "error" ? C.red : C.textMuted, marginBottom: 12,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {session.lastAssistantMessage || session.summary || "—"}
      </div>

      {/* Stats */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>
        <span title="Messages">💬 {session.messages || 0}</span>
        <span title="Tool calls">🔧 {session.toolCalls || 0}</span>
        {elapsed > 0 && <span title="Duration">⏱ {formatDuration(elapsed)}</span>}
        <span title="Last active">↻ {timeAgo(session.lastTimestamp)}</span>
        {session.model && <span style={{ color: C.textDim }}>{session.model.replace("claude-", "").replace(/-\d{8}$/, "")}</span>}
        {cost > 0 && <span title="Estimated cost" style={{ color: C.amber }}>~{formatCost(cost)}</span>}
        {session.tmux && (
          <Badge color={C.accent} bg={C.accentDim} title={`tmux: ${session.tmux.session}:${session.tmux.window}.${session.tmux.pane}`}>
            tmux:{session.tmux.session}:{session.tmux.window}
            {session.tmux.attached && " *"}
          </Badge>
        )}
      </div>

      {/* Expanded */}
      {expanded && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}`, animation: "fadeIn 0.2s ease" }}>
          {/* Last conversation */}
          {(session.lastUserMessage || session.lastAssistantMessage) && (
            <div style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {session.lastUserMessage && (
                <div style={{ padding: "8px 12px", borderRadius: 6, backgroundColor: "rgba(34,211,238,0.05)", borderLeft: `2px solid ${C.accent}` }}>
                  <div style={{ fontSize: 10, color: C.accent, marginBottom: 4, fontFamily: "monospace" }}>You</div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.5, wordBreak: "break-word" }}>{session.lastUserMessage}</div>
                </div>
              )}
              {session.lastAssistantMessage && (
                <div style={{ padding: "8px 12px", borderRadius: 6, backgroundColor: "rgba(167,139,250,0.05)", borderLeft: `2px solid ${C.purple}` }}>
                  <div style={{ fontSize: 10, color: C.purple, marginBottom: 4, fontFamily: "monospace" }}>Claude</div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.5, wordBreak: "break-word" }}>{session.lastAssistantMessage}</div>
                </div>
              )}
            </div>
          )}

          {/* Info grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
            <DetailCell label="Model" value={session.model ? session.model.replace("claude-", "").replace(/-\d{8}$/, "") : "—"} />
            <DetailCell label="Git Branch" value={session.branch || "—"} />
            <DetailCell label="Version" value={session.version || "—"} />
            <DetailCell label="Working Directory" value={session.project?.path || "—"} full />
            <DetailCell label="Session Started" value={session.firstTimestamp ? new Date(session.firstTimestamp).toLocaleString() : "—"} />
            <DetailCell label="Duration" value={elapsed > 0 ? formatDuration(elapsed) : "—"} />
          </div>

          {/* Message stats */}
          <div style={{ display: "flex", gap: 16, marginBottom: 14, padding: "10px 12px", borderRadius: 6, backgroundColor: C.bg }}>
            <StatItem label="User Msgs" value={session.userMessages || 0} color={C.accent} />
            <StatItem label="Assistant Msgs" value={session.assistantMessages || 0} color={C.purple} />
            <StatItem label="Tool Calls" value={session.toolCalls || 0} color={C.amber} />
            <StatItem label="Total Lines" value={session.messages || 0} color={C.textMuted} />
            <StatItem label="File Size" value={session.fileSize ? (session.fileSize / 1024 / 1024).toFixed(1) + " MB" : "—"} color={C.textMuted} />
            <StatItem label="Est. Cost" value={formatCost(cost)} color={C.amber} />
          </div>

          {/* Token bar */}
          {session.tokens && (session.tokens.input > 0 || session.tokens.output > 0 || session.tokens.cacheRead > 0) && (
            <div style={{ marginBottom: 14 }}>
              <TokenBar input={session.tokens.input} output={session.tokens.output} cacheRead={session.tokens.cacheRead} />
            </div>
          )}

          {/* Session ID + SSH command */}
          <div style={{ display: "flex", gap: 8, fontSize: 11, color: C.textDim, fontFamily: "monospace", marginBottom: 8 }}>
            <span>ID: {session.sessionId || "—"}</span>
          </div>
          <CopyCommand text={`ssh -t ${session.host} 'tmux attach -t ${session.project?.name || "session"}'`} />
        </div>
      )}
    </div>
  );
}

// ─── Table View (Part 2E) ───────────────────────────────────

function SessionTable({ sessions, expandedId, setExpandedId }) {
  const thStyle = {
    padding: "8px 12px", fontSize: 10, color: C.textDim, textTransform: "uppercase",
    letterSpacing: "0.08em", fontFamily: "monospace", textAlign: "left",
    borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0,
    backgroundColor: C.surface,
  };
  const tdStyle = {
    padding: "8px 12px", fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
    borderBottom: `1px solid ${C.border}`, color: C.text, whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200,
  };

  return (
    <div style={{ borderRadius: 8, border: `1px solid ${C.border}`, overflow: "auto", backgroundColor: C.surface }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}></th>
            <th style={thStyle}>Project</th>
            <th style={thStyle}>Host</th>
            <th style={thStyle}>Branch</th>
            <th style={thStyle}>Msgs</th>
            <th style={thStyle}>Tools</th>
            <th style={thStyle}>Tokens</th>
            <th style={thStyle}>Cost</th>
            <th style={thStyle}>Last Active</th>
            <th style={thStyle}>Model</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(session => {
            const uid = `${session.sessionId}:${session.host}`;
            const totalTokens = (session.tokens?.input || 0) + (session.tokens?.output || 0) + (session.tokens?.cacheRead || 0);
            const cost = estimateCost(session.model, session.tokens);
            const isExpanded = expandedId === uid;
            const agents = session._agents || [];

            return [
              <tr key={uid} onClick={() => setExpandedId(isExpanded ? null : uid)}
                style={{ cursor: "pointer", backgroundColor: isExpanded ? C.surfaceHover : "transparent", transition: "background 0.15s" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = C.surfaceHover}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = isExpanded ? C.surfaceHover : "transparent"}
              >
                <td style={tdStyle}><StatusDot status={session.status} /></td>
                <td style={{ ...tdStyle, color: "#e2e5eb", fontWeight: 500 }}>
                  {session.project?.name || session.sessionId?.slice(0, 8)}
                  {agents.length > 0 && <span style={{ color: C.purple, fontSize: 10, marginLeft: 6 }}>+{agents.length}</span>}
                </td>
                <td style={{ ...tdStyle, color: C.textMuted }}>{session.host}</td>
                <td style={{ ...tdStyle, color: C.textMuted }}>{session.branch || "—"}</td>
                <td style={tdStyle}>{session.messages || 0}</td>
                <td style={tdStyle}>{session.toolCalls || 0}</td>
                <td style={tdStyle}>{formatTokens(totalTokens)}</td>
                <td style={{ ...tdStyle, color: C.amber }}>{formatCost(cost)}</td>
                <td style={{ ...tdStyle, color: C.textMuted }}>{timeAgo(session.lastTimestamp)}</td>
                <td style={{ ...tdStyle, color: C.textDim, fontSize: 11 }}>{session.model ? session.model.replace("claude-", "").replace(/-\d{8}$/, "") : "—"}</td>
              </tr>,
              ...agents.map(agent => {
                const auid = `${agent.sessionId}:${agent.host}`;
                const agentCost = estimateCost(agent.model, agent.tokens);
                const agentTokens = (agent.tokens?.input || 0) + (agent.tokens?.output || 0) + (agent.tokens?.cacheRead || 0);
                return (
                  <tr key={auid} style={{ backgroundColor: "rgba(167,139,250,0.03)" }}>
                    <td style={tdStyle}><StatusDot status={agent.status} /></td>
                    <td style={{ ...tdStyle, color: C.textMuted, paddingLeft: 28 }}>
                      <span style={{ color: C.textDim }}>↳</span> {agent.project?.name || agent.sessionId?.slice(0, 8)}
                      <Badge color={C.purple} bg={C.purpleDim}>agent</Badge>
                    </td>
                    <td style={{ ...tdStyle, color: C.textMuted }}>{agent.host}</td>
                    <td style={{ ...tdStyle, color: C.textMuted }}>{agent.branch || "—"}</td>
                    <td style={tdStyle}>{agent.messages || 0}</td>
                    <td style={tdStyle}>{agent.toolCalls || 0}</td>
                    <td style={tdStyle}>{formatTokens(agentTokens)}</td>
                    <td style={{ ...tdStyle, color: C.amber }}>{formatCost(agentCost)}</td>
                    <td style={{ ...tdStyle, color: C.textMuted }}>{timeAgo(agent.lastTimestamp)}</td>
                    <td style={{ ...tdStyle, color: C.textDim, fontSize: 11 }}>{agent.model ? agent.model.replace("claude-", "").replace(/-\d{8}$/, "") : "—"}</td>
                  </tr>
                );
              }),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Aggregate Stats Bar ────────────────────────────────────

function AggregateStats({ data, sessions }) {
  const agg = data?.aggregate;
  if (!agg) return null;

  // Compute total cost across all sessions
  const totalCost = (sessions || []).reduce((sum, s) => sum + estimateCost(s.model, s.tokens), 0);

  const stats = [
    { label: "Active", value: agg.active, color: C.green },
    { label: "Idle", value: agg.idle, color: C.amber },
    { label: "Errors", value: agg.errors, color: C.red },
    { label: "Hosts", value: agg.hosts?.length || 0, color: C.accent },
    { label: "Messages", value: agg.totalMessages, color: C.text },
    { label: "Tool Calls", value: agg.totalToolCalls, color: C.purple },
    { label: "Input Tokens", value: formatTokens(agg.totalTokens?.input), color: C.accent },
    { label: "Output Tokens", value: formatTokens(agg.totalTokens?.output), color: C.purple },
    { label: "Cache Read", value: formatTokens(agg.totalTokens?.cacheRead), color: C.textMuted },
    { label: "Est. Cost", value: formatCost(totalCost), color: C.amber },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 1, backgroundColor: C.border, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.border}` }}>
      {stats.map((s, i) => (
        <div key={i} style={{ backgroundColor: C.surface, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Host Status Bar ────────────────────────────────────────

function HostStatus({ hosts, hostFilter, onHostClick }) {
  if (!hosts || hosts.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "monospace", marginRight: 4 }}>Host</span>
      <button onClick={() => onHostClick("all")} style={{
        display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
        borderRadius: 4, backgroundColor: hostFilter === "all" ? C.accentDim : C.surface,
        border: `1px solid ${hostFilter === "all" ? C.accent + "40" : C.border}`,
        fontSize: 11, fontFamily: "monospace", cursor: "pointer", transition: "all 0.15s",
        color: hostFilter === "all" ? C.accent : C.textMuted,
      }}>All</button>
      {hosts.map((h) => (
        <button key={h.name} onClick={() => onHostClick(h.name)} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
          borderRadius: 4, cursor: "pointer", transition: "all 0.15s",
          backgroundColor: hostFilter === h.name ? C.accentDim : C.surface,
          border: `1px solid ${hostFilter === h.name ? C.accent + "40" : C.border}`,
          fontSize: 11, fontFamily: "monospace",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: h.status === "connected" ? C.green : C.red }} />
          <span style={{ color: hostFilter === h.name ? C.accent : C.textMuted }}>{h.name}</span>
          <span style={{ fontSize: 9, padding: "0px 4px", borderRadius: 6, backgroundColor: hostFilter === h.name ? C.accent + "20" : C.border, color: C.textDim }}>{h.sessionCount}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Tmux Status Panel ──────────────────────────────────

function TmuxPanel({ tmux }) {
  const [collapsed, setCollapsed] = usePersistedState("tmuxCollapsed", false);
  const [expandedSession, setExpandedSession] = useState(null);

  if (!tmux || tmux.length === 0) return null;

  // Flatten all tmux sessions across hosts
  const allSessions = [];
  for (const hostData of tmux) {
    for (const sess of hostData.sessions || []) {
      allSessions.push({ ...sess, host: hostData.host, method: hostData.method });
    }
  }

  if (allSessions.length === 0) return null;

  // Count linked Claude sessions across all panes
  const linkedCount = allSessions.reduce((n, sess) =>
    n + (sess.windows || []).reduce((wn, win) =>
      wn + (win.panes || []).filter(p => p.claudeSessions?.length > 0).length, 0), 0);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: collapsed ? 0 : 8,
          cursor: "pointer", userSelect: "none",
        }}
      >
        <span style={{ fontSize: 10, color: C.textDim, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}>▸</span>
        <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "monospace" }}>
          Tmux Sessions
        </span>
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, backgroundColor: C.border, color: C.textMuted, fontFamily: "monospace" }}>
          {allSessions.length}
        </span>
        {linkedCount > 0 && (
          <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, backgroundColor: C.greenDim, color: C.green, fontFamily: "monospace" }}>
            {linkedCount} linked
          </span>
        )}
      </div>
      {!collapsed && (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {allSessions.map((sess) => {
          const uid = `${sess.host}:${sess.name}`;
          const isExpanded = expandedSession === uid;
          const createdDate = sess.created ? new Date(sess.created * 1000) : null;

          return (
            <div key={uid}>
              <div
                onClick={() => setExpandedSession(isExpanded ? null : uid)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                  borderRadius: 6, backgroundColor: C.surface,
                  border: `1px solid ${isExpanded ? C.accent + "40" : C.border}`,
                  cursor: "pointer", transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent + "40"; e.currentTarget.style.backgroundColor = C.surfaceHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = isExpanded ? C.accent + "40" : C.border; e.currentTarget.style.backgroundColor = C.surface; }}
              >
                {/* Attached indicator */}
                <span style={{
                  width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                  backgroundColor: sess.attached ? C.green : C.textDim,
                }} />

                {/* Session name */}
                <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e5eb", fontFamily: "'JetBrains Mono', monospace", minWidth: 100 }}>
                  {sess.name}
                </span>

                {/* Host badge */}
                <Badge color={C.accent} bg={C.accentDim}>{sess.host}</Badge>

                {/* Attached badge */}
                {sess.attached && <Badge color={C.green} bg={C.greenDim}>attached</Badge>}

                {/* Window count */}
                <span style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>
                  {sess.windowCount} {sess.windowCount === 1 ? "window" : "windows"}
                </span>

                {/* Created time */}
                {createdDate && (
                  <span style={{ fontSize: 10, color: C.textDim, fontFamily: "monospace", marginLeft: "auto" }}>
                    {timeAgo(createdDate.toISOString())}
                  </span>
                )}

                {/* Expand indicator */}
                <span style={{ fontSize: 10, color: C.textDim, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
              </div>

              {/* Expanded: show windows and panes */}
              {isExpanded && (
                <div style={{ marginLeft: 20, marginTop: 4, display: "flex", flexDirection: "column", gap: 3, animation: "fadeIn 0.15s ease-out" }}>
                  {(sess.windows || []).map((win) => (
                    <div key={win.windowId} style={{
                      padding: "6px 10px", borderRadius: 4,
                      backgroundColor: win.active ? "rgba(34,211,238,0.04)" : "transparent",
                      border: `1px solid ${win.active ? C.accent + "20" : C.border}`,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: win.panes?.length > 0 ? 6 : 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 500, color: win.active ? C.accent : C.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
                          {win.active ? "▸ " : "  "}{win.name}
                        </span>
                        <span style={{ fontSize: 10, color: C.textDim, fontFamily: "monospace" }}>
                          {win.paneCount} {win.paneCount === 1 ? "pane" : "panes"}
                        </span>
                      </div>

                      {/* Panes */}
                      {(win.panes || []).map((pane) => (
                        <div key={pane.paneId} style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "3px 8px", marginLeft: 12,
                          fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                          color: pane.active ? C.text : C.textMuted,
                        }}>
                          <span style={{
                            width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                            backgroundColor: pane.active ? C.green : C.textDim,
                          }} />
                          <span style={{ color: C.purple, minWidth: 80 }}>{pane.command}</span>
                          <span style={{ color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>
                            {pane.cwd}
                          </span>
                          {/* Linked Claude sessions */}
                          {pane.claudeSessions?.map((cs) => {
                            const csStatus = STATUS_MAP[cs.status] || STATUS_MAP.completed;
                            return (
                              <Badge key={cs.sessionId} color={csStatus.color} bg={csStatus.bg}>
                                {cs.project || cs.sessionId.slice(0, 6)} ({csStatus.label})
                              </Badge>
                            );
                          })}
                          <span style={{ color: C.textDim, marginLeft: "auto", flexShrink: 0 }}>
                            {pane.width}x{pane.height}
                          </span>
                          <span style={{ color: C.textDim, flexShrink: 0 }}>
                            pid:{pane.pid}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────

export default function App() {
  const { state, connected, pollIntervalMs, lastUpdated, requestRefresh, hookEvents } = useMonitorSocket();
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = usePersistedState("filter", "all");
  const [folderFilter, setFolderFilter] = usePersistedState("folderFilter", "all");
  const [hostFilter, setHostFilter] = usePersistedState("hostFilter", "all");
  const [viewMode, setViewMode] = usePersistedState("viewMode", "cards");
  const [demoMode, setDemoMode] = useState(false);
  const [demoData, setDemoData] = useState(null);
  const [tick, setTick] = useState(0);
  const prevStatusesRef = useRef({});

  // ─── Desktop Notifications (Part 2D) ────────────────────
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Track session status transitions for notifications
  useEffect(() => {
    if (!state?.sessions) return;
    const prev = prevStatusesRef.current;
    const next = {};

    for (const s of state.sessions) {
      const key = `${s.sessionId}:${s.host}`;
      next[key] = s.status;

      const oldStatus = prev[key];
      if (!oldStatus) continue; // first time seeing this session

      if (oldStatus !== s.status && typeof Notification !== "undefined" && Notification.permission === "granted") {
        if (s.status === "error" && oldStatus === "active") {
          new Notification("Session Error", {
            body: `${s.project?.name || s.sessionId?.slice(0, 8)} on ${s.host} hit an error`,
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔴</text></svg>",
          });
        } else if (s.status === "completed" && (oldStatus === "active" || oldStatus === "idle")) {
          new Notification("Session Completed", {
            body: `${s.project?.name || s.sessionId?.slice(0, 8)} on ${s.host} finished`,
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>✅</text></svg>",
          });
        }
      }
    }

    prevStatusesRef.current = next;
  }, [state?.sessions]);

  // ─── Hook event notifications ─────────────────────────────
  const lastHookIdRef = useRef(null);
  useEffect(() => {
    if (hookEvents.length === 0) return;
    const latest = hookEvents[0];
    // Avoid re-firing for the same event
    const eventKey = `${latest.event}:${latest.timestamp}`;
    if (lastHookIdRef.current === eventKey) return;
    lastHookIdRef.current = eventKey;

    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    const name = latest.project || "Claude Code";
    if (latest.event === "Stop" || latest.event === "PostToolUseFailure") {
      new Notification(`Hook: ${latest.event}`, {
        body: `${name}${latest.error ? ` — ${latest.error}` : latest.toolName ? ` (${latest.toolName})` : ""}`,
        tag: eventKey,
      });
    } else if (latest.event === "Notification") {
      new Notification(`Claude Code`, {
        body: `${name} needs attention`,
        tag: eventKey,
      });
    }
  }, [hookEvents]);

  // If not connected for 5s, switch to demo mode
  useEffect(() => {
    if (connected && state?.sessions?.length > 0) {
      setDemoMode(false);
      return;
    }
    const timer = setTimeout(() => {
      if (!state?.sessions?.length) {
        setDemoMode(true);
        const sessions = generateDemoSessions();
        setDemoData({
          sessions,
          aggregate: {
            totalSessions: sessions.length,
            active: sessions.filter(s => s.status === "active").length,
            idle: sessions.filter(s => s.status === "idle").length,
            completed: sessions.filter(s => s.status === "completed").length,
            errors: sessions.filter(s => s.status === "error").length,
            totalMessages: sessions.reduce((a, s) => a + s.messages, 0),
            totalToolCalls: sessions.reduce((a, s) => a + s.toolCalls, 0),
            totalTokens: {
              input: sessions.reduce((a, s) => a + (s.tokens?.input || 0), 0),
              output: sessions.reduce((a, s) => a + (s.tokens?.output || 0), 0),
              cacheRead: sessions.reduce((a, s) => a + (s.tokens?.cacheRead || 0), 0),
            },
            hosts: [
              { name: "dev-server-1", status: "connected", sessionCount: 3 },
              { name: "dev-server-2", status: "connected", sessionCount: 2 },
              { name: "gpu-box", status: "connected", sessionCount: 1 },
            ],
          },
        });
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [connected, state]);

  // Simulate updates in demo mode
  useEffect(() => {
    if (!demoMode) return;
    const interval = setInterval(() => setTick(t => t + 1), 3000);
    return () => clearInterval(interval);
  }, [demoMode]);

  const data = demoMode ? demoData : state;
  const sessions = data?.sessions || [];

  // Sessions filtered by host (used to derive available folders)
  const hostFiltered = hostFilter === "all" ? sessions : sessions.filter(s => s.host === hostFilter);

  // Extract unique project folders from host-filtered sessions
  const projectFolders = [...new Set(hostFiltered.map(s => s.project?.name).filter(Boolean))].sort();

  // Reset folder filter if selected folder no longer exists for this host
  const effectiveFolderFilter = folderFilter !== "all" && !projectFolders.includes(folderFilter) ? "all" : folderFilter;

  let filtered = hostFiltered;

  if (filter === "active") filtered = filtered.filter(s => s.status === "active");
  else if (filter === "issues") filtered = filtered.filter(s => s.status === "error" || s.status === "idle");

  if (effectiveFolderFilter !== "all") {
    filtered = filtered.filter(s => s.project?.name === effectiveFolderFilter);
  }

  // Group sessions for card view (Part 2B)
  const grouped = groupSessions(filtered);

  const filterButtons = [
    { key: "all", label: "All", count: sessions.length },
    { key: "active", label: "Active", count: sessions.filter(s => s.status === "active").length },
    { key: "issues", label: "Attention", count: sessions.filter(s => s.status === "error" || s.status === "idle").length },
  ];

  return (
    <div style={{ minHeight: "100vh", backgroundColor: C.bg, color: C.text, fontFamily: "'Inter', -apple-system, sans-serif", padding: "24px 28px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.4; } 50% { transform: scale(2); opacity: 0; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#e2e5eb", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "-0.02em" }}>
            <span style={{ color: C.accent }}>⬡</span> Claude Code Monitor
          </h1>
          <span style={{ fontSize: 11, color: C.textDim, fontFamily: "monospace" }}>
            {sessions.length} sessions
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Auto-refresh countdown (Part 2C) */}
          {connected && <CountdownTimer pollIntervalMs={pollIntervalMs} lastUpdated={lastUpdated} onRefresh={requestRefresh} />}

          {/* View toggle (Part 2E) */}
          <div style={{ display: "flex", borderRadius: 6, border: `1px solid ${C.border}`, overflow: "hidden" }}>
            <button onClick={() => setViewMode("cards")} style={{
              padding: "5px 10px", border: "none", cursor: "pointer", fontSize: 11, fontFamily: "monospace",
              backgroundColor: viewMode === "cards" ? C.accentDim : "transparent",
              color: viewMode === "cards" ? C.accent : C.textMuted,
              transition: "all 0.15s",
            }}>▦ Cards</button>
            <button onClick={() => setViewMode("table")} style={{
              padding: "5px 10px", border: "none", borderLeft: `1px solid ${C.border}`, cursor: "pointer", fontSize: 11, fontFamily: "monospace",
              backgroundColor: viewMode === "table" ? C.accentDim : "transparent",
              color: viewMode === "table" ? C.accent : C.textMuted,
              transition: "all 0.15s",
            }}>≡ Table</button>
          </div>

          {demoMode && (
            <Badge color={C.amber} bg={C.amberDim}>DEMO MODE</Badge>
          )}
          <div style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 6,
            backgroundColor: connected ? C.greenDim : C.redDim,
            border: `1px solid ${connected ? C.green : C.red}20`,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: connected ? C.green : C.red }} />
            <span style={{ fontSize: 11, color: connected ? C.green : C.red, fontFamily: "monospace" }}>
              {connected ? "Live" : "Disconnected"}
            </span>
          </div>
        </div>
      </div>

      {/* Host status */}
      {data?.aggregate?.hosts && (
        <div style={{ marginBottom: 16 }}>
          <HostStatus hosts={data.aggregate.hosts} hostFilter={hostFilter} onHostClick={(h) => { setHostFilter(hostFilter === h ? "all" : h); }} />
        </div>
      )}

      {/* Folder filter */}
      {projectFolders.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "monospace", marginRight: 4 }}>Folder</span>
          <button onClick={() => { setFolderFilter("all"); }} style={{
            padding: "4px 10px", borderRadius: 4,
            border: `1px solid ${folderFilter === "all" ? C.purple + "40" : C.border}`,
            backgroundColor: folderFilter === "all" ? C.purpleDim : "transparent",
            color: folderFilter === "all" ? C.purple : C.textMuted,
            fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
            cursor: "pointer", transition: "all 0.15s",
          }}>All</button>
          {projectFolders.map(folder => {
            const count = sessions.filter(s => s.project?.name === folder).length;
            return (
              <button key={folder} onClick={() => { setFolderFilter(folderFilter === folder ? "all" : folder); }} style={{
                padding: "4px 10px", borderRadius: 4,
                border: `1px solid ${folderFilter === folder ? C.purple + "40" : C.border}`,
                backgroundColor: folderFilter === folder ? C.purpleDim : "transparent",
                color: folderFilter === folder ? C.purple : C.textMuted,
                fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
                cursor: "pointer", transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 4,
              }}>
                {folder}
                <span style={{ fontSize: 9, padding: "0px 4px", borderRadius: 6, backgroundColor: folderFilter === folder ? C.purple + "20" : C.border }}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Aggregate stats */}
      <AggregateStats data={data} sessions={sessions} />

      {/* Tmux status */}
      <div style={{ marginTop: 16 }}>
        <TmuxPanel tmux={data?.tmux} />
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 6, margin: "16px 0" }}>
        {filterButtons.map(f => (
          <button key={f.key} onClick={() => { setFilter(f.key); }} style={{
            padding: "6px 14px", borderRadius: 6,
            border: `1px solid ${filter === f.key ? C.accent + "40" : C.border}`,
            backgroundColor: filter === f.key ? C.accentDim : "transparent",
            color: filter === f.key ? C.accent : C.textMuted,
            fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
            cursor: "pointer", transition: "all 0.15s",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {f.label}
            <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, backgroundColor: filter === f.key ? C.accent + "20" : C.border }}>
              {f.count}
            </span>
          </button>
        ))}
      </div>

      {/* Sessions */}
      {filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 40, color: C.textDim, fontFamily: "monospace" }}>
          No sessions found. Make sure Claude Code is running and config.json points to the right hosts.
        </div>
      )}

      {filtered.length > 0 && viewMode === "table" ? (
        <SessionTable sessions={grouped} expandedId={expandedId} setExpandedId={setExpandedId} />
      ) : filtered.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {grouped.map(session => {
            const uid = `${session.sessionId}:${session.host}`;
            const agents = session._agents || [];
            return (
              <div key={uid}>
                <SessionCard
                  session={session}
                  expanded={expandedId === uid}
                  onToggle={() => setExpandedId(expandedId === uid ? null : uid)}
                  isAgent={false}
                />
                {agents.map(agent => {
                  const auid = `${agent.sessionId}:${agent.host}`;
                  return (
                    <div key={auid} style={{ marginTop: 4 }}>
                      <SessionCard
                        session={agent}
                        expanded={expandedId === auid}
                        onToggle={() => setExpandedId(expandedId === auid ? null : auid)}
                        isAgent={true}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Hook event feed */}
      {hookEvents.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "monospace", marginBottom: 8 }}>
            Hook Events
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
            {hookEvents.slice(0, 20).map((ev, i) => {
              const isError = ev.event === "PostToolUseFailure" || ev.error;
              const isStop = ev.event === "Stop";
              const dotColor = isError ? C.red : isStop ? C.green : C.accent;
              return (
                <div key={`${ev.timestamp}-${i}`} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                  borderRadius: 4, backgroundColor: C.surface, border: `1px solid ${C.border}`,
                  fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: dotColor, flexShrink: 0 }} />
                  <span style={{ color: C.textMuted, flexShrink: 0 }}>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                  <Badge color={dotColor} bg={isError ? C.redDim : isStop ? C.greenDim : C.accentDim}>{ev.event}</Badge>
                  {ev.project && <span style={{ color: C.text }}>{ev.project}</span>}
                  {ev.toolName && <span style={{ color: C.textDim }}>({ev.toolName})</span>}
                  {ev.error && <span style={{ color: C.red, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.error}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{
        marginTop: 20, padding: "12px 0", borderTop: `1px solid ${C.border}`,
        display: "flex", justifyContent: "space-between",
        fontSize: 10, color: C.textDim, fontFamily: "monospace",
      }}>
        <span>Data: ~/.claude/projects/**/*.jsonl + stats-cache.json</span>
        <span>{data?.updatedAt ? `Updated: ${new Date(data.updatedAt).toLocaleTimeString()}` : ""}</span>
      </div>
    </div>
  );
}
