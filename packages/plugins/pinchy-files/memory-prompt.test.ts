import { describe, it, expect } from "vitest";
import { buildMemoryPromptBlock } from "./memory-prompt";

describe("buildMemoryPromptBlock", () => {
  it("returns a ## Memory block", () => {
    const block = buildMemoryPromptBlock();
    expect(block).toContain("## Memory");
  });

  it("names pinchy_write as the write tool (the missing piece behind the hallucination)", () => {
    // The root cause of the production hallucination (#368): the agent knew
    // memory lived in MEMORY.md but not HOW to write it. The block must name
    // the write tool explicitly.
    const block = buildMemoryPromptBlock();
    expect(block).toContain("pinchy_write");
  });

  it("points at both MEMORY.md and the memory/ daily-log location", () => {
    const block = buildMemoryPromptBlock();
    expect(block).toContain("MEMORY.md");
    expect(block).toContain("memory/");
  });

  it("names the read/recall tools so the agent can find what it stored", () => {
    const block = buildMemoryPromptBlock();
    expect(block).toContain("memory_search");
  });

  it("clarifies that SOUL.md / AGENTS.md are platform-managed and not writable", () => {
    // Prevents the inverse failure: an agent trying to 'remember' by editing
    // its own instructions. It must know those are off-limits.
    const block = buildMemoryPromptBlock();
    expect(block).toContain("SOUL.md");
    expect(block).toContain("AGENTS.md");
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
    const block = buildMemoryPromptBlock();
    expect(block).toContain("pinchy_read");
  });

  it("tells the agent to list memory/ with pinchy_ls to find topic notes", () => {
    // Topic notes (e.g. memory/helmcraft_odoo.md) aren't guessable by name;
    // the agent needs to list the directory to discover them.
    const block = buildMemoryPromptBlock();
    expect(block).toContain("pinchy_ls");
  });

  it("tells the agent to consult memory BEFORE answering, not after being challenged", () => {
    // The production symptom: a fresh session where MEMORY.md was injected and the
    // agent still answered from nothing, then corrected itself once the user asked
    // "you do know how we prioritise, right?". Naming the tools is not enough —
    // the block has to say WHEN to reach for them.
    const block = buildMemoryPromptBlock();
    expect(block).toMatch(/before you answer/i);
  });

  it("does not tell the agent to keep MEMORY.md as a pointer-only index", () => {
    // MEMORY.md is the only memory file OpenClaw injects at session start; the
    // notes under memory/ are not. Instructing the agent to keep the injected file
    // as pointers put every durable fact one tool call away from the answer — and
    // a model answers first and looks second. Regression guard on the old wording
    // ("Keep it as an index that points to your topic notes").
    const block = buildMemoryPromptBlock();
    expect(block).not.toMatch(/index that points/i);
  });

  it("routes a durable way of working to Instructions and offers to draft it", () => {
    // A scoring framework or standard procedure the user and agent settle on is a
    // rule, not a recollection. It belongs in AGENTS.md: reviewable, versioned, and
    // — decisively — present in scheduled and background runs, which OpenClaw
    // serves from a bootstrap set that excludes MEMORY.md
    // (filterBootstrapFilesForSession → MINIMAL_BOOTSTRAP_ALLOWLIST). The agent
    // cannot write Instructions itself, so the only path it has is to say so and
    // draft the wording for the user.
    const block = buildMemoryPromptBlock();
    expect(block).toContain("Instructions");
    expect(block).toMatch(/offer to draft/i);
    expect(block).toMatch(/scheduled|background/i);
  });

  it("tells the agent it can retire a note, not only overwrite it", () => {
    // Without a delete the only way to retire a topic note was a tombstone,
    // which stays indexed — and because non-dated files under memory/ are never
    // temporally decayed by OpenClaw, at permanently full weight in recall. The
    // block has to name the tool, or the agent keeps writing tombstones.
    const block = buildMemoryPromptBlock();
    expect(block).toContain("pinchy_delete");
  });

  it("points the delete at a topic note and rules MEMORY.md out", () => {
    // `MEMORY.md` is a write_paths entry in its own right, so pinchy_delete
    // reaches it — and it is the ONLY memory file OpenClaw loads at session
    // start. An agent that reads "remove the file" as covering it wipes its
    // whole durable store on a request to forget one thing. The zone is right
    // (whoever may overwrite may remove); the instruction has to be narrower
    // than the zone.
    const block = buildMemoryPromptBlock();
    expect(block).toMatch(/never delete `MEMORY\.md`/i);
    expect(block).toMatch(/topic note/i);
  });

  it("frames memory_search as possibly unavailable so failure triggers the file fallback", () => {
    // The behavioural fix for the reported symptom: a memory_search that returns
    // 'unavailable' must route the agent to its files, not to a fabricated excuse.
    const block = buildMemoryPromptBlock();
    expect(block.toLowerCase()).toContain("unavailable");
  });

  it("tells a scheduled run that MEMORY.md was not loaded into it", () => {
    // OpenClaw serves cron and subagent sessions in "minimal" prompt mode, whose
    // bootstrap set (MINIMAL_BOOTSTRAP_ALLOWLIST) has no MEMORY.md. The normal
    // block says MEMORY.md is loaded automatically at the start of a
    // conversation; an agent left to assume that holds for this run too answers
    // from a memory it never read.
    const block = buildMemoryPromptBlock("agent:a1:cron:nightly-report");
    expect(block).toMatch(/`MEMORY\.md` was not loaded into it\. Read it with `pinchy_read`/);
  });

  it("treats a subagent session like a scheduled one", () => {
    const block = buildMemoryPromptBlock("agent:a1:subagent:abc");
    expect(block).toMatch(/was not loaded/i);
  });

  it("does not count a bare agent:<id>:cron key as a scheduled run", () => {
    // OpenClaw's isCronSessionKey wants `cron:` after the agent id, with a job.
    expect(buildMemoryPromptBlock("agent:a1:cron")).not.toMatch(/was not loaded/i);
  });

  it.each([
    "agent:a1:telegram:group:-100123",
    "agent:a1:telegram:default:group:-100123",
    "agent:a1:discord:channel:42",
    "agent:a1:group:abc",
  ])("keeps memory out of a chat others read (%s)", (key) => {
    // OpenClaw leaves MEMORY.md out of group and channel sessions so a shared
    // agent does not tell a group what it learned in one-to-one chats
    // (filterBootstrapFilesForSession). The normal block would undo that: it
    // says MEMORY.md is loaded and to read memory before every answer.
    const block = buildMemoryPromptBlock(key);
    expect(block).toMatch(/^## Memory/);
    expect(block).toMatch(/group chat or channel/);
    expect(block).toMatch(/Don't search or read your memory here/);
    expect(block).not.toMatch(/loaded automatically/i);
    expect(block).not.toMatch(/Before you answer/);
  });

  it("keeps the normal wording for every full-bootstrap session", () => {
    // Web chat, Telegram DM, inbox workflow run: OpenClaw loads MEMORY.md for
    // all of them, so the block may say so.
    for (const key of [
      undefined,
      "agent:a1:direct:u1",
      "agent:a1:direct:u1:chat:c1",
      "agent:a1:inbox:ledger-1",
      "agent:a1:main",
      "agent:a1:telegram:direct:42",
      "agent:a1:telegram:default:direct:42",
    ]) {
      const block = buildMemoryPromptBlock(key);
      expect(block, String(key)).toMatch(/loaded automatically/i);
      expect(block, String(key)).not.toMatch(/was not loaded/i);
    }
  });
});
