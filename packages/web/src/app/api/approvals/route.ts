import { NextResponse } from "next/server";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { toolApproval, agents } from "@/db/schema";
import { MAX_KNOWN_APPROVALS } from "@/lib/schemas/approvals";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids in `?known=`, the cards the poller already holds. A stored summary
 * never changes, and one may be 0.5–1.5 MB as JSON (a long report written to a
 * file; see the bounds in `approvals/summary.ts`), so a card the caller
 * already holds comes back without it — the list is polled every five seconds
 * for as long as a card waits. Read up to MAX_KNOWN_APPROVALS ids (why that
 * number: see its definition); anything past it, or not an id, is ignored,
 * which at worst sends a summary again.
 */
function knownIds(params: URLSearchParams): Set<string> {
  const raw = params.get("known") ?? "";
  return new Set(
    raw
      .split(",")
      .filter((id) => UUID.test(id))
      .slice(0, MAX_KNOWN_APPROVALS)
  );
}

/**
 * The caller's own pending confirmations, for the inline chat card.
 * audit-exempt: read-only listing.
 */
export const GET = withAuth(async (req, _ctx, session) => {
  const rows = await db
    .select({
      id: toolApproval.id,
      agentId: toolApproval.agentId,
      agentName: agents.name,
      toolName: toolApproval.toolName,
      sessionKey: toolApproval.sessionKey,
      createdAt: toolApproval.createdAt,
      expiresAt: toolApproval.expiresAt,
    })
    .from(toolApproval)
    .innerJoin(agents, eq(agents.id, toolApproval.agentId))
    .where(
      and(
        eq(toolApproval.requesterId, session.user.id!),
        eq(toolApproval.status, "pending"),
        // Overdue rows are dead (consume + decision both check expiry); the
        // hourly sweep flips them to `expired` — never show them as actionable.
        gt(toolApproval.expiresAt, new Date())
      )
    )
    .orderBy(desc(toolApproval.createdAt));

  const known = knownIds(req.nextUrl.searchParams);
  const wanted = new Set(rows.filter((row) => !known.has(row.id)).map((row) => row.id));
  // Read separately so a held card's summary is never loaded at all. Still
  // `pending` only: a card settled since the list query has had its summary
  // dropped (settling clears it), and listed as `argsSummary: null` it would be
  // an approvable card that shows no arguments. Such a card is left out — it is
  // settled, not open.
  const summaries = new Map(
    wanted.size === 0
      ? []
      : (
          await db
            .select({ id: toolApproval.id, argsSummary: toolApproval.argsSummary })
            .from(toolApproval)
            .where(and(inArray(toolApproval.id, [...wanted]), eq(toolApproval.status, "pending")))
        ).map((row) => [row.id, row.argsSummary])
  );

  const approvals = rows.flatMap((row) => {
    if (!wanted.has(row.id)) return [row];
    return summaries.has(row.id) ? [{ ...row, argsSummary: summaries.get(row.id) ?? null }] : [];
  });
  return NextResponse.json({ approvals });
});
