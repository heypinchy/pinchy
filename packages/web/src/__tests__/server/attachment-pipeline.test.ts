import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-router-attach-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildAttachmentBlock", () => {
  it("renders a <pinchy:attachments> block listing the uploads", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/invoice.pdf",
        absolutePath: "/root/.openclaw/workspaces/test/uploads/invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 245_000,
        contentHash: "a".repeat(64),
        reused: false,
      },
    ]);
    // Wrapped in custom XML-style tag so the strip/parse step on the display
    // side has a unique, unambiguous boundary — markdown headings would clash
    // with user-typed text.
    expect(block).toMatch(/^<pinchy:attachments>/);
    expect(block).toMatch(/<\/pinchy:attachments>$/);
    expect(block).toContain("uploads/invoice.pdf");
    expect(block).toContain("application/pdf");
  });

  it("routes PDFs to `pinchy_read`, not OpenClaw's built-in `pdf` tool", async () => {
    // The OpenClaw built-in `pdf` tool resolves its model only against the
    // per-agent models.json catalog (which never contains built-in providers
    // like anthropic/openai), so it fails "Unknown model" for the common case.
    // pinchy-files' own pinchy_read has a full, tested PDF subsystem
    // (pdf-extract for text, pdf-vision for scans) that resolves credentials
    // via the runtime modelAuth API — it works on every provider/model. PDFs
    // must be analyzed with pinchy_read.
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/statement.pdf",
        absolutePath: "/root/.openclaw/workspaces/test/uploads/statement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 120_000,
        contentHash: "b".repeat(64),
        reused: false,
      },
    ]);
    expect(block).toContain("analyze with `pinchy_read`");
    expect(block).not.toContain("analyze with `pdf`");
  });

  it("returns empty string when no uploads", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    expect(buildAttachmentBlock([])).toBe("");
  });

  // Backticks are rejected by sanitizeFilename — they can never reach this
  // function via the upload pipeline. But buildAttachmentBlock is also
  // exported, and a future caller could pass a hand-built ref. If a backtick
  // somehow lands in the absolute path, the markdown code span would break
  // and let crafted filename text leak into the message structure the LLM
  // reads. Fail loud (throw) rather than silently substituting characters
  // and corrupting the on-disk path the agent must call its tool with.
  it("throws when absolutePath contains a backtick (defense-in-depth contract)", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    expect(() =>
      buildAttachmentBlock([
        {
          relativePath: "uploads/foo`bar`.pdf",
          absolutePath: "/root/.openclaw/workspaces/test/uploads/foo`bar`.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          contentHash: "a".repeat(64),
          reused: false,
        },
      ])
    ).toThrow(/backtick/i);
  });

  it("tells the agent which built-in tool to call and uses the absolute workspace path", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/invoice.pdf",
        absolutePath: "/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 50_000,
        contentHash: "a".repeat(64),
        reused: false,
      },
      {
        relativePath: "uploads/photo.png",
        absolutePath: "/root/.openclaw/workspaces/agent-1/uploads/photo.png",
        mimeType: "image/png",
        sizeBytes: 30_000,
        contentHash: "b".repeat(64),
        reused: false,
      },
    ]);
    // Must reference the actual built-in tool names
    expect(block).toMatch(/\bpdf\b/);
    expect(block).toMatch(/\bimage\b/);
    // Must use the absolute workspace path (not relative)
    expect(block).toContain("/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf");
    expect(block).toContain("/root/.openclaw/workspaces/agent-1/uploads/photo.png");
  });

  it("reminds the agent to pass exact paths to sub-agents (not from memory)", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/invoice.pdf",
        absolutePath: "/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 50_000,
        contentHash: "a".repeat(64),
        reused: false,
      },
    ]);
    // Must remind agent to pass exact paths to sub-agents
    expect(block.toLowerCase()).toMatch(/sub.?agent|subagent|delegate/);
    expect(block.toLowerCase()).toMatch(/exact path|exact paths/);
  });

  // The previous implementation silently fell back to a vague "the
  // appropriate built-in tool" string for any MIME outside PDF/image. That
  // would leave the agent guessing on a future MIME we forgot to wire.
  it("throws when given a MIME type with no registered built-in tool", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    expect(() =>
      buildAttachmentBlock([
        {
          relativePath: "uploads/song.flac",
          absolutePath: "/root/.openclaw/workspaces/agent-1/uploads/song.flac",
          mimeType: "audio/flac",
          sizeBytes: 1_000_000,
          contentHash: "c".repeat(64),
          reused: false,
        },
      ])
    ).toThrow(/no built-in tool/i);
  });
});

