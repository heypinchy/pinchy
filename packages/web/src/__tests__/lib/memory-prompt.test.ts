import { describe, it, expect } from "vitest";
import { buildMemoryPromptBlock } from "@/lib/memory-prompt";

describe("buildMemoryPromptBlock", () => {
  it("returns a ## Memory block when the agent has pinchy_write", () => {
    const block = buildMemoryPromptBlock(["pinchy_write"]);
    expect(block).not.toBeNull();
    expect(block!).toContain("## Memory");
  });

  it("names pinchy_write as the write tool (the missing piece behind the hallucination)", () => {
    // The root cause of the production hallucination (#368): the agent knew
    // memory lived in MEMORY.md but not HOW to write it. The block must name
    // the write tool explicitly.
    const block = buildMemoryPromptBlock(["pinchy_write", "pinchy_read"]);
    expect(block!).toContain("pinchy_write");
  });

  it("points at both MEMORY.md and the memory/ daily-log location", () => {
    const block = buildMemoryPromptBlock(["pinchy_write"]);
    expect(block!).toContain("MEMORY.md");
    expect(block!).toContain("memory/");
  });

  it("names the read/recall tools so the agent can find what it stored", () => {
    const block = buildMemoryPromptBlock(["pinchy_write"]);
    expect(block!).toContain("memory_search");
  });

  it("clarifies that SOUL.md / AGENTS.md are platform-managed and not writable", () => {
    // Prevents the inverse failure: an agent trying to 'remember' by editing
    // its own instructions. It must know those are off-limits.
    const block = buildMemoryPromptBlock(["pinchy_write"]);
    expect(block!).toContain("SOUL.md");
    expect(block!).toContain("AGENTS.md");
  });

  it("returns null when the agent cannot write (no pinchy_write)", () => {
    // No write path → telling the agent it can persist memory would be a lie
    // and reproduce the hallucination from the other direction.
    expect(buildMemoryPromptBlock([])).toBeNull();
    expect(buildMemoryPromptBlock(["pinchy_read"])).toBeNull();
  });

  it("steers every write-capable agent to read its memory files with pinchy_read", () => {
    // memory_search rides on an embedding index that can be unavailable (prod:
    // default `openai` provider, no key → 0 chunks → the tool returns disabled).
    // Without a fallback the agent confabulates ("memory index unavailable, tell
    // me again"). A write-capable agent ALWAYS has pinchy_read/pinchy_ls with its
    // MEMORY.md + memory/ dir in allowed_paths (computeAllowedTools emits them for
    // every agent; build.ts grants the memory paths on write — verified in prod:
    // Penny's tools.allow + allowed_paths), so reading the files is a recall path
    // that always works. It must be told to use it.
    const block = buildMemoryPromptBlock(["pinchy_write"]);
    expect(block!).toContain("pinchy_read");
  });

  it("tells the agent to list memory/ with pinchy_ls to find topic notes", () => {
    // Topic notes (e.g. memory/helmcraft_odoo.md) aren't guessable by name;
    // the agent needs to list the directory to discover them.
    const block = buildMemoryPromptBlock(["pinchy_write"]);
    expect(block!).toContain("pinchy_ls");
  });

  it("frames memory_search as possibly unavailable so failure triggers the file fallback", () => {
    // The behavioural fix for the reported symptom: a memory_search that returns
    // 'unavailable' must route the agent to its files, not to a fabricated excuse.
    const block = buildMemoryPromptBlock(["pinchy_write"]);
    expect(block!.toLowerCase()).toContain("unavailable");
  });
});
