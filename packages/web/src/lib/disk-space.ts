import { statfs as nodeStatfs } from "node:fs/promises";
import { getWorkspaceBasePath } from "@/lib/workspace";
import { DEFAULT_ARTIFACT_DIR } from "@/lib/knowledge/office-artifacts";
import { DATA_ROOT } from "@/lib/knowledge/citation-path";

/**
 * Free space below which Pinchy warns (#1379).
 *
 * An absolute number, not a percentage, because the thing that takes an
 * install down is a fixed-size event: pulling a release is about 10 GB of
 * images (pinchy ~6.5 GB + openclaw ~3.3 GB). 15 GB leaves room for that pull
 * plus a few days of knowledge-base growth. A percentage rule gets both ends
 * wrong — 10% of a 38 GB disk is 3.8 GB, too late to pull anything, while 10%
 * of 2 TB is 200 GB, which would warn for months about nothing.
 */
export const DISK_WARNING_FREE_BYTES = 15_000_000_000;

const BYTES_PER_GB = 1_000_000_000;
const DEFAULT_TIMEOUT_MS = 1_000;

export type DiskLocationName = "system" | "workspaces" | "knowledgeBaseArtifacts" | "data";
export type DiskLocation = { name: DiskLocationName; path: string };
export type StatfsLike = { bsize: number; bavail: number; blocks: number };

export type DiskVolumeReport = {
  name: DiskLocationName;
  status: "ok" | "warning";
  freeGb: number;
  totalGb: number;
  freePercent: number;
};

export type DiskReport = {
  /** `unknown` when no location could be measured — never a silent `ok`. */
  status: "ok" | "warning" | "unknown";
  volumes: DiskVolumeReport[];
};

/**
 * Where Pinchy's data grows, by role rather than by path: `/api/health` is
 * public, and the roles are all an operator needs to find the disk.
 *
 * - `system` is the container's own filesystem. It sits on Docker's storage,
 *   which is where pulled images land and where `/tmp` lives — the write that
 *   failed first in the incident behind #1379.
 * - The database volume is not mounted here, so it is not measured. On a
 *   default install it shares the disk with the volumes below.
 */
export function defaultDiskLocations(): DiskLocation[] {
  return [
    { name: "system", path: "/" },
    { name: "workspaces", path: getWorkspaceBasePath() },
    { name: "knowledgeBaseArtifacts", path: DEFAULT_ARTIFACT_DIR },
    { name: "data", path: DATA_ROOT },
  ];
}

/**
 * One probe per path at a time. A statfs on a stalled network mount blocks a
 * libuv thread until the mount answers; without this, a health check polled
 * every 30 s would queue a new blocked call each time until the thread pool
 * (four threads by default) is exhausted and every file operation in the
 * process waits behind it.
 */
const inFlight = new Map<string, Promise<StatfsLike>>();

function probe(path: string, statfs: (path: string) => Promise<StatfsLike>) {
  let pending = inFlight.get(path);
  if (!pending) {
    pending = statfs(path);
    inFlight.set(path, pending);
    const clear = () => inFlight.delete(path);
    pending.then(clear, clear);
  }
  return pending;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("statfs timed out")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toReport(name: DiskLocationName, s: StatfsLike): DiskVolumeReport | null {
  const free = s.bavail * s.bsize;
  const total = s.blocks * s.bsize;
  if (!(total > 0)) return null;
  return {
    name,
    status: free < DISK_WARNING_FREE_BYTES ? "warning" : "ok",
    // Floored, so a reported "15 GB" never sits below the line it is compared to.
    freeGb: Math.floor(free / BYTES_PER_GB),
    totalGb: Math.round(total / BYTES_PER_GB),
    freePercent: Math.floor((free / total) * 100),
  };
}

export async function getDiskReport({
  statfs = nodeStatfs,
  locations = defaultDiskLocations(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  statfs?: (path: string) => Promise<StatfsLike>;
  locations?: DiskLocation[];
  timeoutMs?: number;
} = {}): Promise<DiskReport> {
  const results = await Promise.all(
    locations.map(async ({ name, path }) => {
      try {
        return toReport(name, await withTimeout(probe(path, statfs), timeoutMs));
      } catch {
        // Missing on this machine (a dev checkout has no /data), unreadable,
        // or hanging: leave it out rather than guess a number for it.
        return null;
      }
    })
  );
  const volumes = results.filter((v): v is DiskVolumeReport => v !== null);
  if (volumes.length === 0) return { status: "unknown", volumes };
  return {
    status: volumes.some((v) => v.status === "warning") ? "warning" : "ok",
    volumes,
  };
}
