import { describe, it, expect } from "vitest";
import { SERVER_WS_MAX_PAYLOAD_BYTES, CLIENT_MAX_IMAGE_SIZE_BYTES } from "@/lib/limits";

describe("WS frame limits — invariants", () => {
  it("server limit is at least 1.5× the client image limit (covers base64 + JSON overhead)", () => {
    // Base64 encoding adds ~33% overhead; the JSON envelope and additional
    // message parts add a bit more. 1.5× is a conservative floor — a single
    // 15 MB image becomes ~20 MB on the wire, comfortably below 25 MB.
    expect(SERVER_WS_MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(
      Math.ceil(CLIENT_MAX_IMAGE_SIZE_BYTES * 1.5)
    );
  });

  it("server limit is bounded to keep JSON.parse latency reasonable", () => {
    // 50 MB+ frames cause >100ms event-loop blocking on JSON.parse, starving
    // other requests on this single-threaded server. The current 25 MB target
    // is well under that ceiling.
    expect(SERVER_WS_MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
  });
});
