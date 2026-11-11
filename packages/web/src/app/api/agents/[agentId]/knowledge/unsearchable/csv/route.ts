import { posix } from "node:path";
import { NextResponse } from "next/server";

import { withAdmin } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { type AgentPluginConfig } from "@/db/schema";
import { grantedDataPaths } from "@/lib/agent-granted-paths";
import { csvField, csvFileStem } from "@/lib/csv";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { kbOcrAvailability } from "@/lib/knowledge/kb-ocr";
import { unsearchableDocumentPages, type UnsearchableDocument } from "@/lib/knowledge/unsearchable";

type RouteContext = { params: Promise<{ agentId: string }> };

/** Why a document is unsearchable, in the words the Index section uses. */
function reasonText(doc: UnsearchableDocument): string {
  if (doc.reason === "awaiting_conversion") return "Waiting to be converted again";
  switch (doc.cause) {
    case "ocr_off":
      return "No text layer; reading scans is switched off on this server";
    case "no_vision_model":
      return "No text layer; no vision model is available to read it";
    case "read_next_run":
      return "Not read yet; the next run reads it";
    case "read_failed":
      return "Couldn't be read; the server log names the reason";
    case "read_blank":
    default:
      return "Read in full by a vision model; no text found";
  }
}

/**
 * The folder as an admin reads it: the granted folder's own name, then the
 * path below it. "/data/hr" + "Zertifikate/2024" becomes "hr/Zertifikate/2024"
 * — enough to tell two grants apart without repeating the mount point.
 */
function folderText(doc: UnsearchableDocument): string {
  const grant = posix.basename(doc.root) || doc.root;
  return doc.folder ? `${grant}/${doc.folder}` : grant;
}

const COLUMNS = ["name", "folder", "reason", "status", "path"] as const;

/**
 * GET /api/agents/[agentId]/knowledge/unsearchable/csv — every document the
 * index holds but cannot search, as a CSV (#1364). The Index section lists
 * the first hundred of each folder; a share with thousands of scans is read in
 * a spreadsheet, so the download is the whole list rather than a longer page.
 *
 * Streamed page by page (`unsearchableDocumentPages`), so neither Postgres nor
 * this process holds the whole list. The cost of streaming: a failure after
 * the first page cannot become a 500 — it breaks the transfer instead, which a
 * browser reports as a failed download rather than a shorter file.
 *
 * The reason column carries the server's answer to why a document has no
 * text (#1362) — whether scans are read at all on this server and with which
 * vision model — not a guess.
 *
 * Scope: the agent's SAVED `pinchy-files` grants, the same allow-list as the
 * JSON route beside it. Never from the request.
 *
 * Admin-only and access-gated like the Index section it belongs to. Another
 * user's personal agent answers 404, same as an id nobody issued.
 */
// audit-exempt: read-only projection of already-stored index state, no state change.
export const GET = withAdmin<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const allowedPaths = grantedDataPaths(agent.pluginConfig as AgentPluginConfig | null);
  const ocr = await kbOcrAvailability();

  // Denies by default on an empty grant list: an agent granted nothing yields
  // a header and no rows.
  const pages = unsearchableDocumentPages(DEFAULT_ORG_ID, allowedPaths, ocr);
  const encoder = new TextEncoder();
  let headerSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        // The BOM is what makes Excel read the file as UTF-8. Without it a
        // German share's "Prüfbericht.pdf" opens as "PrÃ¼fbericht.pdf".
        controller.enqueue(encoder.encode(`﻿${COLUMNS.map(csvField).join(",")}\n`));
        return;
      }
      const next = await pages.next();
      if (next.done) {
        controller.close();
        return;
      }
      let chunk = "";
      for (const doc of next.value) {
        chunk +=
          [doc.name, folderText(doc), reasonText(doc), doc.status, doc.sourcePath]
            .map(csvField)
            .join(",") + "\n";
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
      "Content-Disposition": `attachment; filename="${csvFileStem(agent.name)}-unsearchable-documents.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
