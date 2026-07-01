import { describe, expect, it } from "vitest";
import {
  requiredCapabilityForFile,
  imageInputNote,
  IMAGE_INPUT_OFFLOAD_NOTE,
} from "@/lib/attachment-capability";

describe("requiredCapabilityForFile", () => {
  it("requires vision for image attachments — images ship base64 as direct model input", () => {
    expect(requiredCapabilityForFile("image/png")).toBe("vision");
    expect(requiredCapabilityForFile("image/jpeg")).toBe("vision");
    expect(requiredCapabilityForFile("image/heic")).toBe("vision");
  });

  it("requires no capability for PDFs — they route via OpenClaw's pdf tool, whose model Pinchy resolves independently of the agent model", () => {
    expect(requiredCapabilityForFile("application/pdf")).toBeNull();
  });

  it("requires no capability for text formats — they are workspace files read via pinchy_read", () => {
    expect(requiredCapabilityForFile("text/plain")).toBeNull();
    expect(requiredCapabilityForFile("text/csv")).toBeNull();
    expect(requiredCapabilityForFile("application/json")).toBeNull();
  });
});

describe("imageInputNote", () => {
  // Staging finding: a text-only agent model (GLM 5.2) showed the flat warning
  // "This model doesn't support image input." yet returned a correct image
  // description — because Pinchy offloads the image to the configured vision
  // model (resolveImageTurnModel). The note must reflect that offload, not
  // contradict the outcome the user sees.

  it("notes the vision-model offload when the agent's model can't read images itself", () => {
    expect(imageInputNote("image/png", false)).toBe(IMAGE_INPUT_OFFLOAD_NOTE);
    // Honest, not a flat "doesn't support" — the image usually still works.
    expect(IMAGE_INPUT_OFFLOAD_NOTE).not.toMatch(/doesn't support/i);
    expect(IMAGE_INPUT_OFFLOAD_NOTE).toMatch(/vision model/i);
  });

  it("shows no note when the agent's model IS vision-capable", () => {
    expect(imageInputNote("image/png", true)).toBeNull();
  });

  it("shows no note before capabilities have loaded (unknown vision support)", () => {
    // modelCapabilities is null/undefined until /api/models/capabilities resolves.
    expect(imageInputNote("image/png", null)).toBeNull();
    expect(imageInputNote("image/png", undefined)).toBeNull();
  });

  it("shows no note for non-image files (PDFs/text route via pinchy_read)", () => {
    expect(imageInputNote("application/pdf", false)).toBeNull();
    expect(imageInputNote("text/plain", false)).toBeNull();
  });
});
