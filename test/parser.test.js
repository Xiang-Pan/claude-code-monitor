import { describe, it, expect } from "vitest";
import { decodeProjectPath, extractProjectName, inferStatus } from "../server/parser.js";
import { ACTIVE_THRESHOLD_MS, IDLE_THRESHOLD_MS } from "../server/constants.js";

describe("decodeProjectPath", () => {
  it("decodes leading dash as root /", () => {
    expect(decodeProjectPath("-home-user-project")).toBe("/home/user/project");
  });

  it("handles single segment", () => {
    expect(decodeProjectPath("-tmp")).toBe("/tmp");
  });

  it("handles deeply nested paths", () => {
    expect(decodeProjectPath("-home-user-projects-api-gateway")).toBe("/home/user/projects/api/gateway");
  });
});

describe("extractProjectName", () => {
  it("extracts the last segment", () => {
    expect(extractProjectName("-home-user-projects-api-gateway")).toBe("gateway");
  });

  it("handles single segment", () => {
    expect(extractProjectName("-tmp")).toBe("tmp");
  });
});

describe("inferStatus", () => {
  it("returns error when session has error", () => {
    expect(inferStatus({ hasError: true, lastTimestamp: new Date().toISOString() })).toBe("error");
  });

  it("returns completed when session has summary", () => {
    expect(inferStatus({ hasSummary: true, lastTimestamp: new Date().toISOString() })).toBe("completed");
  });

  it("returns completed when no lastTimestamp", () => {
    expect(inferStatus({})).toBe("completed");
  });

  it("returns active when last message is recent", () => {
    const ts = new Date(Date.now() - ACTIVE_THRESHOLD_MS / 2).toISOString();
    expect(inferStatus({ lastTimestamp: ts })).toBe("active");
  });

  it("returns idle when last message is 1-10 min ago", () => {
    const ts = new Date(Date.now() - (ACTIVE_THRESHOLD_MS + IDLE_THRESHOLD_MS) / 2).toISOString();
    expect(inferStatus({ lastTimestamp: ts })).toBe("idle");
  });

  it("returns completed when last message is old", () => {
    const ts = new Date(Date.now() - IDLE_THRESHOLD_MS * 2).toISOString();
    expect(inferStatus({ lastTimestamp: ts })).toBe("completed");
  });
});
