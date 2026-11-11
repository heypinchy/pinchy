import { describe, it, expect, vi } from "vitest";
import {
  DISK_WARNING_FREE_BYTES,
  getDiskReport,
  type DiskLocation,
  type StatfsLike,
} from "@/lib/disk-space";

const GB = 1_000_000_000;
const BSIZE = 4096;

/** A statfs result with `free` bytes available out of `total`. */
function fs(free: number, total: number): StatfsLike {
  return { bsize: BSIZE, bavail: Math.floor(free / BSIZE), blocks: Math.floor(total / BSIZE) };
}

function report(
  results: Record<string, StatfsLike | Error | Promise<StatfsLike>>,
  locations: DiskLocation[] = Object.keys(results).map((path, i) => ({
    name: (["system", "workspaces", "knowledgeBaseArtifacts", "data"] as const)[i],
    path,
  })),
  timeoutMs?: number
) {
  const statfs = vi.fn(async (path: string) => {
    const r = results[path];
    if (r instanceof Error) throw r;
    return r;
  });
  return getDiskReport({ statfs, locations, timeoutMs });
}

describe("getDiskReport", () => {
  it("warns below 15 GB free, because a release alone needs about 10 GB to pull", () => {
    expect(DISK_WARNING_FREE_BYTES).toBe(15 * GB);
  });

  it("is ok with plenty of space and reports coarse numbers only", async () => {
    const r = await report({ "/": fs(120.7 * GB, 200 * GB) });

    expect(r).toEqual({
      status: "ok",
      volumes: [{ name: "system", status: "ok", freeGb: 120, totalGb: 200, freePercent: 60 }],
    });
  });

  it("is ok at exactly the threshold", async () => {
    const r = await report({ "/": { bsize: 1, bavail: 15 * GB, blocks: 38 * GB } });
    expect(r.status).toBe("ok");
    expect(r.volumes[0]).toMatchObject({ status: "ok", freeGb: 15 });
  });

  it("warns one byte below the threshold", async () => {
    const r = await report({ "/": { bsize: 1, bavail: 15 * GB - 1, blocks: 38 * GB } });
    expect(r.status).toBe("warning");
    expect(r.volumes[0]).toMatchObject({ status: "warning", freeGb: 14 });
  });

  it("warns on a large disk once the absolute free space is low, whatever the percentage", async () => {
    const r = await report({ "/": fs(14 * GB, 2000 * GB) });
    expect(r.status).toBe("warning");
  });

  it("does not warn on a large disk that is mostly full but still has room for releases", async () => {
    // 5% free of 2 TB is 100 GB — a percentage rule would cry wolf here.
    const r = await report({ "/": fs(100 * GB, 2000 * GB) });
    expect(r.status).toBe("ok");
  });

  it("warns overall when any one location is low", async () => {
    const r = await report({
      "/": fs(80 * GB, 100 * GB),
      "/workspaces": fs(3 * GB, 38 * GB),
    });

    expect(r.status).toBe("warning");
    expect(r.volumes.map((v) => [v.name, v.status])).toEqual([
      ["system", "ok"],
      ["workspaces", "warning"],
    ]);
  });

  it("skips a location that does not exist on this machine", async () => {
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const r = await report({ "/": fs(80 * GB, 100 * GB), "/var/cache/nope": missing });

    expect(r.status).toBe("ok");
    expect(r.volumes.map((v) => v.name)).toEqual(["system"]);
  });

  it("skips a pseudo filesystem that reports no size", async () => {
    const r = await report({ "/": fs(80 * GB, 100 * GB), "/proc-like": fs(0, 0) });
    expect(r.volumes.map((v) => v.name)).toEqual(["system"]);
  });

  it("says unknown, not ok, when nothing could be measured", async () => {
    const r = await report({ "/": new Error("EIO") });
    expect(r).toEqual({ status: "unknown", volumes: [] });
  });

  it("gives up on a location that hangs (a stalled network mount) instead of hanging the health check", async () => {
    const never = new Promise<StatfsLike>(() => {});
    const r = await report(
      { "/": fs(80 * GB, 100 * GB), "/mnt/nas": never },
      [
        { name: "system", path: "/" },
        { name: "data", path: "/mnt/nas" },
      ],
      20
    );

    expect(r.status).toBe("ok");
    expect(r.volumes.map((v) => v.name)).toEqual(["system"]);
  });

  it("does not start a second probe for a location whose first one is still hanging", async () => {
    // Every statfs occupies a libuv thread until it returns. A health check
    // polled every 30 s against a dead mount would otherwise pile up hung
    // calls until the thread pool is exhausted and every file operation in
    // the process stalls.
    const statfs = vi.fn(() => new Promise<StatfsLike>(() => {}));
    const locations = [{ name: "data" as const, path: "/mnt/stuck-for-single-flight" }];

    await getDiskReport({ statfs, locations, timeoutMs: 5 });
    await getDiskReport({ statfs, locations, timeoutMs: 5 });

    expect(statfs).toHaveBeenCalledTimes(1);
  });
});
