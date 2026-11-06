import { NextResponse } from "next/server";
import { resolve } from "node:path";

import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { getAgentWithAccess } from "@/lib/agent-access";
import { resolveAllowedFile } from "@/lib/agent-file-access";
import { findCitedPassage } from "@/lib/knowledge/cited-passage";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { embedTexts } from "@/lib/knowledge/embeddings";
import { kbEmbedderAvailable, kbEmbeddingConfig } from "@/lib/knowledge/kb-embedder";
import { errorLine } from "@/lib/log-line";
import { citedPassageSchema } from "@/lib/schemas/knowledge-base";
import type { AgentPluginConfig } from "@/db/schema";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * POST /api/agents/[agentId]/knowledge/passage — which indexed passage on a
 * cited page the answer drew on, so the citation viewer can highlight it
 * (#1268). See lib/knowledge/cited-passage.ts for how it is chosen.
 *
 * It returns document text, so it refuses exactly what the file route
 * (`workspace-file`) refuses, through the same two gates in the same order:
 * the agent gate, then the agent's saved `pinchy-files` grants. Both run
 * before the index is read — a path outside the grant must not become a way to
 * read the chunks of a document the reader cannot open.
 *
 * POST although it reads: the body carries the answer's claim, which is
 * conversation text and stays out of URLs and access logs.
 */
// audit-exempt: read-only lookup. It accompanies a document view that the workspace-file route already audits (knowledge.source_viewed), and returns text from the document that view hands over whole.
export const POST = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const parsed = await parseRequestBody(citedPassageSchema, request);
  if ("error" in parsed) return parsed.error;
  const { path, page, claim } = parsed.data;

  const allowedPaths =
    (agent.pluginConfig as AgentPluginConfig | null)?.["pinchy-files"]?.allowed_paths ?? [];
  const resolved = await resolveAllowedFile(path, allowedPaths);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.status === 403 ? "Forbidden" : "Not found" },
      { status: resolved.status }
    );
  }

  // Keyed on what the grant check looked at — the normalised path — plus the
  // file it resolves to: a grant root may itself be a link, and the index can
  // hold either spelling.
  const sourcePaths = [...new Set([resolve(path), resolved.realPath])];
  const deps = kbEmbedderAvailable()
    ? { embed: (texts: string[]) => embedTexts(texts, kbEmbeddingConfig()) }
    : null;

  try {
    const passage = await findCitedPassage(DEFAULT_ORG_ID, sourcePaths, page, claim, deps);
    return NextResponse.json({ passage });
  } catch (err) {
    // The viewer shows the page without a highlight on any failure, so this
    // costs the reader nothing they had before — but it must not be silent.
    console.error(`[knowledge/passage] lookup failed: ${errorLine(err)}`);
    return NextResponse.json({ error: "Passage lookup failed" }, { status: 502 });
  }
});
