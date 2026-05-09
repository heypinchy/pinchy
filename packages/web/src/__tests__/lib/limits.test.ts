import { describe, it, expect } from "vitest";
import {
  SERVER_WS_MAX_PAYLOAD_BYTES,
  CLIENT_MAX_ATTACHMENT_SIZE_BYTES,
  CLIENT_IMAGE_COMPRESSION_TARGET_BYTES,
  CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES,
} from "@/lib/limits";

describe("WS frame limits — invariants", () => {
  it("server limit is at least 1.5× the client attachment limit (covers base64 + JSON overhead)", () => {
    // Base64 encoding adds ~33% overhead; the JSON envelope and additional
    // message parts add a bit more. 1.5× is a conservative floor — a single
    // 15 MB attachment becomes ~20 MB on the wire, comfortably below 25 MB.
    expect(SERVER_WS_MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(
      Math.ceil(CLIENT_MAX_ATTACHMENT_SIZE_BYTES * 1.5)
    );
  });

  it("server limit is bounded to keep JSON.parse latency reasonable", () => {
    // 50 MB+ frames cause >100ms event-loop blocking on JSON.parse, starving
    // other requests on this single-threaded server. The current 25 MB target
    // is well under that ceiling.
    expect(SERVER_WS_MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
  });

  it("client compression target leaves headroom under OpenClaw's 2 MB inline-vs-offload threshold", () => {
    // OpenClaw 2026.4.27 hardcodes OFFLOAD_THRESHOLD_BYTES = 2_000_000
    // Anything > that is offloaded as a text marker the agent runner does not
    // reliably re-inline for agent.run. We target 1.9 MB so compression
    // overshoot of up to ~100 KB still lands inline.
    const OPENCLAW_OFFLOAD_THRESHOLD_BYTES = 2 * 1000 * 1000;
    expect(CLIENT_IMAGE_COMPRESSION_TARGET_BYTES).toBeLessThan(OPENCLAW_OFFLOAD_THRESHOLD_BYTES);
    // At least 50 KB of headroom — the library's maxSizeMB is best-effort.
    expect(
      OPENCLAW_OFFLOAD_THRESHOLD_BYTES - CLIENT_IMAGE_COMPRESSION_TARGET_BYTES
    ).toBeGreaterThanOrEqual(50 * 1024);
  });

  it("compression skip threshold is below the target so the skip path actually skips", () => {
    expect(CLIENT_IMAGE_COMPRESSION_SKIP_BELOW_BYTES).toBeLessThan(
      CLIENT_IMAGE_COMPRESSION_TARGET_BYTES
    );
  });
});
