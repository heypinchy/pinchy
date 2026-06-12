import type { ModelCapability } from "@/lib/model-resolver/types";

export function parseUnsupportedAttachmentError(
  msg: string
): { capability: ModelCapability } | null {
  if (msg.includes("does not accept image inputs")) return { capability: "vision" };
  return null;
}
