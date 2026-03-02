import { describe, it, expect } from "vitest";
import { diffStatuses } from "../server/mcp.js";

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
