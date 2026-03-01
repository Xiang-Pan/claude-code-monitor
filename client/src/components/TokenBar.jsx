import { C } from "./theme.js";
import { formatTokens } from "./helpers.js";

export function TokenBar({ input, output, cacheRead }) {
  const total = (input || 0) + (output || 0) + (cacheRead || 0);
  if (total === 0) return null;
  const pI = ((input || 0) / total) * 100;
  const pO = ((output || 0) / total) * 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: C.border }}>
        <div style={{ width: `${pI}%`, backgroundColor: C.accent, transition: "width 0.5s" }} />
        <div style={{ width: `${pO}%`, backgroundColor: C.purple, transition: "width 0.5s" }} />
        <div style={{ flex: 1, backgroundColor: "rgba(107,114,128,0.2)" }} />
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 10, color: C.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
        <span><span style={{ color: C.accent }}>●</span> In: {formatTokens(input)}</span>
        <span><span style={{ color: C.purple }}>●</span> Out: {formatTokens(output)}</span>
        <span><span style={{ color: C.textDim }}>●</span> Cache: {formatTokens(cacheRead)}</span>
      </div>
    </div>
  );
}
