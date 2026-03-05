import { C } from "./theme.js";
import { formatTokens, contextPercent, contextColor, getContextWindowMax } from "./helpers.js";

export function ContextBar({ lastInput, model }) {
  const pct = contextPercent(lastInput, model);
  if (pct == null) return null;

  const max = getContextWindowMax(model);
  const color = contextColor(pct);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>
        <span style={{ color: C.textDim }}>Context Window</span>
        <span style={{ color }}>{pct.toFixed(0)}% ({formatTokens(lastInput)} / {formatTokens(max)})</span>
      </div>
      <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: C.border }}>
        <div style={{ width: `${pct}%`, backgroundColor: color, transition: "width 0.5s, background-color 0.3s" }} />
      </div>
    </div>
  );
}
