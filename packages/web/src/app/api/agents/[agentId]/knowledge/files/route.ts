import { NextResponse } from "next/server";

import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { type AgentPluginConfig } from "@/db/schema";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { listKnowledgeFolderFiles, type FileFilter } from "@/lib/knowledge/index-status";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/knowledge/files?folder=…&filter=…&q=…&offset=…&limit=…
 * — one folder's files and whether search can use each (#1386).
 *
 * Same audience as the folders route: anyone who can chat with the agent.
 *
 * `folder` comes from the query string, so it is the one input here that is
 * not derived from the agent. It must be one of the agent's granted folders or
 * lie inside one — checked lexically and against the real path, so neither
 * `..` nor a link reaches past the grant. Anything else answers 404, the same
 * answer as a folder that does not exist: a member must not be able to probe
 * the share for names.
 */
// audit-exempt: read-only listing of files inside the agent's granted folders — the same files the agent can already read — and changes nothing.
export const GET = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const allowedPaths =
    (agentOrError.pluginConfig as AgentPluginConfig | null)?.["pinchy-files"]?.allowed_paths ?? [];

  const query = request.nextUrl.searchParams;
  const folder = query.get("folder");
  if (!folder) {
    return NextResponse.json({ error: "folder is required" }, { status: 400 });
  }
  const filter: FileFilter = query.get("filter") === "not_searchable" ? "not_searchable" : "all";
  const offset = Number.parseInt(query.get("offset") ?? "0", 10);
  const limit = Number.parseInt(query.get("limit") ?? "50", 10);

  const result = await listKnowledgeFolderFiles(DEFAULT_ORG_ID, agentId, allowedPaths, {
    folder,
    filter,
    q: query.get("q") ?? undefined,
    offset: Number.isFinite(offset) ? offset : 0,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  if (!result) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  return NextResponse.json(result);
});
