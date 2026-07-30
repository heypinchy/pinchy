/**
 * Path containment for serving a workspace/allowed-path file to the browser.
 *
 * `allowed_paths` (see `AgentPluginConfig["pinchy-files"]`) is the SAME
 * allowlist that already scopes an agent's file tools (pinchy-files) and its
 * knowledge-base retrieval (`/api/internal/knowledge/search`) — see
 * `openclaw-config/build.ts`'s `adminPaths` and `retrieve.ts`'s
 * `buildPathFilter`. This module answers one question: given a requested
 * absolute path and that allowlist, is it safe to read the file off disk and
 * hand its bytes to the browser?
 *
 * This used to say "the SAME ADMIN-CONFIGURED allowlist", and that adjective
 * was the whole vulnerability: `PATCH /api/agents/[id]` gated `allowedTools`,
 * `visibility` and `groupIds` on the admin role but never gated
 * `pluginConfig`, so any member could widen their own seeded personal agent's
 * grant to `/`. The write side is confined now (`pluginConfigSchema`), but a
 * clamp on new writes says nothing about rows already in the database — an
 * upgraded install can carry an older grant that was never checked. So
 * containment is measured against the intersection of the agent's grant and
 * an absolute ceiling this module owns (`FILE_SERVE_ROOTS`), exactly as
 * `pinchy-files` measures against its own `ALLOWED_ROOTS` rather than
 * trusting its config alone. Neither list may widen the other.
 *
 * Two-stage containment, mirroring `packages/plugins/pinchy-files/validate.ts`:
 *
 *   1. Lexical: `path.resolve()` collapses `..`/`.` segments with no
 *      filesystem access, then a separator-bounded prefix check rejects
 *      anything textually outside every allowed root — traversal and
 *      absolute-path escapes never reach `fs.realpath`, so an out-of-scope
 *      probe never touches the filesystem.
 *   2. Real: `fs.realpath()` resolves symlinks on BOTH the requested path and
 *      every allowed root, then the same boundary check runs again. This is
 *      what defeats a symlink planted inside an allowed directory that
 *      points outside it — the lexical stage alone cannot see that, exactly
 *      why pinchy-files' read tools and `assertNoSymlinkEscape` both realpath
 *      before validating.
 *
 * Deny by default: an empty/missing allowlist, a lexical miss, a real-path
 * miss, or an unreadable allowed root are ALL treated as "outside scope"
 * (403) rather than "not found" (404) — a 404 is reserved for a path that IS
 * inside scope but doesn't exist on disk, so an attacker probing outside the
 * scope never learns whether a given path exists.
 */
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { FILE_SERVE_ROOTS } from "./file-serve-roots";

export { FILE_SERVE_ROOTS };

export type ResolveAllowedFileResult =
  { ok: true; realPath: string } | { ok: false; status: 403 | 404 };

/**
 * Is `path` (already `resolve()`d) equal to `root`, or a descendant of it?
 * Boundary-safe: `/data/foo` does not match `/data/foobar` because the
 * comparison is against `root + sep`, not a raw `startsWith(root)`.
 */
function isContained(path: string, root: string): boolean {
  if (path === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(rootWithSep);
}

export async function resolveAllowedFile(
  requestedPath: string,
  allowedPaths: string[],
  /**
   * The absolute ceiling. Injected rather than read directly so tests can
   * exercise real containment against a temporary directory — the production
   * value is a container mount point they cannot create.
   */
  serveRoots: readonly string[] = FILE_SERVE_ROOTS
): Promise<ResolveAllowedFileResult> {
  // Either list being empty denies everything: no grant, or no ceiling to
  // grant within. Both are configuration faults, and both fail closed.
  if (allowedPaths.length === 0 || serveRoots.length === 0) {
    return { ok: false, status: 403 };
  }

  // Stage 1 — lexical containment. No fs access: `resolve()` normalizes `..`
  // and relative segments purely as string manipulation, so an obviously
  // out-of-scope request (traversal, absolute path elsewhere) is rejected
  // before we ever stat/read anything the caller doesn't have a right to.
  //
  // Both lists must contain the target. The grant says what this agent may
  // see; the ceiling says what this route may serve at all. An over-broad
  // grant that predates the write-side clamp therefore buys nothing.
  const lexicalTarget = resolve(requestedPath);
  const lexicallyContained =
    allowedPaths.some((root) => isContained(lexicalTarget, resolve(root))) &&
    serveRoots.some((root) => isContained(lexicalTarget, resolve(root)));
  if (!lexicallyContained) {
    return { ok: false, status: 403 };
  }

  // Stage 2 — real-path containment. Resolve symlinks on the target...
  let realTarget: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- lexicalTarget already passed the stage-1 lexical containment check above; resolving it is itself the security boundary (defeats symlink escapes), not an unchecked read.
    realTarget = await realpath(lexicalTarget);
  } catch (err) {
    // ENOENT here means the path is genuinely in-scope (it passed stage 1)
    // but nothing exists there — that's a legitimate 404, not a scope denial.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404 };
    }
    // Any other error (permission denied, symlink loop, ...) — cannot verify
    // containment safely, so deny.
    return { ok: false, status: 403 };
  }

  // ...and on every root of both lists, so a root that is itself a symlink
  // (or whose ancestor is, e.g. macOS `/var` -> `/private/var`) still
  // compares consistently. Roots that fail to resolve (misconfigured/missing)
  // are skipped rather than treated as a hard error — another root may still
  // be valid.
  const containsRealTarget = async (roots: readonly string[]) => {
    const realRoots = await Promise.all(
      roots.map(async (root) => {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- root comes from the agent's allowed_paths list or the module's own serve-root ceiling, not from request input.
          return await realpath(resolve(root));
        } catch {
          return null;
        }
      })
    );
    return realRoots.some((realRoot) => realRoot !== null && isContained(realTarget, realRoot));
  };

  // The ceiling is re-applied to the REAL path, not just the lexical one.
  // Without that, a symlink planted inside a served directory and pointing at
  // the secrets mount would satisfy both stage-1 checks and still be read.
  const reallyContained =
    (await containsRealTarget(allowedPaths)) && (await containsRealTarget(serveRoots));
  if (!reallyContained) {
    // The lexical path was in scope, but its real (symlink-resolved) target
    // escapes the grant or the ceiling — e.g. a symlink planted inside an
    // allowed directory pointing outside it. Deny.
    return { ok: false, status: 403 };
  }

  return { ok: true, realPath: realTarget };
}
