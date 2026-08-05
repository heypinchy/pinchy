// audit-exempt: read-only download, no state change (see AGENTS.md § audit
// rules). Access is still gated — the GET enforces per-user authorization via an
// agent_delivered_files grant lookup to prevent IDOR on shared agents, exactly
// like the sibling uploads route. The delivery WRITE (which creates the grant)
// is audited where it happens, in client-router.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { db } from "@/db";
import { agentDeliveredFiles } from "@/db/schema";
import { sanitizeFilename } from "@/lib/upload-validation";
import { streamWorkspaceFile } from "@/lib/serve-workspace-file";
import {
  DELIVERY_ZONES,
  hashFileBytes,
  isDeliveryZone,
  resolveInZone,
  type DeliveryZone,
} from "@/lib/delivered-file-location";

type Params = { params: Promise<{ agentId: string; filename: string }> };

export const GET = withAuth<Params>(async (_req, { params }, session) => {
  const { agentId, filename: rawFilename } = await params;

  // Access check FIRST — same gate as the chat itself. The helper returns
  // either the agent record or a NextResponse (401/403/404) which we forward
  // verbatim to keep the leak surface identical across all agent routes.
  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  // sanitizeFilename throws on traversal attempts, control chars, empty names,
  // etc. Anything it rejects becomes a 404 — we never disclose WHY the path was
  // bad, just that the file isn't there.
  let safeName: string;
  try {
    safeName = sanitizeFilename(rawFilename);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  // Per-user authorization. Agent access alone is NOT sufficient: a shared
  // agent's workspace co-mingles every member's delivered files, so agent read
  // access would otherwise let user B fetch user A's file by its predictable
  // filename (IDOR). Require a delivery grant owned by the caller. 404 (not 403)
  // so non-grantees can't even confirm the file exists.
  const grants = await db
    .select({
      zone: agentDeliveredFiles.zone,
      contentHash: agentDeliveredFiles.contentHash,
    })
    .from(agentDeliveredFiles)
    .where(
      and(
        eq(agentDeliveredFiles.agentId, agentId),
        eq(agentDeliveredFiles.filename, safeName),
        eq(agentDeliveredFiles.userId, session.user.id!)
      )
    );
  if (grants.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Since #903 a grant records WHAT was delivered, not just what it was called:
  // the zone it came from and the SHA-256 of its bytes.
  //
  // The hash is the security property, and it is the whole of it: bytes that
  // are not the delivered bytes are refused, whatever wrote them and whichever
  // zone they sit in. That covers both gaps in the issue — an overwrite inside
  // `workbench/`, and a same-named file shadowing an `uploads/` delivery —
  // and every write path nobody has written yet. Verified by canary: removing
  // this comparison turns the two tests named after those gaps red, while
  // removing the zone pin alone leaves them green.
  //
  // The zone is not redundant, it just does a different job. It scopes a
  // grant's authority to where its file came from, and it means the route
  // looks in one place rather than hashing its way through a search — so a
  // grant for `uploads/x` cannot be spent on `workbench/x` even in the one
  // case the hash would wave through, which is when the two are byte-identical
  // and therefore harmless anyway.
  //
  // The hash is read before a single byte is served, which costs one full pass
  // over the file on top of the streaming one. That is the price of the check:
  // verifying while streaming would mean the bytes had already left.
  const hashesByZone = new Map<DeliveryZone, Set<string>>();
  for (const grant of grants) {
    if (!isDeliveryZone(grant.zone) || !grant.contentHash) continue;
    const set = hashesByZone.get(grant.zone) ?? new Set<string>();
    set.add(grant.contentHash);
    hashesByZone.set(grant.zone, set);
  }

  for (const [zone, hashes] of hashesByZone) {
    // `resolveInZone` re-checks lexical containment and resolves symlinks
    // against the zone directory — a symlink pointing out of the zone reads as
    // "not here", exactly like a missing file, so the next grant gets a turn.
    // What gets opened afterwards is the RESOLVED path and never the requested
    // one, so re-pointing the link buys nothing.
    const realPath = await resolveInZone(agentId, zone, safeName);
    if (!realPath) continue;

    const hash = await hashFileBytes(realPath);
    // Fail closed on both a mismatch and an unreadable file. A mismatch means
    // these are not the bytes this user was handed — whoever wrote them may not
    // even share their conversation — and there is nothing useful to say about
    // it that does not also confirm the file exists.
    if (!hash || !hashes.has(hash)) continue;

    const res = await streamWorkspaceFile(realPath, safeName);
    if (res.status !== 404) return res;
  }

  // Grants written before #903 carry no zone and no hash, and cannot be pinned
  // after the fact: hashing whatever is on disk today would notarize exactly
  // the swap this check exists to catch. So they keep the semantics they were
  // written under — search both zones, serve the first hit — and the exposure
  // they carry ends when they do.
  //
  // A user holding BOTH a legacy and a pinned grant for one filename therefore
  // still gets legacy semantics for it. That is the same accepted window, not a
  // new one: it needs a delivery that predates the upgrade.
  if (!grants.every((g) => isDeliveryZone(g.zone) && g.contentHash)) {
    for (const zone of DELIVERY_ZONES) {
      const realPath = await resolveInZone(agentId, zone, safeName);
      if (!realPath) continue;
      const res = await streamWorkspaceFile(realPath, safeName);
      if (res.status !== 404) return res;
    }
  }

  return new NextResponse("Not found", { status: 404 });
});
