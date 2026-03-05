import { C } from "./theme.js";
import { formatTokens, estimateCost, formatCost, contextPercent, contextColor } from "./helpers.js";

export function AggregateStats({ data, sessions, onFilterClick, activeFilter }) {
  const agg = data?.aggregate;
  if (!agg) return null;

  const totalCost = (sessions || []).reduce((sum, s) => sum + estimateCost(s.model, s.tokens), 0);

  // Average context % across active/idle sessions
  const liveSessions = (sessions || []).filter(s => s.status === "active" || s.status === "idle");
  const ctxValues = liveSessions.map(s => contextPercent(s.tokens?.lastInput, s.model)).filter(v => v != null);
  const avgCtx = ctxValues.length > 0 ? ctxValues.reduce((a, b) => a + b, 0) / ctxValues.length : null;

  const stats = [
    { label: "Active", value: agg.active, color: C.green, filterKey: "active" },
    { label: "Idle", value: agg.idle, color: C.amber, filterKey: "idle" },
    { label: "Errors", value: agg.errors, color: C.red, filterKey: "error" },
    { label: "Hosts", value: agg.hosts?.length || 0, color: C.accent },
    { label: "Messages", value: agg.totalMessages, color: C.text },
    { label: "Tool Calls", value: agg.totalToolCalls, color: C.purple },
    { label: "Input Tokens", value: formatTokens(agg.totalTokens?.input), color: C.accent },
    { label: "Output Tokens", value: formatTokens(agg.totalTokens?.output), color: C.purple },
    { label: "Cache Read", value: formatTokens(agg.totalTokens?.cacheRead), color: C.textMuted },
    { label: "Est. Cost", value: formatCost(totalCost), color: C.amber },
    { label: "Avg Context", value: avgCtx != null ? `${avgCtx.toFixed(0)}%` : "—", color: contextColor(avgCtx) },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 1, backgroundColor: C.border, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.border}` }}>
      {stats.map((s, i) => {
        const isClickable = !!s.filterKey && onFilterClick;
        const isActive = isClickable && activeFilter === s.filterKey;
        return (
          <div
            key={i}
            onClick={isClickable ? () => onFilterClick(activeFilter === s.filterKey ? "all" : s.filterKey) : undefined}
            style={{
              backgroundColor: C.surface,
              padding: "12px 14px",
              display: "flex", flexDirection: "column", gap: 2,
              cursor: isClickable ? "pointer" : "default",
              borderBottom: isActive ? `2px solid ${s.color}` : "2px solid transparent",
              transition: "border-color 0.15s",
            }}
          >
            <span style={{ fontSize: 10, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</span>
          </div>
        );
      })}
    </div>
  );
}
