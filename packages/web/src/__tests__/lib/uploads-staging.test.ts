import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { persistStagedUpload, promoteStagedToAttached } from "@/lib/uploads";

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "pinchy-stage-"));
});
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("persistStagedUpload", () => {
  it("writes the file under .staging/<uploadId>/<safeName>", async () => {
    const buffer = Buffer.from("hello pdf content");
    const result = await persistStagedUpload({
      workspaceRoot,
      filename: "report.pdf",
      buffer,
    });
    expect(result.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.relativePath).toBe(`.staging/${result.uploadId}/report.pdf`);
    const written = await readFile(join(workspaceRoot, result.relativePath));
    expect(written.equals(buffer)).toBe(true);
  });

  it("returns the content sha256 hash", async () => {
    const buffer = Buffer.from("deterministic content");
    const result = await persistStagedUpload({
      workspaceRoot,
      filename: "x.txt",
      buffer,
    });
    const expected = createHash("sha256").update(buffer).digest("hex");
    expect(result.contentHash).toBe(expected);
  });

  it("isolates uploads under distinct uploadIds even with same filename", async () => {
    const a = await persistStagedUpload({
      workspaceRoot,
      filename: "same.pdf",
      buffer: Buffer.from("a"),
    });
    const b = await persistStagedUpload({
      workspaceRoot,
      filename: "same.pdf",
      buffer: Buffer.from("b"),
    });
    expect(a.uploadId).not.toBe(b.uploadId);
    const aBytes = await readFile(join(workspaceRoot, a.relativePath));
    const bBytes = await readFile(join(workspaceRoot, b.relativePath));
    expect(aBytes.toString()).toBe("a");
    expect(bBytes.toString()).toBe("b");
  });
});

describe("promoteStagedToAttached", () => {
  it("renames .staging/<id>/<file> to uploads/<file>", async () => {
    const staged = await persistStagedUpload({
      workspaceRoot,
      filename: "doc.pdf",
      buffer: Buffer.from("content"),
    });
    const result = await promoteStagedToAttached({
      workspaceRoot,
      stagedRelativePath: staged.relativePath,
      filename: "doc.pdf",
    });
    expect(result.relativePath).toBe("uploads/doc.pdf");
    const moved = await readFile(join(workspaceRoot, result.relativePath));
    expect(moved.toString()).toBe("content");
    // .staging dir for that uploadId is cleaned up
    await expect(stat(join(workspaceRoot, ".staging", staged.uploadId))).rejects.toThrow();
  });

  it("collision-suffixes when uploads/<filename> already exists with different content", async () => {
    const first = await persistStagedUpload({
      workspaceRoot,
      filename: "x.pdf",
      buffer: Buffer.from("first"),
    });
    await promoteStagedToAttached({
      workspaceRoot,
      stagedRelativePath: first.relativePath,
      filename: "x.pdf",
    });

    const second = await persistStagedUpload({
      workspaceRoot,
      filename: "x.pdf",
      buffer: Buffer.from("second"),
    });
    const result = await promoteStagedToAttached({
      workspaceRoot,
      stagedRelativePath: second.relativePath,
      filename: "x.pdf",
    });
    expect(result.relativePath).toMatch(/^uploads\/x \(\d+\)\.pdf$/);
  });
});
