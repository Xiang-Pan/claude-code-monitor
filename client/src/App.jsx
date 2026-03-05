import { useState, useEffect, useRef, useCallback } from "react";
import { useMonitorSocket } from "./hooks/useMonitorSocket.js";
import { usePersistedState } from "./hooks/usePersistedState.js";
import { C } from "./components/theme.js";
import { groupSessions, estimateCost, timeAgo } from "./components/helpers.js";
import { Badge } from "./components/Badge.jsx";
import { CountdownTimer } from "./components/CountdownTimer.jsx";
import { SessionCard } from "./components/SessionCard.jsx";
import { SessionTable } from "./components/SessionTable.jsx";
import { AggregateStats } from "./components/AggregateStats.jsx";
import { HostStatus } from "./components/HostStatus.jsx";
import { TmuxPanel } from "./components/TmuxPanel.jsx";
import { getStatusNotification, getHookNotification } from "./notifications.js";

// ─── Notification sound (short beep via Web Audio API) ─────
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
}

// ─── Voice notification (Edge TTS via server) ────────────
let _ttsAudio = null;
function speakNotification(text) {
  try {
    if (_ttsAudio) { _ttsAudio.pause(); _ttsAudio = null; }
    const url = `/api/tts?text=${encodeURIComponent(text.slice(0, 200))}`;
    _ttsAudio = new Audio(url);
    _ttsAudio.volume = 0.8;
    _ttsAudio.play().catch(() => {});
  } catch {}
}

// ─── Toast component ───────────────────────────────────────
function ToastContainer({ toasts, onDismiss }) {
  return (
    <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
      {toasts.map((t) => (
        <div key={t.id} onClick={() => onDismiss(t.id)} style={{
          padding: "12px 16px", borderRadius: 8,
          backgroundColor: t.color || "#1e3a5f", border: "1px solid #60a5fa",
          color: "#e2e5eb", fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
          cursor: "pointer", boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          animation: "fadeIn 0.3s ease-out",
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{t.title}</div>
          <div style={{ color: "#9ca3af" }}>{t.body}</div>
        </div>
      ))}
    </div>
  );
}

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
      lastInput: Math.floor(Math.random() * 180000) + 20000,
    },
    firstTimestamp: new Date(Date.now() - Math.floor(Math.random() * 7200000) - 600000).toISOString(),
    lastTimestamp: item.status === "active"
      ? new Date(Date.now() - Math.floor(Math.random() * 20000)).toISOString()
      : new Date(Date.now() - Math.floor(Math.random() * 3600000) - 60000).toISOString(),
    lastAssistantMessage: item.msg,
    summary: null,
  }));
}

