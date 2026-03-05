import { C } from "./theme.js";
import { formatTokens, timeAgo, estimateCost, formatCost, contextPercent, contextColor } from "./helpers.js";
import { StatusDot } from "./StatusDot.jsx";
import { Badge } from "./Badge.jsx";

export function SessionTable({ sessions, expandedId, setExpandedId }) {
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
            <th style={thStyle}>Context</th>
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
            const ctxPct = contextPercent(session.tokens?.lastInput, session.model);
            const ctxCol = contextColor(ctxPct);
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
                <td style={{ ...tdStyle, color: ctxCol }}>{ctxPct != null ? `${ctxPct.toFixed(0)}%` : "—"}</td>
                <td style={{ ...tdStyle, color: C.amber }}>{formatCost(cost)}</td>
                <td style={{ ...tdStyle, color: C.textMuted }}>{timeAgo(session.lastTimestamp)}</td>
                <td style={{ ...tdStyle, color: C.textDim, fontSize: 11 }}>{session.model ? session.model.replace("claude-", "").replace(/-\d{8}$/, "") : "—"}</td>
              </tr>,
              ...agents.map(agent => {
                const auid = `${agent.sessionId}:${agent.host}`;
                const agentCost = estimateCost(agent.model, agent.tokens);
                const agentTokens = (agent.tokens?.input || 0) + (agent.tokens?.output || 0) + (agent.tokens?.cacheRead || 0);
                const agentCtxPct = contextPercent(agent.tokens?.lastInput, agent.model);
                const agentCtxCol = contextColor(agentCtxPct);
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
                    <td style={{ ...tdStyle, color: agentCtxCol }}>{agentCtxPct != null ? `${agentCtxPct.toFixed(0)}%` : "—"}</td>
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
