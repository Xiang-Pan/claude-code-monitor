/**
 * Aggregates session data from multiple hosts into a unified state
 * that the dashboard consumes.
 */
export class Aggregator {
  constructor() {
    // Map<hostName, hostData>
    this.hosts = new Map();
    // Map<hostName, tmuxData>
    this.tmux = new Map();
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
   * Update tmux data for a specific host.
   */
  updateTmux(tmuxData) {
    this.tmux.set(tmuxData.host, tmuxData);
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

    // Sort: active first, then stuck, idle, error, completed
    const statusOrder = { active: 0, stuck: 1, idle: 2, error: 3, completed: 4 };
    allSessions.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
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

    // Aggregate tmux data from all hosts
    const tmuxHosts = [];
    for (const [name, data] of this.tmux) {
      tmuxHosts.push({
        host: name,
        status: data.status,
        method: data.method || null,
        sessions: data.sessions || [],
        collectedAt: data.collectedAt,
      });
    }

    // ── Link tmux panes ↔ Claude sessions by host + cwd ─────
    // Build a lookup: "host:cwd" → [claude sessions]
    const cwdIndex = new Map();
    for (const s of allSessions) {
      const cwd = s.cwd || s.project?.path;
      if (!cwd) continue;
      const key = `${s.host}:${cwd}`;
      if (!cwdIndex.has(key)) cwdIndex.set(key, []);
      cwdIndex.get(key).push(s);
    }

    // Walk every tmux pane — attach linked Claude session info,
    // and attach tmux pane info back onto the Claude session.
    for (const th of tmuxHosts) {
      for (const sess of th.sessions) {
        for (const win of sess.windows || []) {
          for (const pane of win.panes || []) {
            if (!pane.cwd) continue;
            const key = `${th.host}:${pane.cwd}`;
            const linked = cwdIndex.get(key);
            if (!linked || linked.length === 0) continue;
            // Annotate pane → Claude
            pane.claudeSessions = linked.map((s) => ({
              sessionId: s.sessionId,
              status: s.status,
              project: s.project?.name,
            }));
            // Annotate Claude → tmux (pick first active/idle match)
            for (const s of linked) {
              if (!s.tmux) {
                s.tmux = {
                  session: sess.name,
                  window: win.name,
                  pane: pane.paneId,
                  attached: sess.attached,
                };
              }
            }
          }
        }
      }
    }

    return {
      sessions: allSessions,
      aggregate,
      tmux: tmuxHosts,
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
