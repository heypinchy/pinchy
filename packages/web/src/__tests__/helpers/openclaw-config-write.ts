import type { Mock } from "vitest";

/**
 * Return the openclaw.json content captured by a mocked `fs.writeFileSync`.
 *
 * `regenerateOpenClawConfig` writes several files per run before it writes the
 * config itself: retrofitted workspace files (SOUL.md/AGENTS.md via
 * `ensureWorkspace`), per-agent auth profiles, and — on the size-guard path —
 * a `<CONFIG_PATH>.regenerate-rejected.<ts>` dump. The config is written last,
 * atomically, to `<CONFIG_PATH>.tmp` (then renamed). So the config is NOT
 * reliably `mock.calls[0]`; that only holds while `existsSync` is stubbed
 * `true`, which happens to suppress the workspace writes. Locate the config by
 * its atomic-write path (`openclaw.json.tmp`) instead of by call order — the
 * `.tmp` suffix also excludes the `.regenerate-rejected.` dump, which contains
 * `openclaw.json` but not `openclaw.json.tmp`.
 *
 * Mirrors the `.find(c[0].includes("openclaw.json.tmp"))` pattern already used
 * by the order-sensitive tests in this suite, so every assertion reads the
 * config the same robust way.
 */
export function writtenOpenClawConfig(writeFileSyncMock: Mock): string {
  const call = writeFileSyncMock.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0].includes("openclaw.json.tmp")
  );
  if (!call) {
    throw new Error(
      "openclaw.json was never written — no writeFileSync call targeted <CONFIG_PATH>.tmp"
    );
  }
  return call[1] as string;
}
