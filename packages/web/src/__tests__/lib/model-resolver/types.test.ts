import { describe, it, expectTypeOf } from "vitest";
import type { ModelCapability } from "@/lib/model-resolver/types";

describe("ModelCapability", () => {
  it("includes only capabilities with real consumers — vision (direct image input) and traits", () => {
    // documents/audio/video were removed: PDFs route via OpenClaw's pdf tool
    // (no agent-model capability involved) and audio/video files are not
    // uploadable at all (see ALLOWED_ATTACHMENT_MIMES, #321).
    expectTypeOf<ModelCapability>().toEqualTypeOf<"vision" | "long-context" | "tools">();
  });
});
