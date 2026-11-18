import { createHash } from "node:crypto";

/**
 * Canonicalize a value so semantically-equal arguments hash identically:
 * object keys are sorted recursively; array order is preserved (it is
 * semantically significant — `[1,2]` is a different request than `[2,1]`).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // A null-prototype accumulator, because on a plain `{}` the assignment
    // `acc["__proto__"] = …` hits Object.prototype's setter instead of creating
    // a key: the key vanished from the digest, and two calls that differed only
    // there shared one approval. JSON.stringify serialises the own keys of a
    // null-prototype object exactly as it does a plain one, so every ordinary
    // call keeps the digest it had — a pending confirmation still matches its
    // retry across the upgrade.
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>(
        (acc, key) => {
          acc[key] = canonicalize(obj[key]);
          return acc;
        },
        Object.create(null) as Record<string, unknown>
      );
  }
  return value;
}

/**
 * A stable sha256 digest binding an approval to one exact tool call. Different
 * arguments produce a different digest, so a changed call requires a new
 * confirmation (the consume-once guarantee is enforced on top of this).
 */
export function computeArgsDigest(params: unknown): string {
  const canonical = JSON.stringify(canonicalize(params ?? {}));
  return createHash("sha256").update(canonical).digest("hex");
}
