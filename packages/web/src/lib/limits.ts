/**
 * Maximum WebSocket frame size accepted by the Pinchy WS server.
 * Frames larger than this are rejected by the `ws` library with close code
 * 1009 ("Message too big"), which surfaces in the UI as "Connection lost".
 *
 * Must be substantially larger than CLIENT_MAX_IMAGE_SIZE_BYTES so that a
 * legitimate client image (already validated client-side) never exceeds the
 * server limit even after base64 encoding (+33 %) and JSON envelope overhead.
 *
 * The lib/__tests__/limits.test.ts invariant test enforces this gap.
 */
export const SERVER_WS_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Maximum raw image size accepted by the chat composer client-side.
 * Raised from the original 5 MB limit (set when only API providers were used)
 * to cover modern smartphone photos.
 */
export const CLIENT_MAX_IMAGE_SIZE_BYTES = 15 * 1024 * 1024;

export const CLIENT_IMAGE_COMPRESSION_TARGET_BYTES = 1_900_000;

export const CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES = 500 * 1024;

export const CLIENT_IMAGE_COMPRESSION_MAX_DIMENSION = 2560;

export const CLIENT_IMAGE_COMPRESSION_QUALITY = 0.85;
