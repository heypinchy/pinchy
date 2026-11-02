// OpenClaw's read side, as Pinchy has to reckon with it when IT writes
// openclaw.json.
//
// OpenClaw (2026.7.1) judges every config read against its last-known-good: a
// file under half of it (`size-drop-vs-last-good`, for a last-known-good of at
// least 512 bytes) is "suspicious", and its startup read restores `.bak` over
// it. It moves last-known-good only while it runs — its reloader promotes every
// config it accepts, its own `config.apply` writes included, and its startup
// promotes the file it started on. So while OpenClaw is down, every file Pinchy
// writes lands on a last-known-good that can be the file from before the FIRST
// of those writes. Judging a write against the file on disk is not enough once
// an earlier write shrank it: a re-keyed file (rekeyedBridge) sits just above
// half of the one it replaced, and the next write judged against it alone —
// the target of the next regenerate, or a second re-key — could fall to a
// quarter of last-known-good. OpenClaw's next start then restored `.bak`,
// written before the key-less bridge and naming a key secrets.json no longer
// holds: "required secrets are unavailable", until the next regenerate.
//
// Pinchy cannot read last-known-good (`openclaw.json.last-good`, `.bak` and
// OpenClaw's health state are written root 0600), so it keeps an upper bound
// instead: the largest file any Pinchy write replaced since a `config.apply`
// last landed. A landed `config.apply` resets it — OpenClaw is running then,
// and promotes its own write. Every Pinchy write of openclaw.json is judged
// against the larger of that bound and the file on disk (writeConfigAtomic),
// with OpenClaw's own rule: these are file writes, so Pinchy counts exactly
// the bytes OpenClaw will read.
//
// The bound lives on globalThis (push-state.ts: one value for every module
// instance), and — whenever it is larger than the file just written, the one
// case where the disk does not already say it — in a small Pinchy-owned file
// next to openclaw.json, so a Pinchy restart does not forget it.
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_PATH } from "./paths";
import { utf8Bytes } from "./size-drop";
import { lastGoodBound, setLastGoodBound, type LastGoodBound } from "./push-state";

/** Pinchy's own file, beside openclaw.json on the shared volume. */
export const LAST_GOOD_BOUND_PATH = join(dirname(CONFIG_PATH), "pinchy-last-good-bound.json");

/** OpenClaw ignores a last-known-good smaller than this (`size-drop-vs-last-good`). */
const READ_SIDE_MIN_BASELINE_BYTES = 512;

/**
 * Thrown by writeConfigAtomic instead of writing a file OpenClaw's next start
 * would replace with `.bak`. The file on disk stays as it is.
 */
export class UnderReadSideLineError extends Error {
  constructor(
    readonly nextBytes: number,
    readonly baselineBytes: number
  ) {
    super(
      `[openclaw-config] NOT writing openclaw.json: ${String(nextBytes)} bytes is under half of ` +
        `${String(baselineBytes)}, the largest file OpenClaw may still hold as last-known-good ` +
        `(it promotes only while it runs). Its next start would restore .bak over this one; ` +
        `config.apply delivers the change once OpenClaw is up.`
    );
    this.name = "UnderReadSideLineError";
  }
}

function load(): LastGoodBound {
  const known = lastGoodBound();
  if (known) return known;
  let persisted = 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(LAST_GOOD_BOUND_PATH, "utf-8"));
    const bytes = (parsed as { bytes?: unknown } | null)?.bytes;
    if (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0) persisted = bytes;
  } catch {
    // None yet (or unreadable): nothing beyond the file on disk to judge by.
  }
  const bound = { bytes: persisted, persistedBytes: persisted };
  setLastGoodBound(bound);
  return bound;
}

/**
 * The size to judge a Pinchy write of openclaw.json against: the larger of the
 * file on disk (`current`) and every file a Pinchy write replaced since a
 * `config.apply` last landed — what OpenClaw may still hold as last-known-good.
 */
export function readSideBaselineBytes(current: string | undefined): number {
  return Math.max(load().bytes, current === undefined ? 0 : utf8Bytes(current));
}

/**
 * Throws UnderReadSideLineError when `next`, written over `current`, would be
 * under OpenClaw's read-side line; otherwise records `current` as a file
 * OpenClaw may still hold — persisted when `next` is smaller than it — before
 * the caller writes.
 */
export function guardFileWrite(current: string | undefined, next: string): void {
  const baselineBytes = readSideBaselineBytes(current);
  const nextBytes = utf8Bytes(next);
  if (
    baselineBytes >= READ_SIDE_MIN_BASELINE_BYTES &&
    nextBytes < Math.floor(baselineBytes * 0.5)
  ) {
    throw new UnderReadSideLineError(nextBytes, baselineBytes);
  }
  const bound = load();
  setLastGoodBound({ ...bound, bytes: baselineBytes });
  if (baselineBytes <= nextBytes || baselineBytes <= bound.persistedBytes) return;
  try {
    writeFileSync(LAST_GOOD_BOUND_PATH, JSON.stringify({ bytes: baselineBytes }) + "\n", {
      encoding: "utf-8",
      mode: 0o644,
    });
    setLastGoodBound({ bytes: baselineBytes, persistedBytes: baselineBytes });
  } catch (err) {
    console.warn(
      `[openclaw-config] could not record OpenClaw's last-known-good bound in ${LAST_GOOD_BOUND_PATH} ` +
        `(kept in memory only; a Pinchy restart before OpenClaw is up forgets it):`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** A `config.apply` landed: OpenClaw is running and promotes its own write. */
export function clearLastGoodBound(): void {
  const bound = load();
  if (bound.bytes === 0 && bound.persistedBytes === 0) return;
  setLastGoodBound({ bytes: 0, persistedBytes: bound.persistedBytes });
  if (bound.persistedBytes === 0) return;
  try {
    unlinkSync(LAST_GOOD_BOUND_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // Still on disk: a restart reloads it. Too high only defers file writes
      // to config.apply; it never lets one under the line.
      return;
    }
  }
  setLastGoodBound({ bytes: 0, persistedBytes: 0 });
}
