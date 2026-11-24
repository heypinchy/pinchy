import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listDataMounts,
  listDataSubdirectories,
  MAX_LISTED_SUBDIRECTORIES,
} from "@/lib/data-subdirectories";

// The real data root is `/data/`, which does not exist on a developer machine.
// The module takes the root as a parameter for exactly this reason; the
// lexical rule (`isPathUnderDataRoot`) is still applied against `/data/` in
// the route, and is tested separately below with the real constant.
let sandbox: string;
let root: string;
let outside: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), "pinchy-subdirs-")));
  root = join(sandbox, "data");
  outside = join(sandbox, "secrets");
  await mkdir(join(root, "suppliers", "food", "2026"), { recursive: true });
  await mkdir(join(root, "suppliers", "vet"), { recursive: true });
  await mkdir(join(root, "suppliers", ".snapshot"), { recursive: true });
  await mkdir(join(root, "suppliers", "$RECYCLE.BIN"), { recursive: true });
  await writeFile(join(root, "suppliers", "readme.pdf"), "x");
  await mkdir(outside, { recursive: true });
  await mkdir(join(outside, "keys"), { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("listDataSubdirectories", () => {
  it("lists the immediate child folders, sorted, with absolute paths under the root", async () => {
    const result = await listDataSubdirectories(join(root, "suppliers"), { root });
    expect(result).toEqual({
      ok: true,
      truncated: false,
      directories: [
        { path: join(root, "suppliers", "food"), name: "food" },
        { path: join(root, "suppliers", "vet"), name: "vet" },
      ],
    });
  });

  it("lists one level only, not the whole tree", async () => {
    const result = await listDataSubdirectories(join(root, "suppliers"), { root });
    expect(result.ok && result.directories.map((d) => d.name)).not.toContain("2026");
  });

  it("accepts a trailing slash, the shape sanitizePath stores", async () => {
    const result = await listDataSubdirectories(join(root, "suppliers") + "/", { root });
    expect(result.ok && result.directories.map((d) => d.path)).toEqual([
      join(root, "suppliers", "food"),
      join(root, "suppliers", "vet"),
    ]);
  });

  it("skips files, hidden folders and OS junk folders the index would skip anyway", async () => {
    const result = await listDataSubdirectories(join(root, "suppliers"), { root });
    const names = result.ok ? result.directories.map((d) => d.name) : [];
    expect(names).not.toContain("readme.pdf");
    expect(names).not.toContain(".snapshot");
    expect(names).not.toContain("$RECYCLE.BIN");
  });

  it("does not list a symlinked child folder, even one pointing inside the root", async () => {
    await symlink(outside, join(root, "suppliers", "escape"));
    await symlink(join(root, "suppliers", "vet"), join(root, "suppliers", "vet-alias"));
    const result = await listDataSubdirectories(join(root, "suppliers"), { root });
    const names = result.ok ? result.directories.map((d) => d.name) : [];
    expect(names).toEqual(["food", "vet"]);
  });

  it("refuses to list through a symlinked folder", async () => {
    await symlink(outside, join(root, "suppliers", "escape"));
    const result = await listDataSubdirectories(join(root, "suppliers", "escape"), { root });
    expect(result).toEqual({ ok: false, reason: "not_listable" });
  });

  it("refuses to list below a symlinked ancestor", async () => {
    await symlink(outside, join(root, "linked"));
    const result = await listDataSubdirectories(join(root, "linked", "keys"), { root });
    expect(result).toEqual({ ok: false, reason: "not_listable" });
  });

  it("refuses `..` that climbs out of the root", async () => {
    const result = await listDataSubdirectories(join(root, "suppliers", "..", "..", "secrets"), {
      root,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_path" });
  });

  it("collapses `..` that stays inside the root to the real folder", async () => {
    const result = await listDataSubdirectories(join(root, "suppliers", "food", "..", ""), {
      root,
    });
    expect(result.ok && result.directories.map((d) => d.name)).toEqual(["food", "vet"]);
  });

  it("refuses the root itself — top-level mounts come from listDataMounts", async () => {
    expect(await listDataSubdirectories(root, { root })).toEqual({
      ok: false,
      reason: "invalid_path",
    });
    expect(await listDataSubdirectories(root + "/", { root })).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });

  it("refuses a sibling that merely shares the root's prefix", async () => {
    await mkdir(root + "base", { recursive: true });
    expect(await listDataSubdirectories(root + "base", { root })).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });

  it("refuses relative paths, null bytes and non-strings", async () => {
    expect(await listDataSubdirectories("suppliers", { root })).toEqual({
      ok: false,
      reason: "invalid_path",
    });
    expect(await listDataSubdirectories(join(root, "suppliers\0x"), { root })).toEqual({
      ok: false,
      reason: "invalid_path",
    });
    expect(await listDataSubdirectories(42 as unknown as string, { root })).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });

  it("treats a still-encoded `..` as a literal folder name, not as traversal", async () => {
    // The route decodes the query string once. A double-encoded `%2e%2e`
    // therefore arrives here as the literal text `%2e%2e`, which is a folder
    // name like any other — it must not be decoded a second time and climb.
    const result = await listDataSubdirectories(join(root, "suppliers", "%2e%2e", "%2e%2e"), {
      root,
    });
    expect(result).toEqual({ ok: false, reason: "not_listable" });
  });

  it("answers not_listable for a missing folder or a file", async () => {
    expect(await listDataSubdirectories(join(root, "nope"), { root })).toEqual({
      ok: false,
      reason: "not_listable",
    });
    expect(await listDataSubdirectories(join(root, "suppliers", "readme.pdf"), { root })).toEqual({
      ok: false,
      reason: "not_listable",
    });
  });

  it("caps the listing and says so", async () => {
    const big = join(root, "big");
    await mkdir(big);
    await Promise.all(
      Array.from({ length: MAX_LISTED_SUBDIRECTORIES + 3 }, (_, i) =>
        mkdir(join(big, `d${String(i).padStart(4, "0")}`))
      )
    );
    const result = await listDataSubdirectories(big, { root });
    expect(result.ok && result.directories).toHaveLength(MAX_LISTED_SUBDIRECTORIES);
    expect(result.ok && result.truncated).toBe(true);
  });

  it("applies the real /data boundary by default", async () => {
    expect(await listDataSubdirectories("/database/x")).toEqual({
      ok: false,
      reason: "invalid_path",
    });
    expect(await listDataSubdirectories("/data/../etc")).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });
});

describe("listDataMounts", () => {
  it("lists the folders directly under the root, sorted, with absolute paths", async () => {
    await mkdir(join(root, "hr"));
    expect(await listDataMounts({ root })).toEqual([
      { path: join(root, "hr"), name: "hr" },
      { path: join(root, "suppliers"), name: "suppliers" },
    ]);
  });

  it("reads the folder on every call, so a deleted or renamed mount is gone at once (#1363)", async () => {
    await mkdir(join(root, "old-name"));
    expect((await listDataMounts({ root })).map((d) => d.name)).toContain("old-name");

    await rm(join(root, "old-name"), { recursive: true });
    await mkdir(join(root, "new-name"));

    const names = (await listDataMounts({ root })).map((d) => d.name);
    expect(names).not.toContain("old-name");
    expect(names).toContain("new-name");
  });

  it("skips files, symlinks, hidden folders and OS junk folders", async () => {
    await writeFile(join(root, "notes.txt"), "x");
    await symlink(outside, join(root, "escape"));
    await mkdir(join(root, ".snapshot"));
    await mkdir(join(root, "$RECYCLE.BIN"));
    expect((await listDataMounts({ root })).map((d) => d.name)).toEqual(["suppliers"]);
  });

  it("answers an empty list when the root does not exist", async () => {
    expect(await listDataMounts({ root: join(sandbox, "nope") })).toEqual([]);
  });
});
