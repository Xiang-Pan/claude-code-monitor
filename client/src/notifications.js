// ─── Notification helpers (extracted for testability) ─────

const HOURGLASS_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⏳</text></svg>";
const ERROR_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔴</text></svg>";
const DONE_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>✅</text></svg>";
const WARNING_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚠️</text></svg>";

/**
 * Determine the notification to fire for a status transition.
 * Returns { title, body, icon } or null if no notification should fire.
 */
export function getStatusNotification(session, oldStatus) {
  const { status, project, sessionId, host } = session;
  if (oldStatus === status) return null;

  const name = project?.name || sessionId?.slice(0, 8);

  if (status === "error" && oldStatus === "active") {
    return { type: "error", title: "Session Error", body: `${name} on ${host} hit an error`, icon: ERROR_ICON };
  }
  if (status === "completed" && (oldStatus === "active" || oldStatus === "idle")) {
    return { type: "completed", title: "Session Completed", body: `${name} on ${host} finished`, icon: DONE_ICON };
  }
  if (status === "idle" && oldStatus === "active") {
    return { type: "idle", title: "Waiting for input", body: `${name} on ${host} may need attention`, icon: HOURGLASS_ICON };
  }
  if (status === "stuck") {
    const stuckMinutes = Math.round(300_000 / 60_000); // matches STUCK_THRESHOLD_MS
    return { type: "stuck", title: "Session may be stuck", body: `${name} on ${host} — no output for ${stuckMinutes}+ min`, icon: WARNING_ICON };
  }
  return null;
}

/**
 * Determine the notification to fire for a hook event.
 * Returns { title, body, tag, icon? } or null.
 */
export function getHookNotification(event) {
  const name = event.project || "Claude Code";
  const tag = `${event.event}:${event.timestamp}`;

  if (event.event === "Stop" && event.stopReason === "end_turn") {
    return { type: "hook_stop", title: "Waiting for input", body: `${name} finished — your turn`, tag, icon: HOURGLASS_ICON };
  }
  if (event.event === "Stop" || event.event === "PostToolUseFailure") {
    const detail = event.error ? ` — ${event.error}` : event.toolName ? ` (${event.toolName})` : "";
    return { type: "hook_error", title: `Hook: ${event.event}`, body: `${name}${detail}`, tag };
  }
  if (event.event === "Notification") {
    return { type: "hook_notify", title: "Claude Code", body: `${name} needs attention`, tag };
  }
  return null;
}
