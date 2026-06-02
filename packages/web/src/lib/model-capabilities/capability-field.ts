/**
 * Maps a `ModelCapability` string to its corresponding field in a
 * `ModelCapabilities` object. The mapping is explicit — no unsafe string-cast
 * — so adding a new capability forces a compile-time update here.
 *
 * This module is intentionally kept free of any server-side imports (no DB,
 * no Node.js built-ins) so it can be used safely in client components.
 */

import type { ModelCapability } from "@/lib/model-resolver/types";
import type { ModelCapabilities } from "@/lib/model-capabilities/types";

export function capabilityField(caps: ModelCapabilities, cap: ModelCapability): boolean {
  switch (cap) {
    case "vision":
      return caps.vision;
    case "documents":
      return caps.documents;
    case "audio":
      return caps.audio;
    case "video":
      return caps.video;
    case "long-context":
      return caps.longContext;
    case "tools":
      return caps.tools;
  }
}
