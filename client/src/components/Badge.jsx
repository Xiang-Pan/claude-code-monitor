export function Badge({ children, color, bg }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 500, letterSpacing: "0.02em", color, backgroundColor: bg, fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      {children}
    </span>
  );
}
