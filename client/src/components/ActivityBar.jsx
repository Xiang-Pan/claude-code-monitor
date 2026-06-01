import { useState, useEffect } from "react";
import { C } from "./theme.js";

const SSH_STATUS_COLORS = {
  connected: C.green,
  connecting: C.amber,
  reconnecting: C.amber,
  disconnected: C.red,
};

function SshPoolPanel({ sshPool, sshHosts, onOpenTerminal }) {
  if (!sshPool || Object.keys(sshPool).length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 11, color: C.textDim, fontFamily: "'JetBrains Mono', monospace" }}>
        No SSH connections configured
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ padding: "4px 12px", fontSize: 9, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "monospace", marginBottom: 4 }}>
        SSH Connections
      </div>
      {Object.entries(sshPool).map(([name, info]) => {
        const color = SSH_STATUS_COLORS[info.status] || C.textDim;
        const hostInfo = sshHosts.find((h) => h.name === name);
        return (
          <div
            key={name}
            onClick={() => {
              if (!hostInfo) return;
              const isBroken = info.status === "disconnected" || info.status === "reconnecting";
              if (isBroken) {
                onOpenTerminal({ hostId: name, cmd: null, title: `fix: ${name}`, fix: true });
              } else {
                onOpenTerminal({ hostId: name, cmd: null, title: name });
              }
            }}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 12px", cursor: hostInfo ? "pointer" : "default",
              transition: "background 0.1s",
              borderLeft: `2px solid transparent`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.surfaceHover; e.currentTarget.style.borderLeftColor = color; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderLeftColor = "transparent"; }}
          >
            <span style={{
              position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 8, height: 8, flexShrink: 0,
            }}>
              {(info.status === "connecting" || info.status === "reconnecting") && (
                <span style={{
                  position: "absolute", width: 8, height: 8, borderRadius: "50%",
                  backgroundColor: color, opacity: 0.4,
                  animation: "pulse 1.5s ease-out infinite",
                }} />
              )}
              <span style={{
                width: 5, height: 5, borderRadius: "50%", backgroundColor: color,
                position: "relative", zIndex: 1,
              }} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {name}
              </div>
              <div style={{ fontSize: 9, fontFamily: "monospace", color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {info.status === "connected" && info.connectedAt
                  ? `up ${formatDuration(Date.now() - info.connectedAt)}`
                  : info.error
                    ? info.error.split("\n")[0].slice(0, 40)
                    : info.status}
              </div>
            </div>
            {(info.status === "disconnected" || info.status === "reconnecting") && hostInfo ? (
              <button
                title="Open terminal to fix connection manually"
                onClick={(e) => { e.stopPropagation(); onOpenTerminal({ hostId: name, cmd: null, title: `fix: ${name}`, fix: true }); }}
                style={{
                  padding: "2px 5px", borderRadius: 3, border: `1px solid ${C.red}40`,
                  backgroundColor: C.redDim, color: C.red, fontSize: 9, fontFamily: "monospace",
                  cursor: "pointer", flexShrink: 0, lineHeight: 1,
                }}
              >⌨ fix</button>
            ) : hostInfo ? (
              <span style={{ fontSize: 10, color: C.textDim, flexShrink: 0 }}>⌨</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

const PANELS = [
  { id: "ssh", icon: "⛁", label: "SSH Pool" },
];

export function ActivityBar({ sshPool, sshHosts, onOpenTerminal, isMobile }) {
  const [activePanel, setActivePanel] = useState(null);

  if (isMobile) return null;

  return (
    <div style={{ display: "flex", height: "100%", flexShrink: 0 }}>
      {/* Icon bar */}
      <div style={{
        width: 40, display: "flex", flexDirection: "column", alignItems: "center",
        paddingTop: 8, gap: 4,
        backgroundColor: C.bg, borderRight: `1px solid ${C.border}`,
      }}>
        {PANELS.map((p) => (
          <button
            key={p.id}
            title={p.label}
            onClick={() => setActivePanel(activePanel === p.id ? null : p.id)}
            style={{
              width: 32, height: 32, borderRadius: 6, border: "none",
              backgroundColor: activePanel === p.id ? C.accentDim : "transparent",
              color: activePanel === p.id ? C.accent : C.textMuted,
              fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.15s",
            }}
          >
            {p.icon}
          </button>
        ))}
      </div>

      {/* Side panel */}
      {activePanel && (
        <div style={{
          width: 220, backgroundColor: C.surface, borderRight: `1px solid ${C.border}`,
          overflowY: "auto", flexShrink: 0,
        }}>
          {activePanel === "ssh" && (
            <SshPoolPanel sshPool={sshPool} sshHosts={sshHosts} onOpenTerminal={onOpenTerminal} />
          )}
        </div>
      )}
    </div>
  );
}
