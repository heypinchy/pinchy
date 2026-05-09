/**
 * Data-URL ↔ File conversion helpers.
 *
 * Uses native `atob`/`btoa` and `Blob.arrayBuffer()` so it works in all
 * browser environments, in jsdom (no `fetch` hangs), and with vitest fake
 * timers (no FileReader timer-event deadlocks).
 */

/**
 * Chunk size for the binary→string conversion in `fileToDataUrl`.
 *
 * `String.fromCharCode.apply(null, arr)` spreads `arr` as function arguments
 * — V8 caps that around ~125k args before throwing RangeError. 8 KB stays
 * comfortably under any engine's limit while keeping the loop short. For a
 * 15 MB image this is roughly 1900 iterations, each calling `apply` over an
 * 8 KB slice, vs ~15 million single-byte `+=` concatenations in the naive
 * implementation.
 */
const CHUNK_SIZE = 8192;

export function dataUrlToFile(dataUrl: string): File {
  // Parse "data:<mime>;base64,<data>" without `fetch` so this works in all
  // environments (jsdom's `fetch` hangs on data: URLs).
  const [header, b64] = dataUrl.split(",");
  const mime = header.replace(/^data:/, "").replace(/;base64$/, "");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  // Defensive: when MIME has no "/", fall back to a generic extension instead
  // of `undefined`.
  const ext = mime.includes("/") ? (mime.split("/")[1] ?? "bin") : "bin";
  return new File([bytes], `attachment.${ext}`, { type: mime });
}

export async function fileToDataUrl(file: File): Promise<string> {
  // `arrayBuffer()` is a native Blob method that resolves via microtasks
  // (not timers), so it works correctly even with `vi.useFakeTimers()`.
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Chunked binary→string conversion. The naive `binary += String.fromCharCode(b)`
  // loop is O(n) but accumulates a string one character at a time, which can
  // hit slow-path string concatenation in some engines for large buffers (a
  // 15 MB image was visibly janky pre-optimization). `apply` over 8 KB chunks
  // stays under any engine's argument-spread limit and is 5–10× faster.
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    // `apply` accepts an array-like — Uint8Array satisfies that contract.
    binary += String.fromCharCode.apply(null, chunk as unknown as ArrayLike<number> & number[]);
  }

  return `data:${file.type};base64,${btoa(binary)}`;
}
