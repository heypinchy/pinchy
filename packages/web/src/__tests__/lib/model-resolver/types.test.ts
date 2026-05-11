import { describe, it, expectTypeOf } from "vitest";
import type { ModelCapability } from "@/lib/model-resolver/types";

describe("ModelCapability", () => {
  it("includes all input modalities and traits", () => {
    expectTypeOf<ModelCapability>().toEqualTypeOf<
      "vision" | "documents" | "audio" | "video" | "long-context" | "tools"
    >();
  });
});
