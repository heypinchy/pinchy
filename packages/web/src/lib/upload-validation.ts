const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const MAX_FILENAME_LEN = 255;

export function sanitizeFilename(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("Invalid filename: not a string");
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new Error("Invalid filename: contains control characters");
  }
  if (raw.includes("..")) {
    throw new Error("Invalid filename: contains parent-directory reference");
  }
  if (raw.startsWith("./") || raw.startsWith(".\\")) {
    throw new Error("Invalid filename: absolute or relative path");
  }

  // Strip directory components, keep last segment.
  const parts = raw.replace(/\\/g, "/").split("/");
  const last = parts[parts.length - 1];
  const trimmed = last.trim();

  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("Invalid filename: empty or reserved");
  }

  if (trimmed.length > MAX_FILENAME_LEN) {
    throw new Error("Invalid filename: too long");
  }

  return trimmed;
}
