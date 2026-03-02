import { useState, useEffect, useRef } from "react";
import { useMonitorSocket } from "./hooks/useMonitorSocket.js";
import { usePersistedState } from "./hooks/usePersistedState.js";
import { C } from "./components/theme.js";
import { groupSessions, estimateCost } from "./components/helpers.js";
import { Badge } from "./components/Badge.jsx";
import { CountdownTimer } from "./components/CountdownTimer.jsx";
import { SessionCard } from "./components/SessionCard.jsx";
import { SessionTable } from "./components/SessionTable.jsx";
import { AggregateStats } from "./components/AggregateStats.jsx";
import { HostStatus } from "./components/HostStatus.jsx";
import { TmuxPanel } from "./components/TmuxPanel.jsx";

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

  // ─── Desktop Notifications ────────────────────────────────
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (!state?.sessions) return;
    const prev = prevStatusesRef.current;
    const next = {};

    for (const s of state.sessions) {
      const key = `${s.sessionId}:${s.host}`;
      next[key] = s.status;

      const oldStatus = prev[key];
      if (!oldStatus) continue;

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
        } else if (s.status === "idle" && oldStatus === "active") {
          new Notification("Waiting for input", {
            body: `${s.project?.name || s.sessionId?.slice(0, 8)} on ${s.host} may need attention`,
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⏳</text></svg>",
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
    const eventKey = `${latest.event}:${latest.timestamp}`;
    if (lastHookIdRef.current === eventKey) return;
    lastHookIdRef.current = eventKey;

    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    const name = latest.project || "Claude Code";
    if (latest.event === "Stop" && latest.stopReason === "end_turn") {
      new Notification("Waiting for input", {
        body: `${name} finished — your turn`,
        tag: eventKey,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⏳</text></svg>",
      });
    } else if (latest.event === "Stop" || latest.event === "PostToolUseFailure") {
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

  useEffect(() => {
    if (!demoMode) return;
    const interval = setInterval(() => setTick(t => t + 1), 3000);
    return () => clearInterval(interval);
  }, [demoMode]);

  const data = demoMode ? demoData : state;
  const sessions = data?.sessions || [];

  const hostFiltered = hostFilter === "all" ? sessions : sessions.filter(s => s.host === hostFilter);
  const projectFolders = [...new Set(hostFiltered.map(s => s.project?.name).filter(Boolean))].sort();
  const effectiveFolderFilter = folderFilter !== "all" && !projectFolders.includes(folderFilter) ? "all" : folderFilter;

  let filtered = hostFiltered;
  if (filter === "active") filtered = filtered.filter(s => s.status === "active");
  else if (filter === "issues") filtered = filtered.filter(s => s.status === "error" || s.status === "idle");
  if (effectiveFolderFilter !== "all") {
    filtered = filtered.filter(s => s.project?.name === effectiveFolderFilter);
  }

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
          {connected && <CountdownTimer pollIntervalMs={pollIntervalMs} lastUpdated={lastUpdated} onRefresh={requestRefresh} />}

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
