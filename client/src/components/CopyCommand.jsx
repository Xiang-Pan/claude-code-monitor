import { useState, useCallback } from "react";
import { C } from "./theme.js";

export function CopyCommand({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <div
      onClick={handleCopy}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 10px", borderRadius: 4,
        backgroundColor: C.accentDim, border: `1px solid ${C.accent}20`,
        fontSize: 11, color: C.accent, fontFamily: "monospace",
        cursor: "pointer", userSelect: "all",
      }}
      title="Click to copy"
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
      <span style={{
        flexShrink: 0, marginLeft: 8, fontSize: 10, padding: "2px 6px",
        borderRadius: 3, backgroundColor: copied ? C.greenDim : `${C.accent}15`,
        color: copied ? C.green : C.accent, transition: "all 0.2s",
      }}>
        {copied ? "Copied!" : "Copy"}
      </span>
    </div>
  );
}
