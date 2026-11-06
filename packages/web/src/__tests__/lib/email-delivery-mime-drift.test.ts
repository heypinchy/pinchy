/**
 * Drift guard: pinchy-email decides, before it answers the model, whether the
 * attachment it just saved will show up in chat as a download chip. The web
 * side makes that decision for real (`deliverRunArtifacts` in
 * server/stream-pipe.ts, gated on SERVABLE_DELIVERED_MIMES). A plugin cannot
 * import from the web package — each plugin directory is mounted into the
 * OpenClaw container on its own — so the set is copied into
 * `pinchy-email/delivery-mime.ts` and pinned here.
 *
 * If the two disagree the agent says "delivered in chat" for a file that never
 * appears, or "can't be offered" for one that does.
 */
import { describe, it, expect } from "vitest";
import { SERVABLE_DELIVERED_MIMES } from "@/lib/serve-workspace-file";
import { EXTENSION_TO_MIME } from "@/lib/attachment-mime";
import {
  SERVABLE_DELIVERED_MIMES as PLUGIN_SERVABLE_MIMES,
  MIME_BY_EXTENSION,
} from "../../../../plugins/pinchy-email/delivery-mime";

describe("pinchy-email delivery-mime drift guard", () => {
  it("copies the web's servable set exactly", () => {
    expect([...PLUGIN_SERVABLE_MIMES].sort()).toEqual([...SERVABLE_DELIVERED_MIMES].sort());
  });

  it("maps every text extension the serving route knows to the same type", () => {
    for (const [ext, mime] of Object.entries(EXTENSION_TO_MIME)) {
      expect(MIME_BY_EXTENSION[ext], ext).toBe(mime);
    }
  });

  it("maps extensions only to servable types", () => {
    for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
      expect(SERVABLE_DELIVERED_MIMES.has(mime), `${ext} → ${mime}`).toBe(true);
    }
  });
});
