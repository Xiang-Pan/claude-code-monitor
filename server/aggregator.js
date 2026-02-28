/**
 * Aggregates session data from multiple hosts into a unified state
 * that the dashboard consumes.
 */
export class Aggregator {
  constructor() {
    // Map<hostName, hostData>
    this.hosts = new Map();
    this.listeners = new Set();
  }

  /**
   * Update data for a specific host.
   */
  update(hostData) {
    this.hosts.set(hostData.host, hostData);
    this.notify();
  }

  /**
   * Get the full aggregated state for the dashboard.
   */
  getState() {
    const allSessions = [];
    const hostStatuses = [];

    for (const [name, data] of this.hosts) {
      hostStatuses.push({
        name,
        status: data.status,
        error: data.error || null,
        sessionCount: data.sessions?.length || 0,
        collectedAt: data.collectedAt,
        statsCache: data.statsCache || null,
      });

      if (data.sessions) {
        for (const session of data.sessions) {
          allSessions.push({
            ...session,
            host: name,
          });
        }
      }
    }

    // Deduplicate sessions with the same sessionId across hosts
    // (can happen with shared filesystems like NFS/GPFS)
    // Keep the one from the host that reported it first (or pick one deterministically)
    {
      const seen = new Map();
      const deduped = [];
      for (const session of allSessions) {
        const existing = seen.get(session.sessionId);
        if (!existing) {
          seen.set(session.sessionId, session);
          deduped.push(session);
        }
        // If duplicate, keep the one with more recent lastTimestamp
        else if (session.lastTimestamp && (!existing.lastTimestamp ||
          new Date(session.lastTimestamp) > new Date(existing.lastTimestamp))) {
          const idx = deduped.indexOf(existing);
          deduped[idx] = session;
          seen.set(session.sessionId, session);
        }
      }
      allSessions.length = 0;
      allSessions.push(...deduped);
    }

    // Sort: active first, then idle, then completed, then error
    const statusOrder = { active: 0, idle: 1, error: 2, completed: 3 };
    allSessions.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
      if (orderDiff !== 0) return orderDiff;
      // Within same status, sort by most recently active
      const aTime = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
      const bTime = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
      return bTime - aTime;
    });

    // Compute aggregates
    const aggregate = {
      totalSessions: allSessions.length,
      active: allSessions.filter((s) => s.status === "active").length,
      idle: allSessions.filter((s) => s.status === "idle").length,
      completed: allSessions.filter((s) => s.status === "completed").length,
      errors: allSessions.filter((s) => s.status === "error").length,
      totalMessages: allSessions.reduce((a, s) => a + (s.messages || 0), 0),
      totalToolCalls: allSessions.reduce((a, s) => a + (s.toolCalls || 0), 0),
      totalTokens: {
        input: allSessions.reduce((a, s) => a + (s.tokens?.input || 0), 0),
        output: allSessions.reduce((a, s) => a + (s.tokens?.output || 0), 0),
        cacheRead: allSessions.reduce((a, s) => a + (s.tokens?.cacheRead || 0), 0),
      },
      hosts: hostStatuses,
    };

    return {
      sessions: allSessions,
      aggregate,
      updatedAt: Date.now(),
    };
  }

  /**
   * Subscribe to state changes.
   */
  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error("[aggregator] Listener error:", err);
      }
    }
  }
}
