import { NextResponse } from "next/server";

import { withAdmin } from "@/lib/api-auth";
import { formatValidationError } from "@/lib/api-validation";
import { getAgentWithAccess } from "@/lib/agent-access";
import { type AgentPluginConfig } from "@/db/schema";
import { grantedDataPaths } from "@/lib/agent-granted-paths";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { kbOcrAvailability } from "@/lib/knowledge/kb-ocr";
import {
  listUnsearchableDocuments,
  summarizeUnsearchableDocuments,
} from "@/lib/knowledge/unsearchable";
import { unsearchableGroupQuerySchema } from "@/lib/schemas/knowledge-base";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/knowledge/unsearchable — WHICH documents the index
 * holds but cannot search, not just how many (#935).
 *
 * The reindex status route already reports `unsearchable` as a count. A count
 * nobody can expand is the silent half of a known gap: the agent answers "I
 * found nothing" and the reader hears a statement about the world rather than
 * about the index. Named after that counter on purpose — `totals.no_text` is
 * the list behind it, and `unreadable` is the word the docs already spend on
 * `failed`, which (see lib/knowledge/unsearchable.ts) is the one state this
 * cannot show. It also lists what the counter never counts: Word and
 * PowerPoint files search leaves out until they are converted again
 * (`totals.awaiting_conversion`).
 *
 * Wider window than the counter, though: a run counts only what it processed,
 * this answers for everything currently in scope. Callers rendering the two
 * together must say which is which.
 *
 * Two answers, because a list of thousands is read folder by folder (#1364):
 *
 * - Without a query: the summary — totals per reason, the count per cause of
 *   the no-text ones, and the count per group (a grant and one folder below
 *   it). No document names; the page fetches those per group.
 * - With `?root=<grant>[&folder=<name>]`: the first page of that one group's
 *   documents and the group's untruncated total. The CSV route
 *   (`./csv`) streams all of them.
 *
 * Why a no-text document has no text is the SERVER's answer (#1362): whether
 * a run started now would read scans depends on `PINCHY_KB_OCR` and on which
 * vision model is available, and only the server knows either. The page
 * renders the cause it is given rather than guessing one.
 *
 * Scope: the agent's SAVED `pinchy-files` grants — the same allow-list that
 * scopes retrieval, resolved from the same place. Never from the request: a
 * path parameter here would turn a diagnostics panel into a way to enumerate
 * documents the agent was never granted. The group's `root` only picks one of
 * those grants; the query answers nothing for a root outside them.
 *
 * `searchesIndex` says who converts those files: Pinchy queues that run on its
 * own only for an agent with `knowledge_search` (office-format-upgrade.ts), so
 * for any other agent it takes a reindex.
 *
 * Admin-only and access-gated, like the reindex it explains: the scope comes
 * from the agent's grants, so the caller has to be allowed to see the agent
 * first. Another user's personal agent answers 404 — same answer as an id
 * nobody ever issued, see getAgentWithAccess's docblock.
 */
// audit-exempt: read-only projection of already-stored index state, no state change.
export const GET = withAdmin<RouteContext>(async (request, { params }, session) => {
  const query = request.nextUrl.searchParams;
  const parsed = unsearchableGroupQuerySchema.safeParse({
    root: query.get("root") ?? undefined,
    folder: query.get("folder") ?? undefined,
  });
  if (!parsed.success) return formatValidationError(parsed.error);

  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const allowedPaths = grantedDataPaths(agent.pluginConfig as AgentPluginConfig | null);
  const ocr = await kbOcrAvailability();

  // Both queries deny by default on an empty grant list, so an agent granted
  // nothing reports nothing rather than the whole corpus.
  const { root, folder } = parsed.data;
  if (root !== undefined) {
    const page = await listUnsearchableDocuments(DEFAULT_ORG_ID, allowedPaths, ocr, {
      group: { root, folder: folder ?? null },
    });
    return NextResponse.json(page);
  }

  const summary = await summarizeUnsearchableDocuments(DEFAULT_ORG_ID, allowedPaths, ocr);
  return NextResponse.json({
    ...summary,
    searchesIndex: agent.allowedTools.includes("knowledge_search"),
  });
});
