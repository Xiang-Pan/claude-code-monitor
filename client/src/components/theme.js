export const C = {
  bg: "#0a0c10",
  surface: "#12151c",
  surfaceHover: "#181c26",
  border: "#1e2330",
  borderAccent: "#2a3040",
  text: "#c8cdd8",
  textMuted: "#6b7280",
  textDim: "#3d4452",
  accent: "#22d3ee",
  accentDim: "rgba(34,211,238,0.08)",
  green: "#34d399",
  greenDim: "rgba(52,211,153,0.10)",
  amber: "#fbbf24",
  amberDim: "rgba(251,191,36,0.10)",
  red: "#f87171",
  redDim: "rgba(248,113,113,0.10)",
  purple: "#a78bfa",
  purpleDim: "rgba(167,139,250,0.10)",
};

export const STATUS_MAP = {
  active: { label: "Active", color: C.green, bg: C.greenDim, pulse: true },
  idle: { label: "Idle", color: C.amber, bg: C.amberDim, pulse: false },
  completed: { label: "Done", color: C.textMuted, bg: "rgba(107,114,128,0.08)", pulse: false },
  error: { label: "Error", color: C.red, bg: C.redDim, pulse: false },
};
