// Decide which turns to include in a diagnostics bundle.
//
// Two modes:
//
//   1. No anchor — Settings-triggered export. We include the last `windowSize`
//      turns of the session. `anchorTurnIndex` is null.
//
//   2. Anchor — per-message "Report bug" export (Task 14, not yet wired). We
//      include the anchor turn plus up to `windowSize - 1` preceding turns,
//      clamped at index 0. The bundle reports `anchorTurnIndex` as a 1-based
//      count of turns up to and including the anchor (matching
//      `BundleInput.scope.anchorTurnIndex` semantics in bundle-builder.ts).
//
// v1 simplification: Turn has no per-message id today. To unblock per-turn
// exports while the UI plumbs a real id through, we interpret `anchorMessageId`
// as a stringified 0-based turn index. When parsing fails or the index is out
// of range we fall back to no-anchor behavior rather than erroring — the
// caller may legitimately have referenced a pre-trajectory message id.

import type { Turn } from "./turn-extractor";

export interface ScopeResolution {
  /**
   * 1-based count of turns included up to and through the anchor (matches
   * BundleInput.scope.anchorTurnIndex semantics). `null` when no anchor.
   */
  anchorTurnIndex: number | null;
  includedTurnRange: [number, number];
}

export function computeScope(
  turns: Turn[],
  anchorMessageId: string | undefined,
  windowSize: number
): ScopeResolution {
  // Empty session: [0, -1] is the canonical "empty slice" range.
  if (turns.length === 0) {
    return { anchorTurnIndex: null, includedTurnRange: [0, -1] };
  }

  if (anchorMessageId !== undefined) {
    const parsed = parseInt(anchorMessageId, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed < turns.length) {
      const end = parsed;
      const start = Math.max(0, end - (windowSize - 1));
      return {
        anchorTurnIndex: end + 1,
        includedTurnRange: [start, end],
      };
    }
    // Unparseable / out-of-range: fall through to no-anchor behavior.
  }

  const end = turns.length - 1;
  const start = Math.max(0, turns.length - windowSize);
  return {
    anchorTurnIndex: null,
    includedTurnRange: [start, end],
  };
}
