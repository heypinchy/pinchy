import { mkdtemp, writeFile, readFile, symlink, truncate, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeEach } from "vitest";
import { mirrorChannelMedia, MAX_MIRRORED_MEDIA_BYTES } from "@/server/channel-media";

describe("mirrorChannelMedia", () => {
  let inboundDir: string;
  let workspaceRoot: string;
  const agentId = "agent-1";

  beforeEach(async () => {
    inboundDir = await mkdtemp(join(tmpdir(), "inbound-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
  });

  it("copies a reported file into <workspaceRoot>/<agentId>/uploads/<basename>", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "binary-jpeg-content");

    const results = await mirrorChannelMedia({
      agentId,
      media: [{ path: source, mimeType: "image/jpeg" }],
      inboundDir,
      workspaceRoot,
    });

    expect(results).toEqual([
      {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: "binary-jpeg-content".length,
        outcome: "success",
      },
    ]);

    const target = join(workspaceRoot, agentId, "uploads", "photo.jpg");
    const copied = await readFile(target, "utf-8");
    expect(copied).toBe("binary-jpeg-content");
  });

  it("is idempotent: running twice both succeed and content is unchanged", async () => {
    const source = join(inboundDir, "note.txt");
    await writeFile(source, "hello world");

    const first = await mirrorChannelMedia({
      agentId,
      media: [{ path: source }],
      inboundDir,
      workspaceRoot,
    });
    expect(first[0].outcome).toBe("success");

    const second = await mirrorChannelMedia({
      agentId,
      media: [{ path: source }],
      inboundDir,
      workspaceRoot,
    });
    expect(second[0].outcome).toBe("success");

    const target = join(workspaceRoot, agentId, "uploads", "note.txt");
    const content = await readFile(target, "utf-8");
    expect(content).toBe("hello world");
  });

  it("uses only the basename of a hostile reported path", async () => {
    const source = join(inboundDir, "x.jpg");
    await writeFile(source, "content");

    const results = await mirrorChannelMedia({
      agentId,
      media: [{ path: "/etc/../whatever/x.jpg" }],
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("success");
    expect(results[0].filename).toBe("x.jpg");
    const target = join(workspaceRoot, agentId, "uploads", "x.jpg");
    const copied = await readFile(target, "utf-8");
    expect(copied).toBe("content");
  });

  it("rejects unsafe basenames: dotfiles and backslashes", async () => {
    await writeFile(join(inboundDir, ".env"), "SECRET=1");

    const results = await mirrorChannelMedia({
      agentId,
      media: [{ path: ".env" }, { path: "a\\b" }],
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("failure");
    expect(results[1].outcome).toBe("failure");

    // No files created in uploads
    const { readdir } = await import("fs/promises");
    await expect(readdir(join(workspaceRoot, agentId, "uploads")).catch(() => [])).resolves.toEqual(
      []
    );
  });

  it("rejects a symlink source escaping the inbound dir", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "top secret");

    const symlinkPath = join(inboundDir, "evil.jpg");
    await symlink(outsideFile, symlinkPath);

    const results = await mirrorChannelMedia({
      agentId,
      media: [{ path: "evil.jpg" }],
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("failure");
    const { readdir } = await import("fs/promises");
    await expect(readdir(join(workspaceRoot, agentId, "uploads")).catch(() => [])).resolves.toEqual(
      []
    );
  });

  it("rejects files over 25 MB without copying", async () => {
    const source = join(inboundDir, "huge.bin");
    await writeFile(source, "");
    await truncate(source, MAX_MIRRORED_MEDIA_BYTES + 1);

    const results = await mirrorChannelMedia({
      agentId,
      media: [{ path: source }],
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("failure");
    const { readdir } = await import("fs/promises");
    await expect(readdir(join(workspaceRoot, agentId, "uploads")).catch(() => [])).resolves.toEqual(
      []
    );
  });

  it("processes files per-file best-effort: missing then present", async () => {
    const presentSource = join(inboundDir, "present.jpg");
    await writeFile(presentSource, "present-content");

    const results = await mirrorChannelMedia({
      agentId,
      media: [{ path: join(inboundDir, "missing.jpg") }, { path: presentSource }],
      inboundDir,
      workspaceRoot,
    });

    expect(results.map((r) => r.outcome)).toEqual(["failure", "success"]);

    const target = join(workspaceRoot, agentId, "uploads", "present.jpg");
    const copied = await readFile(target, "utf-8");
    expect(copied).toBe("present-content");
  });

  it("throws for an agentId containing path separators (programmer error)", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "content");

    await expect(
      mirrorChannelMedia({
        agentId: "../escape",
        media: [{ path: source }],
        inboundDir,
        workspaceRoot,
      })
    ).rejects.toThrow();
  });

  it("creates the uploads directory automatically when it doesn't yet exist", async () => {
    const source = join(inboundDir, "photo.jpg");
    await writeFile(source, "content");
    // workspaceRoot exists but agent dir/uploads doesn't
    await mkdir(join(workspaceRoot, agentId), { recursive: true }).catch(() => {});

    const results = await mirrorChannelMedia({
      agentId,
      media: [{ path: source }],
      inboundDir,
      workspaceRoot,
    });

    expect(results[0].outcome).toBe("success");
  });
});
