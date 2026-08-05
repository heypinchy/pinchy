import { describe, it, expect } from "vitest";
import { buildMemoryPromptBlock } from "@/lib/memory-prompt";

describe("buildMemoryPromptBlock", () => {
  it("returns a ## Memory block when the agent has pinchy_write", () => {
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block).not.toBeNull();
    expect(block!).toContain("## Memory");
  });

  it("names pinchy_write as the write tool (the missing piece behind the hallucination)", () => {
    // The root cause of the production hallucination (#368): the agent knew
    // memory lived in MEMORY.md but not HOW to write it. The block must name
    // the write tool explicitly.
    const block = buildMemoryPromptBlock(["pinchy_memory", "pinchy_write", "pinchy_read"]);
    expect(block!).toContain("pinchy_write");
  });

  it("points at both MEMORY.md and the memory/ daily-log location", () => {
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).toContain("MEMORY.md");
    expect(block!).toContain("memory/");
  });

  it("names the read/recall tools so the agent can find what it stored", () => {
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).toContain("memory_search");
  });

  it("clarifies that SOUL.md / AGENTS.md are platform-managed and not writable", () => {
    // Prevents the inverse failure: an agent trying to 'remember' by editing
    // its own instructions. It must know those are off-limits.
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).toContain("SOUL.md");
    expect(block!).toContain("AGENTS.md");
  });

  it("returns null when the agent has no memory grant", () => {
    // No memory path → telling the agent it can persist memory would be a lie
    // and reproduce the hallucination from the other direction.
    expect(buildMemoryPromptBlock([])).toBeNull();
    expect(buildMemoryPromptBlock(["pinchy_read"])).toBeNull();
  });

  it("returns null for a file-writing agent that was never granted memory", () => {
    // pinchy_write reaches workbench/ and nothing else. Before memory became
    // its own grant this was the one thing that DID produce the block, which is
    // how the two got conflated in the first place (#755).
    expect(buildMemoryPromptBlock(["pinchy_write"])).toBeNull();
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
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).toContain("pinchy_read");
  });

  it("tells the agent to list memory/ with pinchy_ls to find topic notes", () => {
    // Topic notes (e.g. memory/helmcraft_odoo.md) aren't guessable by name;
    // the agent needs to list the directory to discover them.
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).toContain("pinchy_ls");
  });

  it("tells the agent to consult memory BEFORE answering, not after being challenged", () => {
    // The production symptom: a fresh session where MEMORY.md was injected and the
    // agent still answered from nothing, then corrected itself once the user asked
    // "you do know how we prioritise, right?". Naming the tools is not enough —
    // the block has to say WHEN to reach for them.
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).toMatch(/before you answer/i);
  });

  it("does not tell the agent to keep MEMORY.md as a pointer-only index", () => {
    // MEMORY.md is the only memory file OpenClaw injects at session start; the
    // notes under memory/ are not. Instructing the agent to keep the injected file
    // as pointers put every durable fact one tool call away from the answer — and
    // a model answers first and looks second. Regression guard on the old wording
    // ("Keep it as an index that points to your topic notes").
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).not.toMatch(/index that points/i);
  });

  it("routes a durable way of working to Instructions and offers to draft it", () => {
    // A scoring framework or standard procedure the user and agent settle on is a
    // rule, not a recollection. It belongs in AGENTS.md: reviewable, versioned, and
    // — decisively — present in scheduled and background runs, which OpenClaw
    // serves from a bootstrap set that excludes MEMORY.md
    // (filterBootstrapFilesForSession → MINIMAL_BOOTSTRAP_ALLOWLIST). The agent
    // cannot write Instructions itself, so the only path it has is to say so and
    // draft the wording for the user.
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!).toContain("Instructions");
    expect(block!).toMatch(/offer to draft/i);
    expect(block!).toMatch(/scheduled|background/i);
  });

  it("frames memory_search as possibly unavailable so failure triggers the file fallback", () => {
    // The behavioural fix for the reported symptom: a memory_search that returns
    // 'unavailable' must route the agent to its files, not to a fabricated excuse.
    const block = buildMemoryPromptBlock(["pinchy_memory"]);
    expect(block!.toLowerCase()).toContain("unavailable");
  });
});