describe("parseAttachmentBlock", () => {
  it("returns input unchanged + empty list when no block present", async () => {
    const { parseAttachmentBlock } = await import("@/server/attachment-pipeline");
    const result = parseAttachmentBlock("Just a normal message.");
    expect(result.cleanText).toBe("Just a normal message.");
    expect(result.attachments).toEqual([]);
  });

  it("strips a trailing block and returns the parsed attachments", async () => {
    const { buildAttachmentBlock, parseAttachmentBlock } =
      await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/invoice.pdf",
        absolutePath: "/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 245_000,
        contentHash: "a".repeat(64),
        reused: false,
      },
    ]);
    const text = `Was steht in dieser Datei?\n\n${block}`;
    const result = parseAttachmentBlock(text);
    // The block (and the blank line that separates it from the user text)
    // must be removed cleanly so the user only sees what they typed.
    expect(result.cleanText).toBe("Was steht in dieser Datei?");
    expect(result.attachments).toEqual([
      {
        path: "/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("parses multiple attachments in order", async () => {
    const { buildAttachmentBlock, parseAttachmentBlock } =
      await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/a.pdf",
        absolutePath: "/ws/agent-1/uploads/a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1000,
        contentHash: "a".repeat(64),
        reused: false,
      },
      {
        relativePath: "uploads/b.png",
        absolutePath: "/ws/agent-1/uploads/b.png",
        mimeType: "image/png",
        sizeBytes: 500,
        contentHash: "b".repeat(64),
        reused: false,
      },
    ]);
    const result = parseAttachmentBlock(`hi\n\n${block}`);
    expect(result.cleanText).toBe("hi");
    expect(result.attachments.map((a) => a.filename)).toEqual(["a.pdf", "b.png"]);
    expect(result.attachments.map((a) => a.mimeType)).toEqual(["application/pdf", "image/png"]);
  });

  it("is idempotent: parsing already-clean text is a no-op", async () => {
    const { parseAttachmentBlock } = await import("@/server/attachment-pipeline");
    const result = parseAttachmentBlock("clean text");
    expect(parseAttachmentBlock(result.cleanText).cleanText).toBe("clean text");
  });

  it("handles a malformed (unterminated) block by leaving text unchanged", async () => {
    // We don't want a stray opening tag from a future format change to silently
    // eat half the user's message. If the closing tag is missing the parser
    // refuses to strip — better to show garbage once than to lose data.
    const { parseAttachmentBlock } = await import("@/server/attachment-pipeline");
    const broken = "user text\n\n<pinchy:attachments>\n- /no/end";
    const result = parseAttachmentBlock(broken);
    expect(result.cleanText).toBe(broken);
    expect(result.attachments).toEqual([]);
  });

  it("preserves filenames containing spaces and parentheses", async () => {
    const { buildAttachmentBlock, parseAttachmentBlock } =
      await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/Profile (38).pdf",
        absolutePath: "/ws/agent-1/uploads/Profile (38).pdf",
        mimeType: "application/pdf",
        sizeBytes: 1000,
        contentHash: "a".repeat(64),
        reused: false,
      },
    ]);
    const result = parseAttachmentBlock(`hi\n\n${block}`);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("Profile (38).pdf");
    expect(result.attachments[0].path).toBe("/ws/agent-1/uploads/Profile (38).pdf");
  });
});
