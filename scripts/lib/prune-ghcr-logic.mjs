// Pure filtering logic for the GHCR prune script.
//
// Background: PR #212 removed the previous prune-sha-tags job after it
// silently deleted all v* / latest / next images. The
// actions/delete-package-versions ignore-versions regex matched against
// container *digests*, not tag names — so the protection never triggered.
// This module does the filtering on tag names and is unit-tested with
// fixture inputs so we cannot ship that bug again.

const PROTECTED_TAG_PATTERNS = [
  /^latest$/,
  /^next$/,
  /^v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/,
];

const SHA_TAG_PATTERN = /^sha-[a-f0-9]+$/;

const isProtectedTag = (tag) =>
  PROTECTED_TAG_PATTERNS.some((re) => re.test(tag));
const isShaTag = (tag) => SHA_TAG_PATTERN.test(tag);

export function selectVersionsToDelete(versions, options) {
  const { keepCount, deleteOlderThanDays = null, now = new Date() } = options;

  if (!Number.isInteger(keepCount) || keepCount < 0) {
    throw new Error(
      `keepCount must be a non-negative integer, got: ${keepCount}`,
    );
  }

  const candidates = versions
    .filter((version) => {
      const tags = version?.metadata?.container?.tags ?? [];
      if (tags.length === 0) return false;
      if (tags.some(isProtectedTag)) return false;
      return tags.every(isShaTag);
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const beyondKeep = candidates.slice(keepCount);

  if (deleteOlderThanDays === null) {
    return beyondKeep;
  }

  const cutoff = new Date(now.getTime() - deleteOlderThanDays * 86_400_000);
  return beyondKeep.filter((version) => new Date(version.created_at) < cutoff);
}
