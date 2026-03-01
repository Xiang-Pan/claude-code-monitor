import { useState, useEffect, useRef } from "react";
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
  ];

  return items.map((item, i) => ({
    sessionId: `demo-${i}-${Math.random().toString(36).slice(2, 10)}`,
    isAgent: false,
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

// ─── Session Card ───────────────────────────────────────────

function SessionCard({ session, expanded, onToggle }) {
  const s = STATUS_MAP[session.status] || STATUS_MAP.completed;
  const elapsed = session.firstTimestamp ? Date.now() - new Date(session.firstTimestamp).getTime() : 0;

  return (
    <div
      onClick={onToggle}
      style={{
        backgroundColor: C.surface, border: `1px solid ${expanded ? s.color + "40" : C.border}`,
        borderRadius: 8, padding: 16, cursor: "pointer", transition: "all 0.2s ease",
        position: "relative", overflow: "hidden",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = s.color + "60"; e.currentTarget.style.backgroundColor = C.surfaceHover; }}
      onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.borderColor = C.border; e.currentTarget.style.backgroundColor = C.surface; }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, backgroundColor: s.color, opacity: session.status === "active" ? 0.8 : 0.3 }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <StatusDot status={session.status} />
          <span style={{ color: "#e2e5eb", fontWeight: 600, fontSize: 14, fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.project?.name || session.sessionId?.slice(0, 8)}
          </span>
          {session.branch && <Badge color={C.textMuted} bg={C.border}>{session.branch}</Badge>}
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
      </div>

      {/* Expanded */}
      {expanded && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}`, animation: "fadeIn 0.2s ease" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Model</div>
              <div style={{ fontSize: 12, color: C.text, fontFamily: "monospace" }}>{session.model || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Working Directory</div>
              <div style={{ fontSize: 12, color: C.text, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis" }}>{session.project?.path || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Session Started</div>
              <div style={{ fontSize: 12, color: C.text, fontFamily: "monospace" }}>{session.firstTimestamp ? new Date(session.firstTimestamp).toLocaleTimeString() : "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Session ID</div>
              <div style={{ fontSize: 12, color: C.text, fontFamily: "monospace" }}>{session.sessionId?.slice(0, 12) || "—"}…</div>
            </div>
          </div>

          {session.tokens && <TokenBar input={session.tokens.input} output={session.tokens.output} cacheRead={session.tokens.cacheRead} />}

          <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 4, backgroundColor: C.accentDim, border: `1px solid ${C.accent}20`, fontSize: 11, color: C.accent, fontFamily: "monospace" }}>
            ssh -t {session.host} 'tmux attach -t {session.project?.name || "session"}'
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Aggregate Stats Bar ────────────────────────────────────

function AggregateStats({ data }) {
  const agg = data?.aggregate;
  if (!agg) return null;

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

function HostStatus({ hosts }) {
  if (!hosts || hosts.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {hosts.map((h) => (
        <div key={h.name} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
          borderRadius: 4, backgroundColor: C.surface, border: `1px solid ${C.border}`,
          fontSize: 11, fontFamily: "monospace",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: h.status === "connected" ? C.green : C.red }} />
          <span style={{ color: C.textMuted }}>{h.name}</span>
          <span style={{ color: C.textDim }}>({h.sessionCount})</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────

export default function App() {
  const { state, connected } = useMonitorSocket();
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [demoMode, setDemoMode] = useState(false);
  const [demoData, setDemoData] = useState(null);
  const [tick, setTick] = useState(0);

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

  const filtered = filter === "all" ? sessions
    : filter === "active" ? sessions.filter(s => s.status === "active")
    : filter === "issues" ? sessions.filter(s => s.status === "error" || s.status === "idle")
    : sessions;

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
          <HostStatus hosts={data.aggregate.hosts} />
        </div>
      )}

      {/* Aggregate stats */}
      <AggregateStats data={data} />

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 6, margin: "16px 0" }}>
        {filterButtons.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={{
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
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: 40, color: C.textDim, fontFamily: "monospace" }}>
            No sessions found. Make sure Claude Code is running and config.json points to the right hosts.
          </div>
        )}
        {filtered.map(session => (
          <SessionCard
            key={session.sessionId}
            session={session}
            expanded={expandedId === session.sessionId}
            onToggle={() => setExpandedId(expandedId === session.sessionId ? null : session.sessionId)}
          />
        ))}
      </div>

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
