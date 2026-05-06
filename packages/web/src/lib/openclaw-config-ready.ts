// Use globalThis so the flag is visible to both server.ts (loaded by tsx) and
// Next.js API route handlers (bundled by webpack into a separate module scope).
// A plain module-level `let` is NOT shared between the two module systems.
const READY_KEY = "__pinchyOpenClawConfigReady";

export function markOpenClawConfigReady(): void {
  (globalThis as Record<string, unknown>)[READY_KEY] = true;
}

export function isOpenClawConfigReady(): boolean {
  return !!(globalThis as Record<string, unknown>)[READY_KEY];
}
