import { C } from "./theme.js";
import { formatTokens, estimateCost, formatCost } from "./helpers.js";

export function AggregateStats({ data, sessions }) {
  const agg = data?.aggregate;
  if (!agg) return null;

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
