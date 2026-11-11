import { NextResponse } from "next/server";

import { withAdmin } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { type AgentPluginConfig } from "@/db/schema";
import { grantedDataPaths } from "@/lib/agent-granted-paths";
import { csvField, csvFileStem } from "@/lib/csv";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { listUnsupportedFiles } from "@/lib/knowledge/unsupported-files";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/knowledge/unsupported — a CSV of the files under
 * the agent's folders whose type the indexer cannot read (#1267): a `.tif`
 * scan, a legacy `.xls`, a `.txt`. The reindex status counts them
 * (`counts.unsupported`); this names them, with path and type, so an admin can
 * convert them or tell users what the agent cannot see.
 *
 * A download rather than a JSON list beside the unsearchable one, because of
 * scale: a real share holds 100k+ such files, which no panel shows usefully and
 * every spreadsheet sorts and filters. Streamed page by page
 * (`listUnsupportedFiles`), so neither Postgres nor this process holds the
 * whole list. The cost of streaming: a failure after the first page cannot
 * become a 500 — it breaks the transfer instead, which a browser reports as a
 * failed download rather than a shorter file.
 *
 * As of the last run that reached the end, not as of this second: the list is
 * written by the indexer (unsupported-files.ts), never by walking the share
 * here.
 *
 * Scope: the agent's SAVED `pinchy-files` grants — the same allow-list that
 * scopes retrieval. Never from the request: a path parameter would turn this
 * into a way to list any folder on the host.
 *
 * Admin-only and access-gated like the reindex it belongs to. Another user's
 * personal agent answers 404, same as an id nobody issued.
 */
// audit-exempt: read-only projection of what the indexer recorded, no state change.
export const GET = withAdmin<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const allowedPaths = grantedDataPaths(agent.pluginConfig as AgentPluginConfig | null);

  // Denies by default on an empty grant list: an agent granted nothing yields
  // a header and no rows.
  const pages = listUnsupportedFiles(DEFAULT_ORG_ID, allowedPaths);
  const encoder = new TextEncoder();
  let headerSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        // The BOM is what makes Excel read the file as UTF-8. Without it a
        // German share's "Prüfbericht.tif" opens as "PrÃ¼fbericht.tif".
        controller.enqueue(encoder.encode(`\uFEFF${csvField("path")},${csvField("type")}\n`));
        return;
      }
      const next = await pages.next();
      if (next.done) {
        controller.close();
        return;
      }
      let chunk = "";
      for (const file of next.value) {
        chunk += `${csvField(file.sourcePath)},${csvField(file.type)}\n`;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    async cancel() {
      // The admin cancelled the download: stop paging.
      await pages.return(undefined);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFileStem(agent.name)}-unsupported-files.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
