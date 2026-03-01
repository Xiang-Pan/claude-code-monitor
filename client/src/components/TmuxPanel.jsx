import { useState } from "react";
import { C, STATUS_MAP } from "./theme.js";
import { timeAgo } from "./helpers.js";
import { usePersistedState } from "../hooks/usePersistedState.js";
import { Badge } from "./Badge.jsx";

export function TmuxPanel({ tmux }) {
  const [collapsed, setCollapsed] = usePersistedState("tmuxCollapsed", false);
  const [expandedSession, setExpandedSession] = useState(null);

  if (!tmux || tmux.length === 0) return null;

  const allSessions = [];
  for (const hostData of tmux) {
    for (const sess of hostData.sessions || []) {
      allSessions.push({ ...sess, host: hostData.host, method: hostData.method });
    }
  }

  if (allSessions.length === 0) return null;

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
                <span style={{
                  width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                  backgroundColor: sess.attached ? C.green : C.textDim,
                }} />

                <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e5eb", fontFamily: "'JetBrains Mono', monospace", minWidth: 100 }}>
                  {sess.name}
                </span>

                <Badge color={C.accent} bg={C.accentDim}>{sess.host}</Badge>

                {sess.attached && <Badge color={C.green} bg={C.greenDim}>attached</Badge>}

                <span style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>
                  {sess.windowCount} {sess.windowCount === 1 ? "window" : "windows"}
                </span>

                {createdDate && (
                  <span style={{ fontSize: 10, color: C.textDim, fontFamily: "monospace", marginLeft: "auto" }}>
                    {timeAgo(createdDate.toISOString())}
                  </span>
                )}

                <span style={{ fontSize: 10, color: C.textDim, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
              </div>

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
