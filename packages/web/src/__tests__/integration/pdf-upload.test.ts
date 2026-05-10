import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-pdf-upload-integration-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

// Minimal valid PDF header (enough for file-type detection)
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(128, 0)]);
const PDF_BASE64 = PDF.toString("base64");

// Minimal valid PNG header
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]),
  Buffer.alloc(64, 0),
]);
const PNG_BASE64 = PNG.toString("base64");

describe("PDF upload contract — OpenClaw chat() call shape", () => {
  it("does not include PDFs as inline attachments — workspace-only via pdf tool", async () => {
    const { processIncomingAttachments, buildAttachmentBlock } =
      await import("@/server/attachment-pipeline");

    const result = await processIncomingAttachments({
      agentId: "agent-pdf-contract",
      contentParts: [
        {
          type: "image_url",
          image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` },
        },
      ],
      claimedFilenames: ["report.pdf"],
    });

    // Contract: PDF must NOT be in chatAttachments — OpenClaw's agent
    // entrypoint rejects non-image inline attachments (acceptNonImage: false).
    // The agent reads the PDF via the built-in `pdf` tool from the workspace.
    expect(result.chatAttachments).toHaveLength(0);

    // Workspace ref must be present with the absolute path
    expect(result.workspaceRefs).toHaveLength(1);
    const ref = result.workspaceRefs[0];
    expect(ref.relativePath).toBe("uploads/report.pdf");
    expect(ref.absolutePath).toMatch(
      /^\/root\/\.openclaw\/workspaces\/agent-pdf-contract\/uploads\/report\.pdf$/
    );

    // Upload hint must mention the `pdf` tool and the absolute path
    const hint = buildAttachmentBlock(result.workspaceRefs);
    // The block is wrapped in <pinchy:attachments> so the display layer can
    // strip it cleanly on history reload.
    expect(hint).toMatch(/^<pinchy:attachments>/);
    expect(hint).toMatch(/<\/pinchy:attachments>$/);
    expect(hint).toMatch(/\bpdf\b/);
    expect(hint).toContain(ref.absolutePath);
  });

  it("sends PNG images inline but workspace-saves them too", async () => {
    const { processIncomingAttachments } = await import("@/server/attachment-pipeline");

    const result = await processIncomingAttachments({
      agentId: "agent-img-contract",
      contentParts: [
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
        },
      ],
      claimedFilenames: ["photo.png"],
    });

    // Images go inline AND to the workspace
    expect(result.chatAttachments).toHaveLength(1);
    expect(result.chatAttachments[0].mimeType).toBe("image/png");
    expect(result.workspaceRefs).toHaveLength(1);
  });

  it("in a mixed PDF+PNG message, only PNG is inline, both are workspace-saved", async () => {
    const { processIncomingAttachments, buildAttachmentBlock } =
      await import("@/server/attachment-pipeline");

    const result = await processIncomingAttachments({
      agentId: "agent-mixed-contract",
      contentParts: [
        { type: "image_url", image_url: { url: `data:application/pdf;base64,${PDF_BASE64}` } },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ],
      claimedFilenames: ["invoice.pdf", "photo.png"],
    });

    expect(result.chatAttachments).toHaveLength(1);
    expect(result.chatAttachments[0].mimeType).toBe("image/png");
    expect(result.workspaceRefs).toHaveLength(2);

    const hint = buildAttachmentBlock(result.workspaceRefs);
    // The block is wrapped in <pinchy:attachments> so the display layer can
    // strip it cleanly on history reload.
    expect(hint).toMatch(/^<pinchy:attachments>/);
    expect(hint).toMatch(/<\/pinchy:attachments>$/);
    // Both files mentioned in the hint
    expect(hint).toContain("invoice.pdf");
    expect(hint).toContain("photo.png");
    // PDF gets the `pdf` tool, PNG gets the `image` tool
    expect(hint).toMatch(/\bpdf\b/);
    expect(hint).toMatch(/\bimage\b/);
    // Hint tells agent to pass exact paths to sub-agents
    expect(hint.toLowerCase()).toMatch(/sub.?agent|delegate/);
  });
});
