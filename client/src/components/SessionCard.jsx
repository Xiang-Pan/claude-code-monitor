import { useRef } from "react";
import { C, STATUS_MAP } from "./theme.js";
import { formatDuration, timeAgo, estimateCost, formatCost, contextPercent, contextColor } from "./helpers.js";
import { StatusDot } from "./StatusDot.jsx";
import { Badge } from "./Badge.jsx";
import { TokenBar } from "./TokenBar.jsx";
import { ContextBar } from "./ContextBar.jsx";
import { CopyCommand } from "./CopyCommand.jsx";

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

function ActionButton({ label, title, onClick, color }) {
  return (
    <button
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        padding: "2px 6px", borderRadius: 4, border: `1px solid ${color}30`,
        backgroundColor: "transparent", color, fontSize: 12, lineHeight: 1,
        fontFamily: "'JetBrains Mono', monospace", cursor: "pointer",
        transition: "all 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = color + "18"; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      {label}
    </button>
  );
}

export function SessionCard({ session, expanded, onToggle, isAgent, onOpenTerminal, onAction }) {
  const s = STATUS_MAP[session.status] || STATUS_MAP.completed;
  const elapsed = session.firstTimestamp ? Date.now() - new Date(session.firstTimestamp).getTime() : 0;
  const cost = estimateCost(session.model, session.tokens);
  const agentCount = session._agents?.length || 0;
  const ctxPct = contextPercent(session.tokens?.lastInput, session.model);
  const ctxCol = contextColor(ctxPct);
  const longPressTimer = useRef(null);
  const didLongPress = useRef(false);

  const startPress = () => {
    didLongPress.current = false;
    if (!onOpenTerminal) return;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      onOpenTerminal();
    }, 500);
  };

  const cancelPress = () => {
    clearTimeout(longPressTimer.current);
  };

  const handleClick = () => {
    if (didLongPress.current) return;
    onToggle();
  };

  return (
    <div
      onClick={handleClick}
      onMouseDown={startPress}
      onMouseUp={cancelPress}
      onMouseLeave={(e) => { cancelPress(); if (!expanded) e.currentTarget.style.borderColor = C.border; e.currentTarget.style.backgroundColor = C.surface; }}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchCancel={cancelPress}
      style={{
        backgroundColor: C.surface, border: `1px solid ${expanded ? s.color + "40" : C.border}`,
        borderRadius: 8, padding: isAgent ? "12px 16px" : 16, cursor: "pointer", transition: "all 0.2s ease",
        position: "relative", overflow: "visible",
        marginLeft: isAgent ? 28 : 0,
        userSelect: "none", WebkitUserSelect: "none",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = s.color + "60"; e.currentTarget.style.backgroundColor = C.surfaceHover; }}
    >
      {isAgent && (
        <div style={{ position: "absolute", left: -14, top: 0, bottom: 0, width: 2, backgroundColor: C.border }} />
      )}
      {isAgent && (
        <div style={{ position: "absolute", left: -14, top: "50%", width: 12, height: 2, backgroundColor: C.border }} />
      )}

      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, backgroundColor: s.color, opacity: session.status === "active" ? 0.8 : 0.3, borderRadius: "8px 8px 0 0" }} />

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
          {session.tool === "codex" && (
            <Badge color="#10b981" bg="#10b98118">codex</Badge>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {onAction && (
            <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
              {(session.status === "idle" || session.status === "completed" || session.status === "error") && (
                <ActionButton label="▶" title="Resume session" color={C.green}
                  onClick={() => onAction(session.sessionId, session.host, "resume")} />
              )}
              <ActionButton label="⑂" title="Fork session" color={C.purple}
                onClick={() => onAction(session.sessionId, session.host, "fork")} />
              {(session.status === "active" || session.status === "idle" || session.status === "stuck") && (
                <ActionButton label="✕" title="Close session" color={C.red}
                  onClick={() => {
                    if (window.confirm(`Close session ${session.sessionId?.slice(0, 8)}?`)) {
                      onAction(session.sessionId, session.host, "close");
                    }
                  }} />
              )}
            </div>
          )}
          {onOpenTerminal && (
            <button onClick={(e) => { e.stopPropagation(); onOpenTerminal(); }} title="Open WebSSH terminal"
              style={{ background: "#58a6ff18", border: "1px solid #58a6ff55", borderRadius: 4, color: "#58a6ff", cursor: "pointer", padding: "2px 8px", fontSize: 11, fontFamily: "monospace", fontWeight: 600 }}>
              SSH
            </button>
          )}
          <Badge color={s.color} bg={s.bg}>{s.label}</Badge>
          <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>{session.host}</span>
        </div>
      </div>

      <div style={{
        fontSize: 12, color: session.status === "error" ? C.red : C.textMuted, marginBottom: 12,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {session.lastAssistantMessage || session.summary || "—"}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 11, color: C.textMuted, fontFamily: "monospace", flexWrap: "wrap", marginBottom: 8 }}>
        <span title="Messages">💬 {session.messages || 0}</span>
        <span title="Tool calls">🔧 {session.toolCalls || 0}</span>
        {elapsed > 0 && <span title="Duration">⏱ {formatDuration(elapsed)}</span>}
        <span title="Last active">↻ {timeAgo(session.lastTimestamp)}</span>
        {session.model && <span style={{ color: C.textDim }}>{session.model.replace("claude-", "").replace(/-\d{8}$/, "")}</span>}
        {cost > 0 && <span title="Estimated cost" style={{ color: C.amber }}>~{formatCost(cost)}</span>}
        {ctxPct != null && <span title="Context window usage" style={{ color: ctxCol }}>ctx {ctxPct.toFixed(0)}%</span>}
        {session.tmux && (
          <Badge color={C.accent} bg={C.accentDim} title={`tmux: ${session.tmux.session}:${session.tmux.window}.${session.tmux.pane}`}>
            tmux:{session.tmux.session}:{session.tmux.window}
            {session.tmux.attached && " *"}
          </Badge>
        )}
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onOpenTerminal(); }}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "6px 0", borderRadius: 6,
          border: "1px solid #58a6ff55", background: "#58a6ff12",
          color: "#58a6ff", cursor: "pointer",
          fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
        }}
      >⌨ WebSSH</button>

      {expanded && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}`, animation: "fadeIn 0.2s ease" }}>
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
                  <div style={{ fontSize: 10, color: C.purple, marginBottom: 4, fontFamily: "monospace" }}>{session.tool === "codex" ? "Codex" : "Claude"}</div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.5, wordBreak: "break-word" }}>{session.lastAssistantMessage}</div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
            <DetailCell label="Model" value={session.model ? session.model.replace("claude-", "").replace(/-\d{8}$/, "") : "—"} />
            <DetailCell label="Git Branch" value={session.branch || "—"} />
            <DetailCell label="Version" value={session.version || "—"} />
            <DetailCell label="Working Directory" value={session.project?.path || "—"} full />
            <DetailCell label="Session Started" value={session.firstTimestamp ? new Date(session.firstTimestamp).toLocaleString() : "—"} />
            <DetailCell label="Duration" value={elapsed > 0 ? formatDuration(elapsed) : "—"} />
          </div>

          <div style={{ display: "flex", gap: 16, marginBottom: 14, padding: "10px 12px", borderRadius: 6, backgroundColor: C.bg }}>
            <StatItem label="User Msgs" value={session.userMessages || 0} color={C.accent} />
            <StatItem label="Assistant Msgs" value={session.assistantMessages || 0} color={C.purple} />
            <StatItem label="Tool Calls" value={session.toolCalls || 0} color={C.amber} />
            <StatItem label="Total Lines" value={session.messages || 0} color={C.textMuted} />
            <StatItem label="File Size" value={session.fileSize ? (session.fileSize / 1024 / 1024).toFixed(1) + " MB" : "—"} color={C.textMuted} />
            <StatItem label="Est. Cost" value={formatCost(cost)} color={C.amber} />
          </div>

          {session.tokens && (session.tokens.input > 0 || session.tokens.output > 0 || session.tokens.cacheRead > 0) && (
            <div style={{ marginBottom: 14 }}>
              <TokenBar input={session.tokens.input} output={session.tokens.output} cacheRead={session.tokens.cacheRead} />
            </div>
          )}

          {session.tokens?.lastInput > 0 && (
            <div style={{ marginBottom: 14 }}>
              <ContextBar lastInput={session.tokens.lastInput} model={session.model} />
            </div>
          )}

          <div style={{ display: "flex", gap: 8, fontSize: 11, color: C.textDim, fontFamily: "monospace", marginBottom: 8 }}>
            <span>ID: {session.sessionId || "—"}</span>
          </div>
          <CopyCommand text={`ssh -t ${session.host} 'tmux attach -t ${session.project?.name || "session"}'`} />
          {onOpenTerminal && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenTerminal(); }}
              style={{
                marginTop: 8,
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 14px", borderRadius: 6,
                border: "1px solid #58a6ff55", background: "#58a6ff18",
                color: "#58a6ff", cursor: "pointer",
                fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
              }}
            >
              ⌨ WebSSH
            </button>
          )}
        </div>
      )}
    </div>
  );
}
