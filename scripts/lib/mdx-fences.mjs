/**
 * One reading of "where do the fenced code blocks in upgrading.mdx sit".
 *
 * Every tool that reads `docs/src/content/docs/guides/upgrading.mdx` finds a
 * section boundary with a line-anchored `^## `. Upgrade notes quote markdown at
 * people — v0.9.1's knowledge-base note shows an agent's `## Document Access`
 * block inside a fence — and read literally, that line ends the section.
 *
 * The consequences differ per caller and none of them is loud:
 *
 *  - `extractUpgradeNotes` writes the GitHub Release body, so the release
 *    notes simply stop mid-fence. v0.9.1 shipped that way: the published body
 *    ends at a dangling ```` ```markdown ```` and the remediation the note
 *    exists to give never reached a reader.
 *  - `finalizeUpgradeSection` freezes `%%PINCHY_VERSION%%` only up to the
 *    fence, and `assertNoStaleUpgradeSections` — the guard for exactly that
 *    miss — is blind to the leftover for the same reason. Symmetric blindness
 *    reads exactly like agreement.
 *  - `parseUpgradeSections` compares a truncated section against a section
 *    truncated at the same place, and reports green.
 *
 * So the masking lives in one module that all of them import, for the same
 * reason `readRequestHost` does (AGENTS.md § "`/api/internal/` Is A Security
 * Claim"): two gates reading one input must read it the same way.
 */

/**
 * Blank out fenced code blocks, preserving length and line structure.
 *
 * Returned same-length so every index computed against the mask still addresses
 * the original string; newlines survive so the `m` flag keeps anchoring. The
 * delimiter lines themselves are kept — they can never be a `#` heading.
 *
 * An UNCLOSED fence is deliberately not masked. CommonMark would run it to end
 * of document, but here that would delete every following section from a
 * caller's view — silently, which is the failure mode this module exists to
 * remove. Left unmasked, a malformed file makes a guard report phantom
 * sections and fail loudly instead.
 *
 * @param {string} mdx
 * @returns {string}
 */
export function maskFencedBlocks(mdx) {
  const lines = mdx.split("\n");
  const fenceRuns = [];
  let open = null; // { line, run }

  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (!m) continue;
    const run = m[1];
    if (open === null) {
      open = { line: i, run };
      continue;
    }
    // A closing fence uses the same character and is at least as long.
    if (run[0] === open.run[0] && run.length >= open.run.length) {
      fenceRuns.push([open.line, i]);
      open = null;
    }
  }

  if (fenceRuns.length === 0) return mdx;

  const masked = lines.slice();
  for (const [start, end] of fenceRuns) {
    for (let i = start + 1; i < end; i++) {
      masked[i] = " ".repeat(masked[i].length);
    }
  }
  return masked.join("\n");
}

/**
 * Slice the body that follows a heading, up to the next `## ` that is really a
 * heading — i.e. not one quoted inside a fence.
 *
 * The boundary is searched in the mask; the body is cut from the ORIGINAL, so
 * callers that return or rewrite the text get the real bytes. Both are safe to
 * mix because `maskFencedBlocks` is length-preserving.
 *
 * @param {string} mdx - the whole document
 * @param {number} bodyStart - index just past the heading line
 * @param {string} [mask] - a mask of `mdx`, when the caller already has one
 * @returns {{body: string, end: number}}
 */
export function sliceSectionBody(mdx, bodyStart, mask = maskFencedBlocks(mdx)) {
  const next = /^## /m.exec(mask.slice(bodyStart));
  const end = next ? bodyStart + next.index : mdx.length;
  return { body: mdx.slice(bodyStart, end), end };
}
