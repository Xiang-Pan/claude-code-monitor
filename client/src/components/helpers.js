export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 5000) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

const MODEL_PRICING = {
  "opus":   { input: 15, output: 75, cacheRead: 1.5 },
  "sonnet": { input: 3, output: 15, cacheRead: 0.3 },
  "haiku":  { input: 0.8, output: 4, cacheRead: 0.08 },
};

export function getModelTier(model) {
  if (!model) return "sonnet";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

export function estimateCost(model, tokens) {
  if (!tokens) return 0;
  const tier = getModelTier(model);
  const pricing = MODEL_PRICING[tier];
  const inputCost = ((tokens.input || 0) / 1_000_000) * pricing.input;
  const outputCost = ((tokens.output || 0) / 1_000_000) * pricing.output;
  const cacheCost = ((tokens.cacheRead || 0) / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheCost;
}

export function formatCost(cost) {
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

export function groupSessions(sessions) {
  const mainSessions = [];
  const agentMap = new Map();

  for (const s of sessions) {
    if (s.isAgent && s.parentSessionId) {
      const key = s.parentSessionId;
      if (!agentMap.has(key)) agentMap.set(key, []);
      agentMap.get(key).push(s);
    } else {
      mainSessions.push(s);
    }
  }

  const grouped = [];
  for (const main of mainSessions) {
    const agents = agentMap.get(main.sessionId) || [];
    agentMap.delete(main.sessionId);
    grouped.push({ ...main, _agents: agents });
  }

  for (const [, agents] of agentMap) {
    for (const a of agents) {
      grouped.push({ ...a, _agents: [] });
    }
  }

  return grouped;
}
