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
  // Anthropic
  "opus":   { input: 15, output: 75, cacheRead: 1.5 },
  "sonnet": { input: 3, output: 15, cacheRead: 0.3 },
  "haiku":  { input: 0.8, output: 4, cacheRead: 0.08 },
  // OpenAI
  "gpt-4o":    { input: 2.5, output: 10, cacheRead: 1.25 },
  "o3":        { input: 10, output: 40, cacheRead: 2.5 },
  "o4-mini":   { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "gpt-4.1":   { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025 },
};

export function getModelTier(model) {
  if (!model) return "sonnet";
  const m = model.toLowerCase();
  // Anthropic models
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  // OpenAI models — match exact pricing keys
  if (m.includes("o3")) return "o3";
  if (m.includes("o4-mini")) return "o4-mini";
  if (m.includes("gpt-4.1-nano")) return "gpt-4.1-nano";
  if (m.includes("gpt-4.1-mini")) return "gpt-4.1-mini";
  if (m.includes("gpt-4.1")) return "gpt-4.1";
  if (m.includes("gpt-4o")) return "gpt-4o";
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
