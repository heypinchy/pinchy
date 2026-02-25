import { describe, it, expect } from "vitest";
import {
  PERSONALITY_PRESETS,
  getPersonalityPreset,
  resolveGreetingMessage,
} from "@/lib/personality-presets";

const EXPECTED_IDS = ["the-butler", "the-professor", "the-pilot", "the-coach"];

describe("PERSONALITY_PRESETS", () => {
  it("has exactly 4 presets", () => {
    expect(Object.keys(PERSONALITY_PRESETS)).toHaveLength(4);
  });

  it.each(EXPECTED_IDS)("has preset '%s'", (id) => {
    expect(PERSONALITY_PRESETS[id]).toBeDefined();
  });

  it.each(EXPECTED_IDS)("preset '%s' has all required fields", (id) => {
    const preset = PERSONALITY_PRESETS[id];
    expect(preset.id).toBe(id);
    expect(preset.name).toBeTruthy();
    expect(preset.suggestedAgentName).toBeTruthy();
    expect(preset.tagline).toBeTruthy();
    expect(preset.description).toBeTruthy();
    expect(preset.soulMd.length).toBeGreaterThan(100);
    expect(preset.avatarSeed).toBeTruthy();
  });

  it("The Butler suggests 'Smithers'", () => {
    expect(PERSONALITY_PRESETS["the-butler"].suggestedAgentName).toBe("Smithers");
  });

  it("The Professor suggests 'Ada'", () => {
    expect(PERSONALITY_PRESETS["the-professor"].suggestedAgentName).toBe("Ada");
  });

  it("The Pilot suggests 'Jet'", () => {
    expect(PERSONALITY_PRESETS["the-pilot"].suggestedAgentName).toBe("Jet");
  });

  it("The Coach suggests 'Maya'", () => {
    expect(PERSONALITY_PRESETS["the-coach"].suggestedAgentName).toBe("Maya");
  });
});

describe("getPersonalityPreset", () => {
  it("returns the correct preset by id", () => {
    expect(getPersonalityPreset("the-butler")).toBe(PERSONALITY_PRESETS["the-butler"]);
  });

  it("returns undefined for unknown id", () => {
    expect(getPersonalityPreset("nonexistent")).toBeUndefined();
  });
});

describe("resolveGreetingMessage", () => {
  it("replaces {name} placeholder with agent name", () => {
    const result = resolveGreetingMessage("Good day. I'm {name}. How may I help?", "Smithers");
    expect(result).toBe("Good day. I'm Smithers. How may I help?");
  });

  it("returns null when greeting is null", () => {
    expect(resolveGreetingMessage(null, "Jet")).toBeNull();
  });

  it("returns greeting unchanged when no placeholder present", () => {
    expect(resolveGreetingMessage("Hello!", "Ada")).toBe("Hello!");
  });

  it("preset greeting messages contain {name} placeholder", () => {
    for (const preset of Object.values(PERSONALITY_PRESETS)) {
      if (preset.greetingMessage) {
        expect(preset.greetingMessage).toContain("{name}");
      }
    }
  });
});
