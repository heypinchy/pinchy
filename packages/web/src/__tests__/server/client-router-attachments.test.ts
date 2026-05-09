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
  it("persists a PDF and emits inline ChatAttachment + workspace ref", async () => {
    const { processIncomingAttachments } = await import("@/server/client-router");
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

    expect(result.chatAttachments).toHaveLength(1);
    expect(result.chatAttachments[0]).toMatchObject({
      mimeType: "application/pdf",
      content: PDF_BASE64,
    });
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
    const { processIncomingAttachments } = await import("@/server/client-router");
    const result = await processIncomingAttachments({
      agentId: "agent-1",
      contentParts: [
        { type: "image_url", image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` } },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ],
      claimedFilenames: ["a.pdf", "b.png"],
    });
    expect(result.chatAttachments).toHaveLength(2);
    expect(result.workspaceRefs).toHaveLength(2);
  });

  it("rejects MIME mismatch", async () => {
    const { processIncomingAttachments } = await import("@/server/client-router");
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
    const { processIncomingAttachments } = await import("@/server/client-router");
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
    const { processIncomingAttachments } = await import("@/server/client-router");
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
    const { processIncomingAttachments } = await import("@/server/client-router");
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

describe("buildUploadHint", () => {
  it("renders a system-prompt block listing the uploads", async () => {
    const { buildUploadHint } = await import("@/server/client-router");
    const block = buildUploadHint([
      {
        relativePath: "uploads/invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 245_000,
        contentHash: "a".repeat(64),
        reused: false,
      },
    ]);
    expect(block).toContain("uploads/invoice.pdf");
    expect(block).toContain("application/pdf");
    expect(block).toMatch(/uploaded/i);
  });

  it("returns empty string when no uploads", async () => {
    const { buildUploadHint } = await import("@/server/client-router");
    expect(buildUploadHint([])).toBe("");
  });

  // sanitizeFilename allows backticks, which would break the markdown code
  // span that wraps the path in the system prompt — and could let a crafted
  // filename leak structure into the prompt sent to the LLM.
  it("escapes backticks in workspace paths so they cannot break the markdown code span", async () => {
    const { buildUploadHint } = await import("@/server/client-router");
    const block = buildUploadHint([
      {
        relativePath: "uploads/foo`bar`.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        contentHash: "a".repeat(64),
        reused: false,
      },
    ]);
    // Each line wraps the path in a single ` … ` code span. After escaping,
    // the only backticks remaining must be the two delimiters per line.
    const lineWithPath = block.split("\n").find((l) => l.includes("uploads/foo")) ?? "";
    const backtickCount = (lineWithPath.match(/`/g) ?? []).length;
    expect(backtickCount).toBe(2);
    // The original filename text must still be recognisable to the agent.
    expect(lineWithPath).toMatch(/foo.+bar.+\.pdf/);
  });
});
