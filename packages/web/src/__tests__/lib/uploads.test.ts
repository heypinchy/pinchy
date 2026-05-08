import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { persistAttachment } from "@/lib/uploads";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-uploads-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const PDF_BUF_A = Buffer.from("%PDF-A");
const PDF_BUF_B = Buffer.from("%PDF-B");

describe("persistAttachment", () => {
  it("writes the file under uploads/<filename> and returns the relative path", async () => {
    const result = await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BUF_A,
    });
    expect(result.relativePath).toBe("uploads/invoice.pdf");
    expect(result.reused).toBe(false);
    expect(readFileSync(join(tmpRoot, "agent-1/uploads/invoice.pdf"))).toEqual(PDF_BUF_A);
  });

  it("dedups identical content under the same name", async () => {
    await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BUF_A,
    });
    const second = await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BUF_A,
    });
    expect(second.relativePath).toBe("uploads/invoice.pdf");
    expect(second.reused).toBe(true);
  });

  it("suffixes when the same name has different content", async () => {
    await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BUF_A,
    });
    const second = await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BUF_B,
    });
    expect(second.relativePath).toBe("uploads/invoice (1).pdf");
    expect(second.reused).toBe(false);
    expect(existsSync(join(tmpRoot, "agent-1/uploads/invoice.pdf"))).toBe(true);
    expect(existsSync(join(tmpRoot, "agent-1/uploads/invoice (1).pdf"))).toBe(true);
  });

  it("creates the uploads directory on first write", async () => {
    expect(existsSync(join(tmpRoot, "agent-1/uploads"))).toBe(false);
    await persistAttachment({
      agentId: "agent-1",
      filename: "first.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BUF_A,
    });
    expect(existsSync(join(tmpRoot, "agent-1/uploads"))).toBe(true);
  });

  it("returns contentHash as hex SHA-256 of the buffer", async () => {
    const { createHash } = await import("crypto");
    const expected = createHash("sha256").update(PDF_BUF_A).digest("hex");
    const result = await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: PDF_BUF_A,
    });
    expect(result.contentHash).toBe(expected);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid agentId (path traversal guard)", async () => {
    await expect(
      persistAttachment({
        agentId: "../etc",
        filename: "x.pdf",
        mimeType: "application/pdf",
        buffer: PDF_BUF_A,
      })
    ).rejects.toThrow(/agentId/i);
  });
});
