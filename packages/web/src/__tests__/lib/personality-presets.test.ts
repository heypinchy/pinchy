import { describe, it, expect } from "vitest";
import {
  PERSONALITY_PRESETS,
  getPersonalityPreset,
  resolveGreetingMessage,
} from "@/lib/personality-presets";

const EXPECTED_IDS = [
  "the-butler",
  "the-professor",
  "the-pilot",
  "the-coach",
  "the-analyst",
  "the-scout",
  "the-controller",
  "the-closer",
  "the-buyer",
  "the-concierge",
];

describe("PERSONALITY_PRESETS", () => {
  it("has exactly 10 presets", () => {
    expect(Object.keys(PERSONALITY_PRESETS)).toHaveLength(10);
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

  it("The Analyst suggests 'Quinn'", () => {
    expect(PERSONALITY_PRESETS["the-analyst"].suggestedAgentName).toBe("Quinn");
  });

  it("The Scout suggests 'Scout'", () => {
    expect(PERSONALITY_PRESETS["the-scout"].suggestedAgentName).toBe("Scout");
  });

  it("The Controller suggests 'Vera'", () => {
    expect(PERSONALITY_PRESETS["the-controller"].suggestedAgentName).toBe("Vera");
  });

  it("The Closer suggests 'Blake'", () => {
    expect(PERSONALITY_PRESETS["the-closer"].suggestedAgentName).toBe("Blake");
  });

  it("The Buyer suggests 'Morgan'", () => {
    expect(PERSONALITY_PRESETS["the-buyer"].suggestedAgentName).toBe("Morgan");
  });

  it("The Concierge suggests 'Robin'", () => {
    expect(PERSONALITY_PRESETS["the-concierge"].suggestedAgentName).toBe("Robin");
  });

  it("all odoo personality presets exist", () => {
    const ids = [
      "the-analyst",
      "the-scout",
      "the-controller",
      "the-closer",
      "the-buyer",
      "the-concierge",
    ];
    for (const id of ids) {
      expect(getPersonalityPreset(id)).toBeDefined();
    }
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
