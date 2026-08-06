/**
 * Where a delivered file lives, and what it contained — read the same way by
 * the side that mints a grant and the side that serves one.
 *
 * A delivery grant (`agent_delivered_files`) authorizes a **filename**, and an
 * agent's workspace is shared by every member of a shared agent. So the grant
 * promised "user U may fetch the file delivered to them" while actually
 * answering "user U may fetch whatever currently sits at that name" — two
 * different sentences, and #903 found two ways to make them differ:
 *
 * - `pinchy_write(workbench/report.csv, overwrite=true)` in one member's turn
 *   replaces the bytes behind another member's live download chip.
 * - Creating `workbench/invoice.pdf` shadows an `uploads/invoice.pdf` delivery,
 *   because the serving route searched the zones in a fixed order and took the
 *   first hit. No overwrite flag needed — an ordinary create is enough.
 *
 * Pinning the grant to the content hash closes both, and every write path
 * nobody has written yet: bytes that are not the delivered bytes are refused
 * whatever wrote them. Pinning the zone as well is not the security property —
 * a shadowing file with identical bytes is harmless — it scopes a grant's
 * authority to where its file came from and lets the route look in one place
 * instead of hashing its way through a search.
 *
 * Either way it only holds while both sides agree on which file they mean,
 * which is why the resolution lives here rather than being spelled twice —
 * a hash taken from one path and checked against another fails open in one
 * direction and locks every download out in the other.
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { getWorkspacePath } from "@/lib/workspace";
import { realpathWithinDir } from "@/lib/agent-file-access";

/**
 * The workspace subdirectories a delivery can come from: agent-generated files
 * land in `workbench`, agent-fetched ones (an email attachment) in `uploads`.
 *
 * The order is load-bearing for legacy grants only — they carry no zone, so
 * they are still searched first-hit-wins, which is the shadowing gap above.
 * A pinned grant names its zone and never consults this order.
 */
export const DELIVERY_ZONES = ["workbench", "uploads"] as const;

export type DeliveryZone = (typeof DELIVERY_ZONES)[number];

export function isDeliveryZone(value: string | null | undefined): value is DeliveryZone {
  return !!value && (DELIVERY_ZONES as readonly string[]).includes(value);
}

/**
 * The real, symlink-resolved path of `safeName` inside one zone, or `null` when
 * it is not there.
 *
 * `safeName` must already have been through `sanitizeFilename`. The lexical
 * containment check below is defence in depth against that having changed; the
 * `realpathWithinDir` call is the actual boundary, because a lexical check
 * cannot see what a symlink at the path points at.
 *
 * A symlink resolving outside the zone reads as "not in this zone" rather than
 * as an error — the same answer a missing file gives, so a caller walking the
 * zones moves on instead of failing the whole request.
 */
export async function resolveInZone(
  agentId: string,
  zone: DeliveryZone,
  safeName: string
): Promise<string | null> {
  const zoneDir = join(getWorkspacePath(agentId), zone);
  const fullPath = resolve(zoneDir, safeName);
  if (!fullPath.startsWith(resolve(zoneDir) + sep)) return null;
  return realpathWithinDir(fullPath, zoneDir);
}

/**
 * The first zone that has the file, in `DELIVERY_ZONES` order.
 *
 * Used when a grant is being **minted**: the deliverer does not know which zone
 * the agent wrote to, so it looks the same way the pre-#903 serving route did
 * and then records the answer. From then on the grant names it outright.
 *
 * `modifiedAtMs` comes back with it because the minting side needs to tell
 * "this run wrote it" from "somebody else's run did". A workspace is shared by
 * every member of a shared agent, so changed bytes alone do not mean the
 * current user was handed anything — see the re-grant gate in
 * `deliverRunArtifacts`. It is `stat`ed here rather than at the call site so
 * the time and the path come from the same resolution.
 */
export async function locateDeliveredFile(
  agentId: string,
  safeName: string
): Promise<{ zone: DeliveryZone; realPath: string; modifiedAtMs: number } | null> {
  for (const zone of DELIVERY_ZONES) {
    const realPath = await resolveInZone(agentId, zone, safeName);
    if (!realPath) continue;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- realPath is the output of realpathWithinDir, i.e. a path already proven to resolve inside the agent's own workspace zone.
      const { mtimeMs } = await stat(realPath);
      return { zone, realPath, modifiedAtMs: mtimeMs };
    } catch {
      // Resolution succeeded, so the file was there a moment ago. Treat a
      // failed stat exactly like a miss and keep looking, rather than failing
      // the whole delivery on a race with a concurrent delete.
      continue;
    }
  }
  return null;
}

/**
 * SHA-256 of the file's bytes, or `null` if it cannot be read.
 *
 * Streamed rather than read whole: a delivered spreadsheet or PDF is small, but
 * nothing enforces that, and buffering an attacker-chosen size into memory on
 * every download is a cost with no upside.
 *
 * `null` is deliberately indistinguishable from "wrong hash" at both call
 * sites. On the minting side an unreadable file yields no grant; on the serving
 * side it yields a 404. Both fail closed, which is the point of the change.
 */
export async function hashFileBytes(realPath: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- realPath is the output of realpathWithinDir, i.e. a path already proven to resolve inside the agent's own workspace zone.
    const stream = createReadStream(realPath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  }
}
