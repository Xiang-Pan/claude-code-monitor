import { STATUS_MAP } from "./theme.js";

export function StatusDot({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.completed;
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 10, height: 10 }}>
      {s.pulse && <span style={{ position: "absolute", width: 10, height: 10, borderRadius: "50%", backgroundColor: s.color, opacity: 0.4, animation: "pulse 2s ease-in-out infinite" }} />}
      <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: s.color, position: "relative", zIndex: 1 }} />
    </span>
  );
}
