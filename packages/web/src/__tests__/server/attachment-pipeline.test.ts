import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
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

// Minimal valid PDF header (enough for file-type detection)
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(128, 0)]);
const PDF_BASE64 = PDF.toString("base64");

// Minimal valid PNG header (with IHDR chunk for file-type detection)
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  // IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4) + bit_depth(1) + color_type(1) + compression(1) + filter(1) + interlace(1) + crc(4)
  Buffer.from([
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]),
  Buffer.alloc(64, 0),
]);
const PNG_BASE64 = PNG.toString("base64");

describe("processIncomingAttachments", () => {
  it("persists a PDF to workspace only (no inline attachment)", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");
    const result = await processIncomingAttachments({
      agentId: "agent-1",
      contentParts: [
        {
          type: "image_url",
          image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` },
        },
      ],
      claimedFilenames: ["invoice.pdf"],
    });

    expect(result.chatAttachments).toHaveLength(0);
    expect(result.workspaceRefs).toEqual([
      expect.objectContaining({
        relativePath: "uploads/invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF.length,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        reused: false,
      }),
    ]);
    expect(existsSync(join(tmpRoot, "agent-1/uploads/invoice.pdf"))).toBe(true);
  });

  it("handles multiple attachments in one message", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");
    const result = await processIncomingAttachments({
      agentId: "agent-1",
      contentParts: [
        { type: "image_url", image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` } },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ],
      claimedFilenames: ["a.pdf", "b.png"],
    });
    expect(result.chatAttachments).toHaveLength(1);
    expect(result.workspaceRefs).toHaveLength(2);
  });

  it("rejects MIME mismatch", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");
    await expect(
      processIncomingAttachments({
        agentId: "agent-1",
        contentParts: [
          {
            type: "image_url",
            image_url: { url: `data:application/pdf;base64,${PNG_BASE64}` },
          },
        ],
        claimedFilenames: ["fake.pdf"],
      })
    ).rejects.toThrow(/mismatch/i);
  });

  it("defaults filename to 'upload' when claimedFilenames is absent", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");
    const result = await processIncomingAttachments({
      agentId: "agent-1",
      contentParts: [
        { type: "image_url", image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` } },
      ],
    });
    expect(result.workspaceRefs[0].relativePath).toMatch(/^uploads\//);
    expect(existsSync(join(tmpRoot, "agent-1/uploads"))).toBe(true);
  });

  // Regression: a mixed image+PDF message sends `filenames = ["", "doc.pdf"]`
  // because images don't carry a meaningful filename. The empty-string slot
  // must fall back to "upload" — `??` alone won't, since "" is not nullish.
  it("treats empty/whitespace claimed filenames as 'upload' (mixed-attachment regression)", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");
    const result = await processIncomingAttachments({
      agentId: "agent-1",
      contentParts: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        { type: "image_url", image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` } },
      ],
      claimedFilenames: ["", "report.pdf"],
    });
    expect(result.workspaceRefs).toHaveLength(2);
    expect(result.workspaceRefs[0].relativePath).toBe("uploads/upload");
    expect(result.workspaceRefs[1].relativePath).toBe("uploads/report.pdf");
  });

  it("treats whitespace-only claimed filename as 'upload'", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");
    const result = await processIncomingAttachments({
      agentId: "agent-1",
      contentParts: [
        { type: "image_url", image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` } },
      ],
      claimedFilenames: ["   "],
    });
    expect(result.workspaceRefs[0].relativePath).toBe("uploads/upload");
  });
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

  it("returns empty string when no uploads", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    expect(buildAttachmentBlock([])).toBe("");
  });

  // sanitizeFilename allows backticks, which would break the markdown code
  // span that wraps the path in the block — and could let a crafted filename
  // leak structure into the message sent to the LLM.
  it("escapes backticks in workspace paths so they cannot break the markdown code span", async () => {
    const { buildAttachmentBlock } = await import("@/server/attachment-pipeline");
    const block = buildAttachmentBlock([
      {
        relativePath: "uploads/foo`bar`.pdf",
        absolutePath: "/root/.openclaw/workspaces/test/uploads/foo`bar`.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        contentHash: "a".repeat(64),
        reused: false,
      },
    ]);
    // The path is wrapped in a single ` … ` code span. After escaping,
    // the path segment itself must not contain any backticks — they are
    // replaced with the visually-similar U+02BC apostrophe.
    const lineWithPath = block.split("\n").find((l) => l.includes("uploads/foo")) ?? "";
    // Extract just the code-span content (text between the first pair of backticks)
    const codeSpanMatch = lineWithPath.match(/`([^`]*)`/);
    const pathInCodeSpan = codeSpanMatch?.[1] ?? "";
    expect(pathInCodeSpan).not.toContain("`");
    // The original filename text must still be recognisable to the agent.
    expect(lineWithPath).toMatch(/foo.+bar.+\.pdf/);
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

describe("UploadValidationError", () => {
  it("is thrown for a MIME mismatch (client-input error, safe to surface)", async () => {
    const { processIncomingAttachments, UploadValidationError } =
      await import("@/server/attachment-pipeline");
    await expect(
      processIncomingAttachments({
        agentId: "agent-1",
        contentParts: [
          {
            type: "image_url",
            image_url: { url: `data:application/pdf;base64,${PNG_BASE64}` },
          },
        ],
        claimedFilenames: ["wrong.pdf"],
      })
    ).rejects.toBeInstanceOf(UploadValidationError);
  });

  it("is thrown for an invalid filename (client-input error)", async () => {
    const { processIncomingAttachments, UploadValidationError } =
      await import("@/server/attachment-pipeline");
    await expect(
      processIncomingAttachments({
        agentId: "agent-1",
        contentParts: [
          {
            type: "image_url",
            image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` },
          },
        ],
        claimedFilenames: ["foo\0.pdf"],
      })
    ).rejects.toBeInstanceOf(UploadValidationError);
  });
});
