// A cache that every module instance in the process shares.
//
// One Pinchy process loads most of `src/lib` twice: once for the custom server
// (`node --import tsx server.ts`) and once for Next's route bundles — one pid,
// two module instances (measured, see `openclaw-config/push-state.ts`). A
// module-level cache gives each instance a private copy, so a reset through one
// never reaches the other.
//
// That matters wherever the two instances meet in one code path. Config
// regenerates are serialized process-wide (`openclaw-config/regenerate-queue.ts`),
// and a coalesced rerun is started by whichever instance's run just settled — so
// it reads THAT instance's caches. Model self-heal resets the model caches in
// the server instance; a provider save resets them in a route. With private
// caches, a rerun through the other instance regenerated from the list the
// reset was meant to discard, and self-heal re-pinned the retired model.
//
// Hence: caches a regenerate reads live on globalThis, one key per cache.

/**
 * The process-wide value stored under `key`, created on first use.
 *
 * globalThis outlives a module reload (dev HMR), so the value found there may
 * have been written by a previous version of the calling module. `isCurrent`
 * says whether it still has the shape this version expects; if not, it is
 * replaced by a fresh one. That is safe for a cache — dropping one only costs a
 * refetch — and it is the reason this helper is for caches only: state whose
 * values must survive (a counter, a generation) needs field-wise normalization
 * instead, as `push-state.ts` does.
 */
export function processWideCache<T>(
  key: `__pinchy${string}`,
  create: () => T,
  isCurrent: (value: unknown) => boolean
): T {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[key];
  if (existing !== undefined && isCurrent(existing)) return existing as T;
  const fresh = create();
  store[key] = fresh;
  cacheKeys().add(key);
  return fresh;
}

/**
 * Every key this helper has stored a cache under — itself process-wide, so a
 * reset through one module instance reaches the caches the other created.
 */
function cacheKeys(): Set<string> {
  const store = globalThis as unknown as Record<string, unknown>;
  const keys = store.__pinchyProcessWideCacheKeys;
  if (keys instanceof Set) return keys as Set<string>;
  const fresh = new Set<string>();
  store.__pinchyProcessWideCacheKeys = fresh;
  return fresh;
}

/**
 * Test-only: drop every cache created through {@link processWideCache}; the
 * next read creates it afresh. `vi.resetModules()` cannot do this — the caches
 * outlive the module instance by design — so the shared vitest setup calls it
 * after every test. Do not call in app code.
 */
export function _resetProcessWideCaches(): void {
  const store = globalThis as unknown as Record<string, unknown>;
  const keys = cacheKeys();
  for (const key of keys) delete store[key];
  keys.clear();
}

/** `isCurrent` for a cache stored as a Map. */
export const isMap = (value: unknown): boolean => value instanceof Map;

/** `isCurrent` for a cache stored as an object with (at least) these fields. */
export function hasFields(...fields: string[]): (value: unknown) => boolean {
  return (value) =>
    typeof value === "object" && value !== null && fields.every((field) => field in value);
}
