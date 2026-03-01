import { useState, useEffect } from "react";
import { C } from "./theme.js";

export function CountdownTimer({ pollIntervalMs, lastUpdated, onRefresh }) {
  const [remaining, setRemaining] = useState(pollIntervalMs || 3000);

  useEffect(() => {
    if (!pollIntervalMs || !lastUpdated) return;
    const tick = () => {
      const elapsed = Date.now() - lastUpdated;
      const r = Math.max(0, pollIntervalMs - elapsed);
      setRemaining(r);
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [pollIntervalMs, lastUpdated]);

  if (!pollIntervalMs) return null;

  const secs = Math.ceil(remaining / 1000);
  const fraction = remaining / pollIntervalMs;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  return (
    <button
      onClick={onRefresh}
      title={`Next poll in ${secs}s — click to refresh now`}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        background: "none", border: `1px solid ${C.border}`, borderRadius: 6,
        padding: "4px 8px", cursor: "pointer", transition: "all 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.accent + "60"; e.currentTarget.style.backgroundColor = C.accentDim; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="10" cy="10" r={radius} fill="none" stroke={C.border} strokeWidth="2" />
        <circle cx="10" cy="10" r={radius} fill="none" stroke={C.accent} strokeWidth="2"
          strokeDasharray={circumference} strokeDashoffset={dashOffset}
          strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.2s" }} />
      </svg>
      <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>{secs}s</span>
    </button>
  );
}
