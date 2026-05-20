import type { Bundle } from "./bundle-builder";

export const BUNDLE_SIZE_CAP_BYTES = 5 * 1024 * 1024;

export function enforceSizeCap(bundle: Bundle): { bundle: Bundle; dropped: number } {
  let working: Bundle = bundle;
  let dropped = 0;
  while (
    Buffer.byteLength(JSON.stringify(working), "utf8") > BUNDLE_SIZE_CAP_BYTES &&
    working.spans.length > 1
  ) {
    working = {
      ...working,
      spans: working.spans.slice(1),
      scope: {
        ...working.scope,
        includedTurnRange: [
          working.scope.includedTurnRange[0] + 1,
          working.scope.includedTurnRange[1],
        ],
      },
    };
    dropped += 1;
  }
  return { bundle: working, dropped };
}
