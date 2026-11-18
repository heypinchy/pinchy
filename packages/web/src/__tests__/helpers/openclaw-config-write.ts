import type { Mock } from "vitest";

/**
 * Basename suffix of the atomic openclaw.json write.
 *
 * `writeConfigAtomic` writes the config to `<CONFIG_PATH>.tmp` and then renames
 * it onto `<CONFIG_PATH>`, so the config content is only ever captured by the
 * `writeFileSync` call whose path ends in this suffix. It keys off the DEFAULT
 * `OPENCLAW_CONFIG_PATH` basename (`/openclaw-config/openclaw.json`); the tests
 * in this suite all run on that default. The suffix also excludes the
 * size-guard `<CONFIG_PATH>.regenerate-rejected.<ts>` dump, which contains
 * `openclaw.json` but does not end in `openclaw.json.tmp`.
 */
export const OPENCLAW_CONFIG_TMP_SUFFIX = "openclaw.json.tmp";

/**
 * True when a mocked `fs.writeFileSync` call is the atomic openclaw.json write
 * (its path targets `<CONFIG_PATH>.tmp`). Usable as a `.find`/`.filter`
 * predicate over `writeFileSyncMock.mock.calls`.
 */
export function isOpenClawConfigWrite(call: unknown[]): boolean {
  return typeof call[0] === "string" && call[0].endsWith(OPENCLAW_CONFIG_TMP_SUFFIX);
}

/**
 * Return the `writeFileSync` call that emitted openclaw.json, or `undefined`
 * if none did. Prefer this over `mock.calls[0]` for presence/absence checks:
 * `regenerateOpenClawConfig` writes several files per run before the config
 * (retrofitted SOUL.md/AGENTS.md via `ensureWorkspace`, per-agent auth
 * profiles), so the config is NOT reliably `calls[0]` — that only holds while
 * `existsSync` is stubbed `true`, which happens to suppress the workspace
 * writes. Locate the config by its atomic-write path instead of by call order.
 */
export function findOpenClawConfigWrite(writeFileSyncMock: Mock): unknown[] | undefined {
  return writeFileSyncMock.mock.calls.find(isOpenClawConfigWrite);
}

/**
 * Return the openclaw.json content captured by a mocked `fs.writeFileSync`.
 *
 * Thin wrapper over {@link findOpenClawConfigWrite} for the common case where a
 * test asserts on the emitted config and therefore requires that a config write
 * happened — throws a descriptive error if it didn't. Mirrors the
 * `.find(isOpenClawConfigWrite)` pattern used by the order-sensitive tests in
 * this suite, so every assertion reads the config the same robust way.
 */
export function writtenOpenClawConfig(writeFileSyncMock: Mock): string {
  const call = findOpenClawConfigWrite(writeFileSyncMock);
  if (!call) {
    throw new Error(
      "openclaw.json was never written — no writeFileSync call targeted <CONFIG_PATH>.tmp"
    );
  }
  return call[1] as string;
}
