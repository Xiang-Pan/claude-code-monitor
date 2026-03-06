import { useState, useRef, useCallback, useEffect } from "react";

const TIME_RANGE_CONFIG = {
  "1m": { duration: 60_000, bucketSize: 1_000, maxPoints: 60 },
  "3m": { duration: 180_000, bucketSize: 3_000, maxPoints: 60 },
  "5m": { duration: 300_000, bucketSize: 5_000, maxPoints: 60 },
  "10m": { duration: 600_000, bucketSize: 10_000, maxPoints: 60 },
};

export function useChartData() {
  const [timeRange, setTimeRange] = useState("1m");
  const dataPointsRef = useRef([]);
  const allEventsRef = useRef([]);
  const eventBufferRef = useRef([]);
  const debounceTimerRef = useRef(null);
  const cleanupIntervalRef = useRef(null);

  const getConfig = useCallback((range) => TIME_RANGE_CONFIG[range || "1m"], []);

  const getBucketTimestamp = useCallback(
    (timestamp, range) => {
      const config = getConfig(range);
      return Math.floor(timestamp / config.bucketSize) * config.bucketSize;
    },
    [getConfig]
  );

  const cleanOldData = useCallback(
    (range) => {
      const r = range || timeRange;
      const config = getConfig(r);
      const cutoff = Date.now() - config.duration;
      dataPointsRef.current = dataPointsRef.current.filter(
        (dp) => dp.timestamp >= cutoff
      );
      if (dataPointsRef.current.length > config.maxPoints) {
        dataPointsRef.current = dataPointsRef.current.slice(
          -config.maxPoints
        );
      }
    },
    [timeRange, getConfig]
  );

  const cleanOldEvents = useCallback(() => {
    const cutoff = Date.now() - 600_000; // keep 10 min max
    allEventsRef.current = allEventsRef.current.filter(
      (ev) => ev.timestamp && ev.timestamp >= cutoff
    );
  }, []);

  const processEventBuffer = useCallback(
    (range) => {
      const events = [...eventBufferRef.current];
      eventBufferRef.current = [];
      allEventsRef.current.push(...events);

      const r = range || timeRange;

      events.forEach((event) => {
        const ts = event.timestamp;
        if (!ts) return;

        const bucketTime = getBucketTimestamp(ts, r);
        let bucket = dataPointsRef.current.find(
          (dp) => dp.timestamp === bucketTime
        );

        const eventType = event.event || "unknown";
        const sessionId = event.sessionId || "unknown";
        const toolName = event.toolName || null;

        if (bucket) {
          bucket.count++;
          bucket.eventTypes[eventType] =
            (bucket.eventTypes[eventType] || 0) + 1;
          bucket.sessions[sessionId] =
            (bucket.sessions[sessionId] || 0) + 1;
          if (toolName) {
            const key = `${eventType}:${toolName}`;
            bucket.toolEvents[key] = (bucket.toolEvents[key] || 0) + 1;
          }
        } else {
          const toolEvents = {};
          if (toolName) {
            toolEvents[`${eventType}:${toolName}`] = 1;
          }
          dataPointsRef.current.push({
            timestamp: bucketTime,
            count: 1,
            eventTypes: { [eventType]: 1 },
            toolEvents,
            sessions: { [sessionId]: 1 },
          });
        }
      });

      cleanOldData(r);
      cleanOldEvents();
    },
    [timeRange, getBucketTimestamp, cleanOldData, cleanOldEvents]
  );

  const addEvent = useCallback(
    (event) => {
      eventBufferRef.current.push(event);
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        processEventBuffer();
        debounceTimerRef.current = null;
      }, 50);
    },
    [processEventBuffer]
  );

  const getChartData = useCallback(
    (range) => {
      const r = range || timeRange;
      const config = getConfig(r);
      const now = Date.now();
      const startTime = now - config.duration;

      const buckets = [];
      for (let time = startTime; time <= now; time += config.bucketSize) {
        const bucketTime = getBucketTimestamp(time, r);
        const existing = dataPointsRef.current.find(
          (dp) => dp.timestamp === bucketTime
        );
        buckets.push({
          timestamp: bucketTime,
          count: existing?.count || 0,
          eventTypes: existing?.eventTypes || {},
          toolEvents: existing?.toolEvents || {},
          sessions: existing?.sessions || {},
        });
      }
      return buckets.slice(-config.maxPoints);
    },
    [timeRange, getConfig, getBucketTimestamp]
  );

  const reaggregateData = useCallback(
    (newRange) => {
      dataPointsRef.current = [];
      const config = getConfig(newRange);
      const cutoff = Date.now() - config.duration;

      allEventsRef.current
        .filter((ev) => ev.timestamp && ev.timestamp >= cutoff)
        .forEach((event) => {
          const ts = event.timestamp;
          const bucketTime = getBucketTimestamp(ts, newRange);
          let bucket = dataPointsRef.current.find(
            (dp) => dp.timestamp === bucketTime
          );

          const eventType = event.event || "unknown";
          const sessionId = event.sessionId || "unknown";
          const toolName = event.toolName || null;

          if (bucket) {
            bucket.count++;
            bucket.eventTypes[eventType] =
              (bucket.eventTypes[eventType] || 0) + 1;
            bucket.sessions[sessionId] =
              (bucket.sessions[sessionId] || 0) + 1;
            if (toolName) {
              const key = `${eventType}:${toolName}`;
              bucket.toolEvents[key] = (bucket.toolEvents[key] || 0) + 1;
            }
          } else {
            const toolEvents = {};
            if (toolName) {
              toolEvents[`${eventType}:${toolName}`] = 1;
            }
            dataPointsRef.current.push({
              timestamp: bucketTime,
              count: 1,
              eventTypes: { [eventType]: 1 },
              toolEvents,
              sessions: { [sessionId]: 1 },
            });
          }
        });

      cleanOldData(newRange);
    },
    [getConfig, getBucketTimestamp, cleanOldData]
  );

  const changeTimeRange = useCallback(
    (newRange) => {
      // Flush any pending debounced processing with the new range
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        if (eventBufferRef.current.length > 0) {
          processEventBuffer(newRange);
        }
      }

      setTimeRange(newRange);
      reaggregateData(newRange);
    },
    [reaggregateData, processEventBuffer]
  );

  const clearData = useCallback(() => {
    dataPointsRef.current = [];
    allEventsRef.current = [];
    eventBufferRef.current = [];
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  // Stats
  const getStats = useCallback(
    (range) => {
      const r = range || timeRange;
      const config = getConfig(r);
      const cutoff = Date.now() - config.duration;

      const windowEvents = allEventsRef.current
        .filter((ev) => ev.timestamp && ev.timestamp >= cutoff)
        .sort((a, b) => a.timestamp - b.timestamp);

      const totalEvents = dataPointsRef.current.reduce(
        (s, dp) => s + dp.count,
        0
      );

      const sessions = new Set();
      const projects = new Set();
      windowEvents.forEach((ev) => {
        if (ev.sessionId) sessions.add(ev.sessionId);
        if (ev.project) projects.add(ev.project);
      });

      let avgGap = 0;
      if (windowEvents.length >= 2) {
        const gaps = [];
        for (let i = 1; i < windowEvents.length; i++) {
          const gap = windowEvents[i].timestamp - windowEvents[i - 1].timestamp;
          if (gap > 0) gaps.push(gap);
        }
        if (gaps.length > 0) {
          avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        }
      }

      return {
        totalEvents,
        sessionCount: sessions.size,
        projectCount: projects.size,
        avgGap,
      };
    },
    [timeRange, getConfig]
  );

  // Auto-cleanup
  useEffect(() => {
    cleanupIntervalRef.current = setInterval(() => {
      cleanOldData();
      cleanOldEvents();
    }, 1000);
    return () => {
      clearInterval(cleanupIntervalRef.current);
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [cleanOldData, cleanOldEvents]);

  return {
    timeRange,
    setTimeRange: changeTimeRange,
    addEvent,
    getChartData,
    clearData,
    getStats,
    dataPointsRef,
  };
}
