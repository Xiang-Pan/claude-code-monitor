import { describe, it, expect } from "vitest";
import { getStatusNotification, getHookNotification } from "../client/src/notifications.js";

// ─── Status transition notifications ─────────────────────

describe("getStatusNotification", () => {
  const session = (status, extra = {}) => ({
    sessionId: "abc12345-6789",
    host: "dev-server",
    status,
    project: { name: "my-app" },
    ...extra,
  });

  it("fires 'Waiting for input' on active → idle", () => {
    const n = getStatusNotification(session("idle"), "active");
    expect(n).not.toBeNull();
    expect(n.title).toBe("Waiting for input");
    expect(n.body).toContain("my-app");
    expect(n.body).toContain("may need attention");
    expect(n.icon).toContain("⏳");
  });

  it("fires 'Session Error' on active → error", () => {
    const n = getStatusNotification(session("error"), "active");
    expect(n.title).toBe("Session Error");
    expect(n.body).toContain("hit an error");
  });

  it("fires 'Session Completed' on active → completed", () => {
    const n = getStatusNotification(session("completed"), "active");
    expect(n.title).toBe("Session Completed");
    expect(n.body).toContain("finished");
  });

  it("fires 'Session Completed' on idle → completed", () => {
    const n = getStatusNotification(session("completed"), "idle");
    expect(n.title).toBe("Session Completed");
  });

  it("returns null when status unchanged", () => {
    expect(getStatusNotification(session("active"), "active")).toBeNull();
  });

  it("returns null for non-notifiable transitions", () => {
    expect(getStatusNotification(session("active"), "idle")).toBeNull();
    expect(getStatusNotification(session("idle"), "error")).toBeNull();
    expect(getStatusNotification(session("active"), "completed")).toBeNull();
  });

  it("falls back to sessionId slice when no project name", () => {
    const n = getStatusNotification(session("idle", { project: null }), "active");
    expect(n.body).toContain("abc12345");
  });
});

// ─── Hook event notifications ────────────────────────────

describe("getHookNotification", () => {
  it("fires 'Waiting for input' for Stop with end_turn", () => {
    const n = getHookNotification({
      event: "Stop",
      stopReason: "end_turn",
      project: "api-gateway",
      timestamp: "2025-01-01T00:00:00Z",
    });
    expect(n.title).toBe("Waiting for input");
    expect(n.body).toBe("api-gateway finished — your turn");
    expect(n.icon).toContain("⏳");
    expect(n.tag).toBe("Stop:2025-01-01T00:00:00Z");
  });

  it("fires generic Hook notification for Stop without end_turn", () => {
    const n = getHookNotification({
      event: "Stop",
      stopReason: "max_tokens",
      project: "my-app",
      timestamp: "t1",
    });
    expect(n.title).toBe("Hook: Stop");
    expect(n.body).toBe("my-app");
  });

  it("includes error in Stop notification body", () => {
    const n = getHookNotification({
      event: "Stop",
      stopReason: "error",
      error: "rate limited",
      project: "my-app",
      timestamp: "t1",
    });
    expect(n.body).toContain("rate limited");
  });

  it("fires for PostToolUseFailure with toolName", () => {
    const n = getHookNotification({
      event: "PostToolUseFailure",
      toolName: "Bash",
      project: "my-app",
      timestamp: "t2",
    });
    expect(n.title).toBe("Hook: PostToolUseFailure");
    expect(n.body).toContain("(Bash)");
  });

  it("fires for Notification event", () => {
    const n = getHookNotification({
      event: "Notification",
      project: "my-app",
      timestamp: "t3",
    });
    expect(n.title).toBe("Claude Code");
    expect(n.body).toContain("needs attention");
  });

  it("falls back to 'Claude Code' when no project", () => {
    const n = getHookNotification({
      event: "Notification",
      timestamp: "t4",
    });
    expect(n.body).toContain("Claude Code");
  });

  it("returns null for unknown event types", () => {
    expect(getHookNotification({ event: "Unknown", timestamp: "t5" })).toBeNull();
  });
});
