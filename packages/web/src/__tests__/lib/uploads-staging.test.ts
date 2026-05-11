import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { persistStagedUpload } from "@/lib/uploads";

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
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
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
