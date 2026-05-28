// Bundle size cap: drop the oldest spans (lowest-index in includedTurnRange)
// until the serialized JSON fits under BUNDLE_SIZE_CAP_BYTES. The newest span
// (the anchor) is always preserved — diagnostics is most useful when the most
// recent turn survives.
//
// Algorithm — measure once, drop in a single pass (O(n) in span count):
//   1. Serialize each span individually to learn its byte cost.
//   2. Serialize the bundle with `spans: []` to learn the envelope overhead
//      (schemaVersion, scope, audit entries, etc.).
//   3. Walk spans newest → oldest, accumulating their byte cost. Stop when
//      adding the next-oldest span would exceed the cap.
//   4. The remaining prefix (oldest spans that didn't fit) is dropped; advance
//      `scope.includedTurnRange[0]` accordingly.
//   5. If the anchor alone exceeds the cap (so even with `dropped` == N-1 we
//      can't fit), keep the anchor and flag `truncated: true` so the caller
//      can audit-log the overshoot.
//
// Comma overhead (`,` between spans in the serialized array) is approximated
// by a per-span +1 byte; over-counting marginally trims more aggressively
// than necessary, which is safer than under-counting near the boundary.

import type { Bundle } from "./bundle-builder";

export const BUNDLE_SIZE_CAP_BYTES = 5 * 1024 * 1024;

export function enforceSizeCap(bundle: Bundle): {
  bundle: Bundle;
  dropped: number;
  truncated: boolean;
} {
  const spans = bundle.spans;
  if (spans.length === 0) {
    const truncated = Buffer.byteLength(JSON.stringify(bundle), "utf8") > BUNDLE_SIZE_CAP_BYTES;
    return { bundle, dropped: 0, truncated };
  }

  // Envelope cost = serialized bundle without spans. Subtract the empty `[]`
  // (2 bytes) so we only count the framing scaffold, not the span container.
  const envelopeWithEmptySpans = JSON.stringify({ ...bundle, spans: [] });
  const envelopeBytes = Buffer.byteLength(envelopeWithEmptySpans, "utf8") - 2;

  // Per-span cost, including a 1-byte separator allowance.
  const spanBytes = spans.map((s) => Buffer.byteLength(JSON.stringify(s), "utf8") + 1);

  let runningTotal = envelopeBytes + 2; // re-add the `[]` framing
  let firstKeptIndex = spans.length;
  // Walk newest → oldest. Always keep the anchor (newest), even if it alone
  // would push us over the cap; flag `truncated` instead.
  for (let i = spans.length - 1; i >= 0; i--) {
    const next = runningTotal + spanBytes[i];
    if (i === spans.length - 1 || next <= BUNDLE_SIZE_CAP_BYTES) {
      runningTotal = next;
      firstKeptIndex = i;
    } else {
      break;
    }
  }

  const dropped = firstKeptIndex;
  if (dropped === 0) {
    // Nothing to drop — but the anchor may still overshoot. Compute final
    // serialized size to set `truncated` honestly.
    const truncated = Buffer.byteLength(JSON.stringify(bundle), "utf8") > BUNDLE_SIZE_CAP_BYTES;
    return { bundle, dropped: 0, truncated };
  }

  const trimmed: Bundle = {
    ...bundle,
    spans: spans.slice(firstKeptIndex),
    scope: {
      ...bundle.scope,
      includedTurnRange: [
        bundle.scope.includedTurnRange[0] + dropped,
        bundle.scope.includedTurnRange[1],
      ],
    },
  };
  const truncated = Buffer.byteLength(JSON.stringify(trimmed), "utf8") > BUNDLE_SIZE_CAP_BYTES;
  return { bundle: trimmed, dropped, truncated };
}
