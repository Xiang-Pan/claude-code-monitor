import { C } from "./theme.js";

const SSH_STATUS_COLORS = {
  connected: C.green,
  connecting: C.amber,
  reconnecting: C.amber,
  disconnected: C.red,
};

function SshIndicator({ ssh }) {
  if (!ssh) return null;
  const color = SSH_STATUS_COLORS[ssh.status] || C.textDim;
  const pulsing = ssh.status === "connecting" || ssh.status === "reconnecting";
  return (
    <span title={`SSH: ${ssh.status}${ssh.error ? ` — ${ssh.error}` : ""}${ssh.connectedAt ? `\nSince: ${new Date(ssh.connectedAt).toLocaleTimeString()}` : ""}`} style={{
      position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 8, height: 8,
    }}>
      {pulsing && <span style={{
        position: "absolute", width: 8, height: 8, borderRadius: "50%",
        backgroundColor: color, opacity: 0.4,
        animation: "pulse 1.5s ease-out infinite",
      }} />}
      <span style={{
        width: 5, height: 5, borderRadius: "50%", backgroundColor: color,
        position: "relative", zIndex: 1,
      }} />
    </span>
  );
}

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
          {h.ssh ? (
            <SshIndicator ssh={h.ssh} />
          ) : (
            <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: h.status === "connected" ? C.green : C.red }} />
          )}
          <span style={{ color: hostFilter === h.name ? C.accent : C.textMuted }}>{h.name}</span>
          <span style={{ fontSize: 9, padding: "0px 4px", borderRadius: 6, backgroundColor: hostFilter === h.name ? C.accent + "20" : C.border, color: C.textDim }}>{h.sessionCount}</span>
        </button>
      ))}
    </div>
  );
}
