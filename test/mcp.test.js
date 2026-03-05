import { describe, it, expect, vi } from "vitest";
import { diffStatuses, filterByTime, resolveRelativeTime } from "../server/mcp.js";

describe("diffStatuses", () => {
  it("detects active → idle transition", () => {
    const prev = new Map([["s1", "active"]]);
    const current = [{ sessionId: "s1", status: "idle", host: "local", project: { name: "myapp" } }];

    const events = diffStatuses(prev, current);
    expect(events).toEqual([
      { sessionId: "s1", project: "myapp", host: "local", from: "active", to: "idle" },
    ]);
  });

  it("detects active → error transition", () => {
    const prev = new Map([["s1", "active"]]);
    const current = [{ sessionId: "s1", status: "error", host: "gpu", project: null }];

    const events = diffStatuses(prev, current);
    expect(events).toEqual([
      { sessionId: "s1", project: null, host: "gpu", from: "active", to: "error" },
    ]);
  });

  it("does not emit event for new sessions (no previous status)", () => {
    const prev = new Map();
    const current = [{ sessionId: "s1", status: "active", host: "local", project: { name: "proj" } }];

    const events = diffStatuses(prev, current);
    expect(events).toEqual([]);
  });

  it("does not emit event when status unchanged", () => {
    const prev = new Map([["s1", "active"]]);
    const current = [{ sessionId: "s1", status: "active", host: "local", project: { name: "proj" } }];

    const events = diffStatuses(prev, current);
    expect(events).toEqual([]);
  });

  it("handles multiple transitions at once", () => {
    const prev = new Map([
      ["s1", "active"],
      ["s2", "idle"],
      ["s3", "active"],
    ]);
    const current = [
      { sessionId: "s1", status: "idle", host: "a", project: { name: "p1" } },
      { sessionId: "s2", status: "idle", host: "b", project: { name: "p2" } },  // unchanged
      { sessionId: "s3", status: "completed", host: "c", project: null },
    ];

    const events = diffStatuses(prev, current);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sessionId: "s1", from: "active", to: "idle" });
    expect(events[1]).toMatchObject({ sessionId: "s3", from: "active", to: "completed" });
  });

  it("handles disappeared sessions gracefully (no crash)", () => {
    const prev = new Map([["s1", "active"], ["s2", "idle"]]);
    const current = [{ sessionId: "s1", status: "active", host: "local", project: null }];

    // s2 disappeared — no event emitted, no crash
    const events = diffStatuses(prev, current);
    expect(events).toEqual([]);
  });

  it("handles empty inputs", () => {
    expect(diffStatuses(new Map(), [])).toEqual([]);
  });
});

describe("resolveRelativeTime", () => {
  it("resolves 'today' to start of day", () => {
    const result = new Date(resolveRelativeTime("today"));
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it("resolves '1h' to ~1 hour ago", () => {
    const result = new Date(resolveRelativeTime("1h")).getTime();
    const expected = Date.now() - 3_600_000;
    expect(Math.abs(result - expected)).toBeLessThan(100);
  });

  it("resolves '30m' to ~30 minutes ago", () => {
    const result = new Date(resolveRelativeTime("30m")).getTime();
    const expected = Date.now() - 30 * 60_000;
    expect(Math.abs(result - expected)).toBeLessThan(100);
  });

  it("resolves '7d' to ~7 days ago", () => {
    const result = new Date(resolveRelativeTime("7d")).getTime();
    const expected = Date.now() - 7 * 86_400_000;
    expect(Math.abs(result - expected)).toBeLessThan(100);
  });

  it("passes through ISO strings unchanged", () => {
    const iso = "2025-01-15T10:00:00Z";
    expect(resolveRelativeTime(iso)).toBe(iso);
  });
});

describe("filterByTime", () => {
  const sessions = [
    { sessionId: "s1", firstTimestamp: "2025-03-01T08:00:00Z" },
    { sessionId: "s2", firstTimestamp: "2025-03-01T14:00:00Z" },
    { sessionId: "s3", firstTimestamp: "2025-02-28T12:00:00Z" },
    { sessionId: "s4", firstTimestamp: null },
  ];

  it("filters sessions created after a given time", () => {
    const result = filterByTime(sessions, "2025-03-01T10:00:00Z");
    expect(result.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("includes sessions exactly at the cutoff", () => {
    const result = filterByTime(sessions, "2025-03-01T08:00:00Z");
    expect(result.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("returns all sessions for very old cutoff", () => {
    const result = filterByTime(sessions, "2020-01-01T00:00:00Z");
    expect(result).toHaveLength(3); // s4 excluded (null timestamp → 0)
  });

  it("returns all sessions for invalid since value", () => {
    const result = filterByTime(sessions, "not-a-date");
    expect(result).toHaveLength(4);
  });

  it("handles empty sessions", () => {
    expect(filterByTime([], "2025-01-01")).toEqual([]);
  });
});
