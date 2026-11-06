/**
 * Reads a request body into memory, refusing to buffer more than `maxBytes`.
 *
 * `req.formData()` / `req.arrayBuffer()` buffer the whole body before any size
 * check can run, so a caller bounds it here first. Content-Length can be absent
 * (chunked) or wrong, so the limit is enforced on the bytes actually read: the
 * stream is cancelled the moment the running total passes `maxBytes`.
 *
 * Returns `null` when the body exceeds the limit.
 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
