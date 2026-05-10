import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { persistAttachment, UploadSlotExhaustedError } from "@/lib/uploads";

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
      buffer: PDF_BUF_A,
    });
    const second = await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      buffer: PDF_BUF_A,
    });
    expect(second.relativePath).toBe("uploads/invoice.pdf");
    expect(second.reused).toBe(true);
  });

  it("suffixes when the same name has different content", async () => {
    await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      buffer: PDF_BUF_A,
    });
    const second = await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
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
        buffer: PDF_BUF_A,
      })
    ).rejects.toThrow(/agentId/i);
  });

  // TOCTOU regression: two concurrent uploads of *different* content under
  // the same filename must each end up at a distinct path, with no clobbering.
  it("handles concurrent writes of different content under the same filename without clobbering", async () => {
    const distinctBuffers = Array.from({ length: 8 }, (_, i) =>
      Buffer.from(`%PDF-distinct-${i}-${"x".repeat(64)}`)
    );

    const results = await Promise.all(
      distinctBuffers.map((buffer) =>
        persistAttachment({
          agentId: "agent-1",
          filename: "shared.pdf",
          buffer,
        })
      )
    );

    // Every concurrent caller got a unique path — none lost their write.
    const paths = results.map((r) => r.relativePath);
    expect(new Set(paths).size).toBe(distinctBuffers.length);

    // Each file on disk contains the buffer the caller actually wrote.
    for (let i = 0; i < distinctBuffers.length; i++) {
      const onDisk = readFileSync(join(tmpRoot, "agent-1", paths[i]));
      expect(onDisk).toEqual(distinctBuffers[i]);
    }
  });

  it("dedups concurrent writes of identical content", async () => {
    const same = Buffer.from("%PDF-identical-content");
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        persistAttachment({ agentId: "agent-1", filename: "shared.pdf", buffer: same })
      )
    );
    const paths = new Set(results.map((r) => r.relativePath));
    // All four resolve to the same on-disk file.
    expect(paths.size).toBe(1);
    expect([...paths][0]).toBe("uploads/shared.pdf");
    // At least one was written; the rest reused.
    expect(results.filter((r) => r.reused).length).toBeGreaterThanOrEqual(3);
  });

  // Originally the slot-exhaustion path threw a plain Error("Too many collisions
  // for foo.pdf"). The client-router then mapped it to the generic "internal
  // failure" branch — the user got a useless "Could not process attachment.
  // Please try again." back, with no hint that retrying with the SAME filename
  // would never succeed. The fix is a typed `UploadSlotExhaustedError` so the
  // attachment pipeline can surface a specific, actionable message.
  it("throws UploadSlotExhaustedError when collision slots are exhausted", async () => {
    // Fill 2 distinct-content slots manually, then ask persistAttachment to
    // place a third distinct buffer with maxCollisions=2 — must fail typed.
    await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      buffer: Buffer.from("%PDF-1"),
    });
    await persistAttachment({
      agentId: "agent-1",
      filename: "invoice.pdf",
      buffer: Buffer.from("%PDF-2"),
    });

    let caught: unknown;
    try {
      await persistAttachment({
        agentId: "agent-1",
        filename: "invoice.pdf",
        buffer: Buffer.from("%PDF-3"),
        maxCollisions: 2,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UploadSlotExhaustedError);
    expect((caught as Error).message).toMatch(/invoice\.pdf/);
  });

  it("UploadSlotExhaustedError carries the filename so the caller can build a user-facing message", async () => {
    await persistAttachment({
      agentId: "agent-1",
      filename: "report.pdf",
      buffer: Buffer.from("%PDF-X"),
    });
    let caught: UploadSlotExhaustedError | undefined;
    try {
      await persistAttachment({
        agentId: "agent-1",
        filename: "report.pdf",
        buffer: Buffer.from("%PDF-Y"),
        maxCollisions: 1,
      });
    } catch (err) {
      caught = err as UploadSlotExhaustedError;
    }
    expect(caught?.filename).toBe("report.pdf");
  });
});
