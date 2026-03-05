import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useChartData } from "../hooks/useChartData.js";
import { ChartRenderer } from "./chartRenderer.js";
import { C } from "./theme.js";

// Color palette for sessions (hash-based assignment)
const SESSION_COLORS = [
  "#22d3ee", "#34d399", "#a78bfa", "#fbbf24", "#f87171",
  "#60a5fa", "#f472b6", "#4ade80", "#e879f9", "#fb923c",
];

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length];
}

const EVENT_ICONS = {
  Notification: "\u{1f514}",
  Stop: "\u2705",
  SessionStart: "\u{1f680}",
  SessionEnd: "\u{1f3c1}",
  PreToolUse: "\u{1f527}",
  PostToolUse: "\u2705",
  UserPromptSubmit: "\u{1f4dd}",
  SubagentStop: "\u{1f916}",
};

function formatGap(ms) {
  if (ms === 0) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const TIME_RANGES = ["1m", "3m", "5m", "10m"];

export function LivePulseChart({ hookEvents }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const animFrameRef = useRef(null);
  const processedKeysRef = useRef(new Set());
  const renderLoopRef = useRef(null);

  const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0, text: "" });
  const [stats, setStats] = useState({ totalEvents: 0, sessionCount: 0, projectCount: 0, avgGap: 0 });
  const [, forceUpdate] = useState(0);

  const {
    timeRange,
    setTimeRange,
    addEvent,
    getChartData,
    clearData,
    getStats,
    dataPointsRef,
  } = useChartData();

  const getSessionColor = useCallback((sessionId) => hashColor(sessionId || ""), []);

  const getDimensions = useCallback(() => {
    const width = containerRef.current?.offsetWidth || 800;
    return {
      width,
      height: 96,
      padding: { top: 7, right: 7, bottom: 20, left: 7 },
    };
  }, []);

  const render = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const data = getChartData();
    const maxValue = Math.max(...data.map((d) => d.count), 1);

    renderer.clear();
    renderer.drawBackground();
    renderer.drawAxes();
    renderer.drawTimeLabels(timeRange);
    renderer.drawBars(data, maxValue, getSessionColor);
  }, [getChartData, timeRange, getSessionColor]);

  // Init canvas renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dims = getDimensions();
    rendererRef.current = new ChartRenderer(canvas, dims, {
      maxDataPoints: 60,
      barWidth: 3,
      colors: {
        primary: C.accent,
        glow: C.accent,
        axis: C.border,
        text: C.textDim,
      },
    });

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!rendererRef.current) return;
      rendererRef.current.resize(getDimensions());
      render();
    });
    ro.observe(container);

    // Render loop at 30 FPS
    let lastTime = 0;
    const frameInterval = 1000 / 30;
    const loop = (now) => {
      if (now - lastTime >= frameInterval) {
        render();
        setStats(getStats());
        lastTime = now - ((now - lastTime) % frameInterval);
      }
      renderLoopRef.current = requestAnimationFrame(loop);
    };
    renderLoopRef.current = requestAnimationFrame(loop);

    return () => {
      ro.disconnect();
      if (renderLoopRef.current) cancelAnimationFrame(renderLoopRef.current);
    };
  }, [getDimensions, render, getStats]);

  // Process new hook events
  useEffect(() => {
    if (!hookEvents || hookEvents.length === 0) return;

    hookEvents.forEach((ev) => {
      const key = `${ev.event}:${ev.timestamp}:${ev.sessionId || ""}`;
      if (processedKeysRef.current.has(key)) return;
      processedKeysRef.current.add(key);
      addEvent(ev);
    });

    // Trim processed keys to avoid memory leak
    if (processedKeysRef.current.size > 500) {
      const keys = [...processedKeysRef.current];
      processedKeysRef.current = new Set(keys.slice(-300));
    }
  }, [hookEvents, addEvent]);

  // Mouse tooltip
  const handleMouseMove = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const data = getChartData();
      const dims = getDimensions();
      const area = {
        x: dims.padding.left,
        y: dims.padding.top,
        width: dims.width - dims.padding.left - dims.padding.right,
        height: dims.height - dims.padding.top - dims.padding.bottom,
      };

      const barWidth = area.width / data.length;
      const barIndex = Math.floor((x - area.x) / barWidth);

      if (barIndex >= 0 && barIndex < data.length && y >= area.y && y <= area.y + area.height) {
        const point = data[barIndex];
        if (point.count > 0) {
          const types = Object.entries(point.eventTypes || {})
            .map(([t, c]) => `${t}: ${c}`)
            .join(", ");
          setTooltip({
            visible: true,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top - 30,
            text: `${point.count} events${types ? ` (${types})` : ""}`,
          });
          return;
        }
      }
      setTooltip((prev) => ({ ...prev, visible: false }));
    },
    [getChartData, getDimensions]
  );

  const handleMouseLeave = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  }, []);

  const hasData = dataPointsRef.current.some((dp) => dp.count > 0);

  // Stat badge style
  const badgeStyle = {
    display: "flex", alignItems: "center", gap: 5,
    padding: "4px 8px", borderRadius: 6,
    backgroundColor: C.surface, border: `1px solid ${C.border}`,
    fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
  };

  const rangeBtn = (range) => ({
    padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer",
    fontSize: 11, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace",
    transition: "all 0.15s",
    backgroundColor: timeRange === range ? C.accent : C.surface,
    color: timeRange === range ? C.bg : C.textMuted,
    borderWidth: 1, borderStyle: "solid",
    borderColor: timeRange === range ? C.accent : C.border,
  });

  return (
    <div style={{
      marginTop: 16, marginBottom: 12, borderRadius: 8,
      backgroundColor: C.surface, border: `1px solid ${C.border}`,
      padding: "12px 14px", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.accent, fontFamily: "'JetBrains Mono', monospace" }}>
            Live Pulse
          </span>

          <div style={badgeStyle}>
            <span style={{ fontSize: 13 }}>{"\u26a1"}</span>
            <span style={{ fontWeight: 700, color: C.text }}>{stats.totalEvents}</span>
            <span style={{ color: C.textDim, fontSize: 10 }}>events</span>
          </div>

          <div style={badgeStyle}>
            <span style={{ fontSize: 13 }}>{"\ud83d\udcbb"}</span>
            <span style={{ fontWeight: 700, color: C.text }}>{stats.sessionCount}</span>
            <span style={{ color: C.textDim, fontSize: 10 }}>sessions</span>
          </div>

          <div style={badgeStyle}>
            <span style={{ fontSize: 13 }}>{"\ud83d\udcc1"}</span>
            <span style={{ fontWeight: 700, color: C.text }}>{stats.projectCount}</span>
            <span style={{ color: C.textDim, fontSize: 10 }}>projects</span>
          </div>

          <div style={badgeStyle}>
            <span style={{ fontSize: 13 }}>{"\ud83d\udd52"}</span>
            <span style={{ fontWeight: 700, color: C.text }}>{formatGap(stats.avgGap)}</span>
            <span style={{ color: C.textDim, fontSize: 10 }}>avg gap</span>
          </div>
        </div>

        {/* Time range selector */}
        <div style={{ display: "flex", gap: 4 }}>
          {TIME_RANGES.map((range) => (
            <button key={range} onClick={() => setTimeRange(range)} style={rangeBtn(range)}>
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Canvas chart */}
      <div ref={containerRef} style={{ position: "relative" }}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: 96, cursor: "crosshair", display: "block" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />

        {/* Tooltip */}
        {tooltip.visible && (
          <div style={{
            position: "absolute",
            left: tooltip.x, top: tooltip.y,
            backgroundColor: C.accent, color: C.bg,
            padding: "4px 8px", borderRadius: 6,
            fontSize: 11, fontWeight: 600,
            fontFamily: "'JetBrains Mono', monospace",
            pointerEvents: "none", zIndex: 10,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}>
            {tooltip.text}
          </div>
        )}

        {/* Empty state */}
        {!hasData && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ color: C.textDim, fontSize: 12, fontFamily: "monospace" }}>
              Waiting for hook events...
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
