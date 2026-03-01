import { C } from "./theme.js";

export function HostStatus({ hosts, hostFilter, onHostClick }) {
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
