// Generation-time filename validation for pinchy_generate_file (#788).
//
// The #703 serve route (packages/web/src/app/api/agents/[agentId]/artifacts/
// [filename]/route.ts) authorizes a download by running the URL filename
// through upload-validation.ts's sanitizeFilename and looking the grant up
// under the RESULT. The grant itself stores the name this plugin emitted,
// verbatim (client-router.ts, deliverRunArtifacts). So every name we accept
// must be a fixed point of that sanitizer — sanitize(name) === name — or the
// lookup never matches and the delivered chip 404s forever.
//
// Plugins cannot import from packages/web, so the rules are mirrored here.
// The drift guard is packages/web/src/__tests__/lib/
// deliverable-filename-alignment.test.ts, which imports BOTH sides and fails
// on any incompatible change. Being stricter than the sanitizer is fine;
// accepting a name it would alter or reject is the bug the guard catches.

// Same character classes as upload-validation.ts, as explicit `\u…` escapes
// (never literal invisible characters): C0 controls + DEL, zero-width and
// BiDi formatting characters, BiDi isolates, BOM/ZWNBSP.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

// `"` breaks the quoted Content-Disposition the serve route emits, and a
// backtick would close the markdown code span agents read attachment names in.
const FORBIDDEN_CHAR_RE = /["`]/;

// The sanitizer caps the FULL name at 255. The basename cap leaves room for
// the extension and a collision suffix (`-2`…`-99`) the tool may append.
const MAX_BASENAME_LENGTH = 200;

/**
 * Validate an agent-supplied basename (no extension) and return the exact
 * form the file will be stored and granted under: NFC-normalized (macOS-style
 * NFD input would otherwise never match the NFC name the grant lookup
 * round-trips through JSON and the model) and trimmed (the sanitizer trims on
 * serve, so surrounding whitespace would break the fixed-point property).
 * Throws with a model-actionable message on anything the serve-route
 * sanitizer would reject.
 */
export function normalizeDeliverableBasename(raw: string): string {
  const normalized = raw.normalize("NFC");
  if (CONTROL_CHAR_RE.test(normalized)) {
    throw new Error("filename must not contain control or invisible characters");
  }
  if (FORBIDDEN_CHAR_RE.test(normalized)) {
    throw new Error("filename must not contain '\"' or '`'");
  }
  // Basename only: the agent supplies a name, not a path. Rejecting
  // separators/traversal here — before the name ever reaches join() — is what
  // keeps the generated file confined to the workbench dir, mirroring
  // pinchy_write's onDisk validation posture.
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new Error("filename must be a base name without path separators (no '/', '\\', or '..')");
  }
  const trimmed = normalized.trim();
  if (!trimmed || trimmed === ".") {
    throw new Error("filename must not be empty");
  }
  if (trimmed.length > MAX_BASENAME_LENGTH) {
    throw new Error(`filename is too long (maximum ${MAX_BASENAME_LENGTH} characters)`);
  }
  return trimmed;
}
