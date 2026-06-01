import { useState, useEffect, useRef, useCallback } from "react";
import { C } from "./theme.js";

export function SearchPanel({ onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [took, setTook] = useState(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(async (q) => {
    if (q.length < 2) {
      setResults(null);
      setError(null);
      setTook(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=50`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResults(data.results || []);
      setTook(data.took);
    } catch (err) {
      setError(err.message);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    setExpandedIdx(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val.trim()), 300);
  };

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div style={{
      backgroundColor: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
      animation: "fadeIn 0.2s ease",
    }}>
      {/* Search input */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          placeholder="Search across all transcripts (ripgrep)..."
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            backgroundColor: C.bg,
            color: C.text,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            outline: "none",
          }}
        />
        {loading && (
          <span style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>searching...</span>
        )}
        <button
          onClick={onClose}
          style={{
            padding: "4px 8px", borderRadius: 4, border: `1px solid ${C.border}`,
            backgroundColor: "transparent", color: C.textMuted, fontSize: 11,
            fontFamily: "monospace", cursor: "pointer",
          }}
        >ESC</button>
      </div>

      {/* Status line */}
      {took != null && results && (
        <div style={{ fontSize: 10, color: C.textDim, fontFamily: "monospace", marginBottom: 8 }}>
          {results.length} session{results.length !== 1 ? "s" : ""} matched in {took}ms
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          padding: "8px 12px", borderRadius: 6, backgroundColor: C.redDim,
          border: `1px solid ${C.red}20`, color: C.red,
          fontSize: 12, fontFamily: "monospace", marginBottom: 8,
        }}>
          {error}
        </div>
      )}

      {/* No results */}
      {results && results.length === 0 && !loading && (
        <div style={{
          textAlign: "center", padding: 24, color: C.textDim,
          fontFamily: "monospace", fontSize: 12,
        }}>
          No matches found for "{query}"
        </div>
      )}

      {/* Results */}
      {results && results.length > 0 && (
        <div style={{ maxHeight: 400, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {results.map((result, idx) => {
            const isExpanded = expandedIdx === idx;
            return (
              <div key={`${result.sessionId}-${idx}`}>
                {/* Session header */}
                <div
                  onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 12px", borderRadius: 6,
                    backgroundColor: isExpanded ? C.surfaceHover : C.bg,
                    border: `1px solid ${isExpanded ? C.accent + "30" : C.border}`,
                    cursor: "pointer", transition: "all 0.15s",
                    fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                  }}
                  onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = C.surfaceHover; }}
                  onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = C.bg; }}
                >
                  <span style={{
                    fontSize: 10, color: C.textMuted, transition: "transform 0.15s",
                    transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                  }}>
                    ▶
                  </span>
                  <span style={{ color: C.text, fontWeight: 600 }}>
                    {result.project}
                  </span>
                  {result.host && (
                    <span style={{ color: C.textDim, fontSize: 11 }}>
                      @{result.host}
                    </span>
                  )}
                  <span style={{
                    marginLeft: "auto", fontSize: 10,
                    padding: "1px 6px", borderRadius: 8,
                    backgroundColor: C.accentDim, color: C.accent,
                  }}>
                    {result.matchCount} match{result.matchCount !== 1 ? "es" : ""}
                  </span>
                  <span style={{ fontSize: 10, color: C.textDim }}>
                    {result.sessionId?.slice(0, 8)}
                  </span>
                </div>

                {/* Expanded matches */}
                {isExpanded && (
                  <div style={{
                    marginTop: 4, marginLeft: 16, display: "flex", flexDirection: "column", gap: 4,
                    animation: "fadeIn 0.15s ease",
                  }}>
                    {result.matches.map((match, midx) => (
                      <div key={midx} style={{
                        padding: "8px 12px", borderRadius: 6,
                        backgroundColor: C.bg,
                        borderLeft: `2px solid ${match.context === "user" ? C.accent : match.context === "assistant" ? C.purple : C.textDim}`,
                      }}>
                        <div style={{
                          fontSize: 10, marginBottom: 4, fontFamily: "monospace",
                          color: match.context === "user" ? C.accent : match.context === "assistant" ? C.purple : C.textDim,
                        }}>
                          {match.context === "user" ? "User" : match.context === "assistant" ? "Assistant" : match.context}
                          {match.timestamp && (
                            <span style={{ color: C.textDim, marginLeft: 8 }}>
                              {new Date(match.timestamp).toLocaleString()}
                            </span>
                          )}
                        </div>
                        <div style={{
                          fontSize: 12, color: C.text, fontFamily: "'JetBrains Mono', monospace",
                          lineHeight: 1.5, wordBreak: "break-word", whiteSpace: "pre-wrap",
                        }}>
                          <HighlightedText text={match.text} query={query} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Highlight query matches in text.
 */
function HighlightedText({ text, query }) {
  if (!query || query.length < 2) return text;

  const parts = [];
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  let lastIdx = 0;

  let searchIdx = 0;
  while (searchIdx < lower.length) {
    const idx = lower.indexOf(qLower, searchIdx);
    if (idx === -1) break;

    if (idx > lastIdx) {
      parts.push(<span key={`t-${lastIdx}`}>{text.slice(lastIdx, idx)}</span>);
    }
    parts.push(
      <span key={`h-${idx}`} style={{
        backgroundColor: C.accent + "30",
        color: C.accent,
        borderRadius: 2,
        padding: "0 1px",
      }}>
        {text.slice(idx, idx + query.length)}
      </span>
    );
    lastIdx = idx + query.length;
    searchIdx = lastIdx;
  }

  if (lastIdx < text.length) {
    parts.push(<span key={`t-${lastIdx}`}>{text.slice(lastIdx)}</span>);
  }

  return parts.length > 0 ? <>{parts}</> : text;
}
