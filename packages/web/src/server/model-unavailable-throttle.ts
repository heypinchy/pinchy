const lastEmittedAt = new Map<string, number>();
const TTL_MS = 5 * 60 * 1000;

export function shouldEmitModelUnavailableAudit(
  agentId: string,
  model: string,
  now: number = Date.now()
): boolean {
  const key = `${agentId}:${model}`;
  const last = lastEmittedAt.get(key);
  if (last !== undefined && now - last < TTL_MS) return false;
  lastEmittedAt.set(key, now);
  return true;
}

export function __resetModelUnavailableThrottleForTests(): void {
  lastEmittedAt.clear();
}
