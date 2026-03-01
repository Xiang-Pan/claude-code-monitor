import { C, STATUS_MAP } from "./theme.js";
import { formatDuration, timeAgo, estimateCost, formatCost } from "./helpers.js";
import { StatusDot } from "./StatusDot.jsx";
import { Badge } from "./Badge.jsx";
import { TokenBar } from "./TokenBar.jsx";
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

export function SessionCard({ session, expanded, onToggle, isAgent }) {
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
      {isAgent && (
        <div style={{ position: "absolute", left: -14, top: 0, bottom: 0, width: 2, backgroundColor: C.border }} />
      )}
      {isAgent && (
        <div style={{ position: "absolute", left: -14, top: "50%", width: 12, height: 2, backgroundColor: C.border }} />
      )}

      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, backgroundColor: s.color, opacity: session.status === "active" ? 0.8 : 0.3 }} />

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

      <div style={{
        fontSize: 12, color: session.status === "error" ? C.red : C.textMuted, marginBottom: 12,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {session.lastAssistantMessage || session.summary || "—"}
      </div>

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
                  <div style={{ fontSize: 10, color: C.purple, marginBottom: 4, fontFamily: "monospace" }}>Claude</div>
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

          <div style={{ display: "flex", gap: 8, fontSize: 11, color: C.textDim, fontFamily: "monospace", marginBottom: 8 }}>
            <span>ID: {session.sessionId || "—"}</span>
          </div>
          <CopyCommand text={`ssh -t ${session.host} 'tmux attach -t ${session.project?.name || "session"}'`} />
        </div>
      )}
    </div>
  );
}