// ─── Login Screen ────────────────────────────────────────────
function LoginScreen() {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        setError("Wrong password");
      }
    } catch {
      setError("Connection error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", backgroundColor: C.bg, display: "flex", justifyContent: "center", alignItems: "center" }}>
      <div style={{
        backgroundColor: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: 40, width: 360, textAlign: "center",
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#e2e5eb", fontFamily: "'JetBrains Mono', monospace", marginBottom: 8 }}>
          <span style={{ color: C.accent }}>⬡</span> Claude Code Monitor
        </h1>
        <p style={{ fontSize: 12, color: C.textDim, marginBottom: 24 }}>Enter password to access the dashboard</p>
        {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 12, fontFamily: "monospace" }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <input
            type="password" value={pw} onChange={(e) => setPw(e.target.value)}
            placeholder="Password" autoFocus autoComplete="current-password"
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 6,
              border: `1px solid ${C.border}`, backgroundColor: C.bg, color: C.text,
              fontFamily: "'JetBrains Mono', monospace", fontSize: 13, outline: "none", marginBottom: 12,
            }}
          />
          <button type="submit" disabled={loading} style={{
            width: "100%", padding: 10, borderRadius: 6, border: "none",
            backgroundColor: C.accent, color: C.bg, fontWeight: 600, fontSize: 13,
            cursor: loading ? "wait" : "pointer", fontFamily: "'JetBrains Mono', monospace",
            opacity: loading ? 0.7 : 1,
          }}>
            {loading ? "..." : "Log In"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    fetch("/api/auth")
      .then((res) => {
        if (res.status === 401) setNeedsLogin(true);
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return null;
  if (needsLogin) return <LoginScreen />;

  return <Dashboard />;
}

function Dashboard() {
  const { state, connected, pollIntervalMs, lastUpdated, requestRefresh, hookEvents } = useMonitorSocket();
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = usePersistedState("filter", "all");
  const [timeFilter, setTimeFilter] = usePersistedState("timeFilter", "all");
  const [folderFilter, setFolderFilter] = usePersistedState("folderFilter", "all");
  const [hostFilter, setHostFilter] = usePersistedState("hostFilter", "all");
  const [viewMode, setViewMode] = usePersistedState("viewMode", "cards");
  const [hookEventFilter, setHookEventFilter] = usePersistedState("hookEventFilter", "all");
  const [hookTimeFilter, setHookTimeFilter] = usePersistedState("hookTimeFilter", "all");
  const [hookProjectFilter, setHookProjectFilter] = usePersistedState("hookProjectFilter", "all");
  const [hookPanelOpen, setHookPanelOpen] = usePersistedState("hookPanelOpen", true);
  const [voiceEnabled, setVoiceEnabled] = usePersistedState("voiceEnabled", false);
  const [demoMode, setDemoMode] = useState(false);
  const [demoData, setDemoData] = useState(null);
  const [tick, setTick] = useState(0);
  const prevStatusesRef = useRef({});
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((title, body, color) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [{ id, title, body, color }, ...prev].slice(0, 5));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

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

      if (oldStatus !== s.status) {
        const n = getStatusNotification(s, oldStatus);
        if (n) {
          addToast(n.title, n.body, s.status === "error" ? "#3b1a1a" : undefined);
          playNotificationSound();
          if (voiceEnabled) speakNotification(`${n.title}. ${n.body}`);
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification(n.title, { body: n.body, icon: n.icon });
          }
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

    const n = getHookNotification(latest);
    if (n) {
      // In-page toast (always works)
      const isError = latest.event === "PostToolUseFailure" || latest.error;
      addToast(n.title, n.body, isError ? "#3b1a1a" : undefined);
      // Sound
      playNotificationSound();
      // Voice
      if (voiceEnabled) speakNotification(`${n.title}. ${n.body}`);
      // Desktop notification (if permitted)
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(n.title, { body: n.body, tag: n.tag, icon: n.icon });
      }
    }
  }, [hookEvents, addToast, voiceEnabled]);

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
  else if (filter === "idle") filtered = filtered.filter(s => s.status === "idle");
  else if (filter === "error") filtered = filtered.filter(s => s.status === "error");
  else if (filter === "issues") filtered = filtered.filter(s => s.status === "error" || s.status === "idle");
  if (effectiveFolderFilter !== "all") {
    filtered = filtered.filter(s => s.project?.name === effectiveFolderFilter);
  }

  if (timeFilter !== "all") {
    const now = Date.now();
    let cutoff;
    if (timeFilter === "1h") cutoff = now - 3600000;
    else if (timeFilter === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); cutoff = d.getTime(); }
    else if (timeFilter === "24h") cutoff = now - 86400000;
    else if (timeFilter === "7d") cutoff = now - 604800000;
    if (cutoff) {
      filtered = filtered.filter(s => {
        if (!s.lastTimestamp) return false;
        return new Date(s.lastTimestamp).getTime() >= cutoff;
      });
    }
  }

  const grouped = groupSessions(filtered);

  const filterButtons = [
    { key: "all", label: "All", count: hostFiltered.length },
    { key: "active", label: "Active", count: hostFiltered.filter(s => s.status === "active").length },
    { key: "idle", label: "Idle", count: hostFiltered.filter(s => s.status === "idle").length },
    { key: "error", label: "Errors", count: hostFiltered.filter(s => s.status === "error").length },
  ];

  const timeFilterButtons = [
    { key: "all", label: "All Time" },
    { key: "1h", label: "Last Hour" },
    { key: "today", label: "Today" },
    { key: "24h", label: "Last 24h" },
    { key: "7d", label: "Last 7d" },
  ];

  return (
    <div style={{ minHeight: "100vh", backgroundColor: C.bg, color: C.text, fontFamily: "'Inter', -apple-system, sans-serif", padding: "24px 28px" }}>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
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

          <button
            onClick={() => setVoiceEnabled(!voiceEnabled)}
            title={voiceEnabled ? "Voice notifications ON" : "Voice notifications OFF"}
            style={{
              padding: "5px 10px", borderRadius: 6, border: `1px solid ${voiceEnabled ? C.accent + "40" : C.border}`,
              backgroundColor: voiceEnabled ? C.accentDim : "transparent",
              color: voiceEnabled ? C.accent : C.textMuted,
              fontSize: 11, fontFamily: "monospace", cursor: "pointer", transition: "all 0.15s",
            }}
          >{voiceEnabled ? "Voice ON" : "Voice OFF"}</button>

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
      <AggregateStats data={data} sessions={sessions} onFilterClick={setFilter} activeFilter={filter} />

      {/* Tmux status */}
      <div style={{ marginTop: 16 }}>
        <TmuxPanel tmux={data?.tmux} />
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 16, margin: "16px 0", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6 }}>
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
        <div style={{ width: 1, height: 20, backgroundColor: C.border }} />
        <div style={{ display: "flex", gap: 6 }}>
          {timeFilterButtons.map(f => (
            <button key={f.key} onClick={() => { setTimeFilter(f.key); }} style={{
              padding: "6px 14px", borderRadius: 6,
              border: `1px solid ${timeFilter === f.key ? C.purple + "40" : C.border}`,
              backgroundColor: timeFilter === f.key ? C.purpleDim : "transparent",
              color: timeFilter === f.key ? C.purple : C.textMuted,
              fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
              cursor: "pointer", transition: "all 0.15s",
            }}>
              {f.label}
            </button>
          ))}
        </div>
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

      {/* Hook Events Panel */}
      {(() => {
        const hookEventTypes = [...new Set(hookEvents.map(ev => ev.event).filter(Boolean))].sort();
        const hookProjects = [...new Set(hookEvents.map(ev => ev.project).filter(Boolean))].sort();

        const EVENT_COLORS = {
          Notification: { color: C.accent, bg: C.accentDim },
          Stop: { color: C.green, bg: C.greenDim },
          SessionStart: { color: C.purple, bg: C.purpleDim },
          SessionEnd: { color: C.textMuted, bg: "rgba(107,114,128,0.08)" },
          PostToolUseFailure: { color: C.red, bg: C.redDim },
        };

        let filteredHooks = hookEvents;
        if (hookEventFilter !== "all") {
          filteredHooks = filteredHooks.filter(ev => ev.event === hookEventFilter);
        }
        if (hookProjectFilter !== "all") {
          filteredHooks = filteredHooks.filter(ev => ev.project === hookProjectFilter);
        }
        if (hookTimeFilter !== "all") {
          const now = Date.now();
          let cutoff;
          if (hookTimeFilter === "1h") cutoff = now - 3600000;
          else if (hookTimeFilter === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); cutoff = d.getTime(); }
          if (cutoff) {
            filteredHooks = filteredHooks.filter(ev => new Date(ev.timestamp).getTime() >= cutoff);
          }
        }

        const hookFilterBtnStyle = (active, color) => ({
          padding: "4px 10px", borderRadius: 4, border: `1px solid ${active ? color + "40" : C.border}`,
          backgroundColor: active ? color + "12" : "transparent",
          color: active ? color : C.textMuted,
          fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
          cursor: "pointer", transition: "all 0.15s",
        });

        return (
          <div style={{ marginTop: 20 }}>
            {/* Header */}
            <div
              onClick={() => setHookPanelOpen(!hookPanelOpen)}
              style={{
                display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                marginBottom: hookPanelOpen ? 10 : 0,
              }}
            >
              <span style={{ fontSize: 10, color: C.textMuted, transition: "transform 0.15s", transform: hookPanelOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
              <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "monospace" }}>
                Hook Events
              </span>
              <span style={{
                fontSize: 9, padding: "1px 6px", borderRadius: 8,
                backgroundColor: C.accentDim, color: C.accent, fontFamily: "monospace",
              }}>
                {filteredHooks.length}
              </span>
            </div>

            {hookPanelOpen && (
              <>
                {/* Filter row */}
                <div style={{ display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                  {/* Event type filters */}
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", fontFamily: "monospace", marginRight: 2 }}>Type</span>
                    <button onClick={() => setHookEventFilter("all")} style={hookFilterBtnStyle(hookEventFilter === "all", C.accent)}>
                      All
                    </button>
                    {hookEventTypes.map(type => {
                      const ec = EVENT_COLORS[type] || { color: C.accent, bg: C.accentDim };
                      return (
                        <button key={type} onClick={() => setHookEventFilter(hookEventFilter === type ? "all" : type)}
                          style={hookFilterBtnStyle(hookEventFilter === type, ec.color)}>
                          {type}
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ width: 1, height: 16, backgroundColor: C.border }} />

                  {/* Time filter */}
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <span style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", fontFamily: "monospace", marginRight: 2 }}>Time</span>
                    {[{ key: "all", label: "All" }, { key: "1h", label: "1h" }, { key: "today", label: "Today" }].map(f => (
                      <button key={f.key} onClick={() => setHookTimeFilter(f.key)} style={hookFilterBtnStyle(hookTimeFilter === f.key, C.purple)}>
                        {f.label}
                      </button>
                    ))}
                  </div>

                  {/* Project filter */}
                  {hookProjects.length > 1 && (
                    <>
                      <div style={{ width: 1, height: 16, backgroundColor: C.border }} />
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <span style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", fontFamily: "monospace", marginRight: 2 }}>Project</span>
                        <select
                          value={hookProjectFilter}
                          onChange={(e) => setHookProjectFilter(e.target.value)}
                          style={{
                            padding: "4px 8px", borderRadius: 4, border: `1px solid ${C.border}`,
                            backgroundColor: C.bg, color: C.textMuted, fontSize: 11,
                            fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", outline: "none",
                          }}
                        >
                          <option value="all">All</option>
                          {hookProjects.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                </div>

                {/* Event list */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 400, overflowY: "auto" }}>
                  {filteredHooks.length === 0 && (
                    <div style={{ textAlign: "center", padding: 16, color: C.textDim, fontFamily: "monospace", fontSize: 11 }}>
                      {hookEvents.length === 0 ? "No hook events yet — events appear when Claude Code hooks fire" : "No events match filters"}
                    </div>
                  )}
                  {filteredHooks.map((ev, i) => {
                    const isError = ev.event === "PostToolUseFailure" || ev.error;
                    const ec = EVENT_COLORS[ev.event] || { color: C.accent, bg: C.accentDim };
                    const badgeColor = isError ? C.red : ec.color;
                    const badgeBg = isError ? C.redDim : ec.bg;
                    return (
                      <div key={`${ev.timestamp}-${i}`} style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                        borderRadius: 4, backgroundColor: C.surface, border: `1px solid ${C.border}`,
                        fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: badgeColor, flexShrink: 0 }} />
                        <span style={{ color: C.textMuted, flexShrink: 0 }}>{timeAgo(ev.timestamp)}</span>
                        <Badge color={badgeColor} bg={badgeBg}>{ev.event}</Badge>
                        {ev.project && <span style={{ color: C.text }}>{ev.project}</span>}
                        {ev.toolName && <span style={{ color: C.textDim }}>({ev.toolName})</span>}
                        {ev.stopReason && <span style={{ color: C.textDim }}>reason: {ev.stopReason}</span>}
                        {ev.error && <span style={{ color: C.red, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{ev.error}</span>}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      })()}

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
