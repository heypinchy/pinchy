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
  it("writes the file under .staging/<uploadId>/<reservedName> and reserves uploads/<reservedName>", async () => {
    const buffer = Buffer.from("hello pdf content");
    const result = await persistStagedUpload({
      workspaceRoot,
      filename: "report.pdf",
      buffer,
    });
    expect(result.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.filename).toBe("report.pdf");
    expect(result.relativePath).toBe(`.staging/${result.uploadId}/report.pdf`);
    const written = await readFile(join(workspaceRoot, result.relativePath));
    expect(written.equals(buffer)).toBe(true);
    // The uploads/ slot was reserved atomically — an empty placeholder must
    // exist so the chip's `/uploads/<name>` URL is already non-colliding when
    // the upload completes (race window prior to promote is gone).
    const placeholder = await stat(join(workspaceRoot, "uploads", "report.pdf"));
    expect(placeholder.isFile()).toBe(true);
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
    // Second upload was given a collision-suffix because the first reserved
    // `uploads/same.pdf` — the staging path mirrors the reserved filename.
    expect(a.filename).toBe("same.pdf");
    expect(b.filename).toMatch(/^same \(\d+\)\.pdf$/);
    expect(b.relativePath).toBe(`.staging/${b.uploadId}/${b.filename}`);
    const aBytes = await readFile(join(workspaceRoot, a.relativePath));
    const bBytes = await readFile(join(workspaceRoot, b.relativePath));
    expect(aBytes.toString()).toBe("a");
    expect(bBytes.toString()).toBe("b");
  });

  it("reserves a different slot when uploads/<filename> already has durable content", async () => {
    // Pre-populate uploads/ with a non-placeholder file (simulating an
    // existing durable attachment from a previous send).
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(join(workspaceRoot, "uploads"), { recursive: true });
    await writeFile(join(workspaceRoot, "uploads", "doc.pdf"), Buffer.from("durable"));

    const result = await persistStagedUpload({
      workspaceRoot,
      filename: "doc.pdf",
      buffer: Buffer.from("new content"),
    });
    expect(result.filename).toMatch(/^doc \(\d+\)\.pdf$/);
    expect(result.relativePath).toBe(`.staging/${result.uploadId}/${result.filename}`);
  });
});

describe("promoteStagedToAttached", () => {
  it("renames .staging/<id>/<reservedName> to uploads/<reservedName>", async () => {
    const staged = await persistStagedUpload({
      workspaceRoot,
      filename: "doc.pdf",
      buffer: Buffer.from("content"),
    });
    const result = await promoteStagedToAttached({
      workspaceRoot,
      stagedRelativePath: staged.relativePath,
      filename: staged.filename,
    });
    expect(result.relativePath).toBe(`uploads/${staged.filename}`);
    const moved = await readFile(join(workspaceRoot, result.relativePath));
    expect(moved.toString()).toBe("content");
    // .staging dir for that uploadId is cleaned up
    await expect(stat(join(workspaceRoot, ".staging", staged.uploadId))).rejects.toThrow();
  });

  it("preserves distinct content for concurrently-staged uploads with the same source filename", async () => {
    // Two uploads of the same source filename — collision-dedup happens at
    // STAGE time, so promote is now a trivial rename. The second upload's
    // reserved slot was chosen at stage time, not at promote time.
    const first = await persistStagedUpload({
      workspaceRoot,
      filename: "x.pdf",
      buffer: Buffer.from("first"),
    });
    const second = await persistStagedUpload({
      workspaceRoot,
      filename: "x.pdf",
      buffer: Buffer.from("second"),
    });

    await promoteStagedToAttached({
      workspaceRoot,
      stagedRelativePath: first.relativePath,
      filename: first.filename,
    });
    const secondRes = await promoteStagedToAttached({
      workspaceRoot,
      stagedRelativePath: second.relativePath,
      filename: second.filename,
    });

    expect(first.filename).toBe("x.pdf");
    expect(second.filename).toMatch(/^x \(\d+\)\.pdf$/);
    expect(secondRes.relativePath).toBe(`uploads/${second.filename}`);

    const firstBytes = await readFile(join(workspaceRoot, "uploads", first.filename));
    const secondBytes = await readFile(join(workspaceRoot, "uploads", second.filename));
    expect(firstBytes.toString()).toBe("first");
    expect(secondBytes.toString()).toBe("second");
  });
});
