/**
 * Run fingerprint for Eval-v1 (pinchy#669, #799).
 *
 * A measured pass/fail is a joint outcome of (model × Pinchy × serving), so a
 * score is only comparable within a fixed platform build. This captures what
 * built the numbers, so a later sweep can be diffed against this one and the
 * delta attributed — the version-regression use the benchmark was meant to
 * double as. Inspect AI's `EvalSpec` is the model: record the revision, the
 * versions, and the environment per run, not in prose.
 *
 * The honest part is `comparable`. If the platform build cannot be uniquely
 * identified — the stack reports `build: "dev"` (no `PINCHY_BUILD_SHA`), or the
 * harness tree is dirty, or a field is missing — the fingerprint still records
 * everything it saw, but flags that it must NOT anchor a cross-version baseline.
 * A `dev` build of 0.8.0 and a different `dev` build of 0.8.0 are the same
 * fingerprint and different code; pretending otherwise is how a regression
 * comparison silently compares two things that aren't what it thinks.
 */

/** The shape of Pinchy's `GET /api/version` response. */
export interface VersionResponse {
  pinchyVersion?: string;
  openclawVersion?: string;
  /** Build SHA, or "dev" when PINCHY_BUILD_SHA is unset. */
  build?: string;
  nodeEnv?: string;
}

export interface RunFingerprint {
  pinchyVersion: string;
  openclawVersion: string;
  build: string;
  nodeEnv: string;
  /** git rev-parse HEAD of the eval harness at sweep time. */
  harnessSha: string;
  /** true if the harness working tree had uncommitted changes. */
  harnessDirty: boolean;
  /** ISO timestamp the sweep started. */
  sweptAt: string;
  /**
   * True only if this fingerprint uniquely identifies the code that ran, so it
   * can anchor a version-regression comparison. False when the platform build
   * is `dev`/unknown, the harness is dirty, or any identifying field is missing.
   * A false fingerprint is fine to publish — it just can't be a baseline.
   */
  comparable: boolean;
}

import { execFileSync } from "node:child_process";

const UNKNOWN = "unknown";
const clean = (v: string | undefined): string => (v && v.trim().length > 0 ? v : UNKNOWN);

/** Build strings that name no unique build, so two runs can't be told apart. */
const NON_UNIQUE_BUILDS = new Set(["dev", UNKNOWN, ""]);

/**
 * Assembles a {@link RunFingerprint} from a version response, the harness git
 * state, and the sweep timestamp. Pure — the I/O lives in
 * {@link captureRunFingerprint}.
 */
export function buildRunFingerprint(
  version: VersionResponse,
  git: { sha: string; dirty: boolean },
  sweptAt: string
): RunFingerprint {
  const build = clean(version.build);
  const harnessSha = clean(git.sha);
  const pinchyVersion = clean(version.pinchyVersion);
  const openclawVersion = clean(version.openclawVersion);

  const comparable =
    !NON_UNIQUE_BUILDS.has(build) &&
    !git.dirty &&
    harnessSha !== UNKNOWN &&
    pinchyVersion !== UNKNOWN &&
    openclawVersion !== UNKNOWN;

  return {
    pinchyVersion,
    openclawVersion,
    build,
    nodeEnv: clean(version.nodeEnv),
    harnessSha,
    harnessDirty: git.dirty,
    sweptAt,
    comparable,
  };
}

/** Reads the harness git HEAD sha and whether the tree is dirty. */
function readHarnessGit(): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: "", dirty: false };
  }
}

/**
 * The I/O shell over {@link buildRunFingerprint}: fetches `GET /api/version`
 * from the running stack and reads the harness git state. Never throws — an
 * unreachable stack yields an all-`unknown`, `comparable: false` fingerprint, so
 * a capture failure degrades the metadata rather than aborting a 15-hour sweep.
 */
export async function captureRunFingerprint(
  pinchyUrl: string,
  sweptAt: string
): Promise<RunFingerprint> {
  let version: VersionResponse = {};
  try {
    const res = await fetch(`${pinchyUrl}/api/version`, {
      headers: { "Cache-Control": "no-store" },
    });
    if (res.ok) version = (await res.json()) as VersionResponse;
  } catch {
    // leave version empty → all "unknown", comparable:false
  }
  return buildRunFingerprint(version, readHarnessGit(), sweptAt);
}
