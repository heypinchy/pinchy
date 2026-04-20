const KEY = Symbol.for("pinchy.openClawConnected");
const g = globalThis as unknown as Record<symbol, { connected: boolean }>;
if (!g[KEY]) g[KEY] = { connected: false };
export const openClawConnectionState = g[KEY];
