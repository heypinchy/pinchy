// audit-exempt: read-only, no state change (see AGENTS.md § audit rules).
// Still deliberately audited below (knowledge.source_viewed) for governance —
// the ESLint require-audit-log rule only gates POST/PUT/PATCH/DELETE, so this
// comment documents intent for a human reader rather than satisfying the rule.
import { NextResponse } from "next/server";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename } from "node:path";

import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { deferAuditLog } from "@/lib/audit-deferred";
import type { AuditLogEntry } from "@/lib/audit";
import { resolveAllowedFile } from "@/lib/agent-file-access";
import { contentTypeForFile } from "@/lib/agent-file-content-type";
import { parseRangeHeader } from "@/lib/http-range";
import type { AgentPluginConfig } from "@/db/schema";

type Params = { params: Promise<{ agentId: string }> };

function sourceViewedAuditEntry(args: {
  userId: string;
  agentId: string;
  agentName: string | null;
  documentName: string;
  outcome: "success" | "failure";
  reason?: string;
  partial?: boolean;
}): AuditLogEntry {
  return {
    actorType: "user",
    actorId: args.userId,
    eventType: "knowledge.source_viewed",
    resource: `agent:${args.agentId}`,
    outcome: args.outcome,
    detail: {
      userId: args.userId,
      agent: { id: args.agentId, name: args.agentName ?? args.agentId },
      document: { name: args.documentName },
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      // A PDF viewer fetches a large document as a series of ranges, so one
      // opened document produces several rows. Every access stays logged —
      // reading a file in chunks must not be a way to read it unobserved — and
      // this flag is what lets an analyst count views rather than chunks.
      ...(args.partial !== undefined ? { partial: args.partial } : {}),
    },
  };
}

/**
 * Access-controlled serve of a file under an agent's `pinchy-files`
 * allowed_paths (the SAME admin-configured allowlist that already scopes the
 * agent's file tools and its knowledge-base retrieval — see
 * `/api/internal/knowledge/search`). This is the shared mechanism for a user
 * to open a knowledge-base citation's source PDF in the browser (and, later,
 * a general "agent, give me file X" flow) — a browser-facing route callable
 * with the user's own session, NOT the gateway token.
 *
 * Security-critical (file-exfiltration surface): see `agent-file-access.ts`
 * for the two-stage lexical + real-path containment defense. Deny by
 * default — every branch below that denies access returns BEFORE the file is
 * read, and out-of-scope paths always 403 (never 404) so a probe can't learn
 * whether a given out-of-scope path exists.
 */
export const GET = withAuth<Params>(async (req, { params }, session) => {
  const { agentId } = await params;

  // Access check FIRST — same gate as the chat itself, and the same helper
  // every other agent-scoped route uses (see uploads/[filename]/route.ts,
  // active-error/route.ts). Forwarded verbatim to keep the leak surface
  // identical across agent routes.
  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const requestedPath = req.nextUrl.searchParams.get("path");
  if (!requestedPath) {
    return NextResponse.json({ error: "Missing path query parameter" }, { status: 400 });
  }

  // Same allowlist source as knowledge_search's retrieval scope (see
  // /api/internal/knowledge/search/route.ts): an agent's file-serving scope
  // is exactly the folders an admin has granted it, no separate allowlist to
  // drift. An empty/missing list denies by default.
  const allowedPaths =
    (agent.pluginConfig as AgentPluginConfig | null)?.["pinchy-files"]?.allowed_paths ?? [];

  const resolved = await resolveAllowedFile(requestedPath, allowedPaths);
  if (!resolved.ok) {
    if (resolved.status === 403) {
      deferAuditLog(
        sourceViewedAuditEntry({
          userId: session.user.id!,
          agentId: agent.id,
          agentName: agent.name,
          documentName: basename(requestedPath),
          outcome: "failure",
          reason: "outside_allowed_paths",
        })
      );
      return new NextResponse("Forbidden", { status: 403 });
    }
    deferAuditLog(
      sourceViewedAuditEntry({
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName: basename(requestedPath),
        outcome: "failure",
        reason: "not_found",
      })
    );
    return new NextResponse("Not found", { status: 404 });
  }

  const { realPath } = resolved;
  const documentName = basename(realPath);

  const auditFailure = (reason: string) => {
    deferAuditLog(
      sourceViewedAuditEntry({
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName,
        outcome: "failure",
        reason,
      })
    );
  };

  // Open FIRST, then stat the open handle rather than re-stat the path: a
  // stat-then-open pair is a TOCTOU race (js/file-system-race), and the
  // handle's own stat is authoritative for the bytes we are about to serve.
  // Same posture as `serve-workspace-file.ts`.
  let fh;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- realPath is containment-checked by resolveAllowedFile above
    fh = await open(realPath, "r");
  } catch {
    auditFailure("not_found");
    return new NextResponse("Not found", { status: 404 });
  }

  // From here every path that does NOT hand the handle to a stream must close
  // it, or the process leaks a descriptor per request.
  let info;
  try {
    info = await fh.stat();
  } catch {
    await fh.close();
    auditFailure("not_found");
    return new NextResponse("Not found", { status: 404 });
  }

  // Only regular files. A directory (or anything else — socket, FIFO, ...)
  // is not servable content; treat it the same as "missing" rather than
  // disclosing what it actually is. Note a directory opens successfully on
  // Linux and macOS, so this check is what rejects it.
  if (!info.isFile()) {
    await fh.close();
    auditFailure("not_a_file");
    return new NextResponse("Not found", { status: 404 });
  }

  const range = parseRangeHeader(req.headers.get("range"), info.size);
  if (range.kind === "unsatisfiable") {
    await fh.close();
    auditFailure("range_not_satisfiable");
    return new NextResponse("Range not satisfiable", {
      status: 416,
      // Tell the client the real length so it can retry correctly rather than
      // probe for it.
      headers: { "content-range": `bytes */${info.size}`, "accept-ranges": "bytes" },
    });
  }

  const isPartial = range.kind === "partial";
  const start = isPartial ? range.start : 0;
  const end = isPartial ? range.end : Math.max(0, info.size - 1);
  const contentLength = info.size === 0 ? 0 : end - start + 1;

  const { contentType, disposition } = contentTypeForFile(realPath);

  deferAuditLog(
    sourceViewedAuditEntry({
      userId: session.user.id!,
      agentId: agent.id,
      agentName: agent.name,
      documentName,
      outcome: "success",
      partial: isPartial,
    })
  );

  // The bytes are streamed off disk, never materialised: a knowledge base
  // legitimately contains documents larger than this process's memory (the
  // corpus this was built against has a 268 MB scanned binder, and it is also
  // its most-cited document). `createReadStream` on the already-open handle
  // closes it when the stream ends OR when the client disconnects mid-download.
  const body =
    contentLength === 0
      ? (await fh.close(), null)
      : (Readable.toWeb(fh.createReadStream({ start, end })) as ReadableStream<Uint8Array>);

  return new NextResponse(body, {
    status: isPartial ? 206 : 200,
    headers: {
      "content-type": contentType,
      "content-length": String(contentLength),
      // Advertised on every response: without it a viewer has no way to know it
      // may seek, so opening a citation at `#page=510` would pull the entire
      // document before rendering anything.
      "accept-ranges": "bytes",
      ...(isPartial ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}),
      "cache-control": "private, max-age=3600",
      // nosniff so the browser can never override our extension-derived
      // Content-Type via its own MIME sniffing — the anti-XSS control that
      // makes the inline/attachment split above meaningful.
      "x-content-type-options": "nosniff",
      "content-disposition": `${disposition}; filename="${documentName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(documentName)}`,
      // Declares the posture the inline (PDF) case wants: a same-origin
      // <embed>/<iframe> viewer may frame this, nothing else may.
      //
      // It is NOT what makes the viewer work. next.config.ts's `headers()`
      // applies `X-Frame-Options: DENY` to `/(.*)`, and that value OVERRIDES
      // whatever is set here — the URL's real value is decided there, by the
      // per-route SAMEORIGIN relaxation. Both this route and the artifacts
      // route shipped without one: a valid 200 the browser refuses to render
      // (net::ERR_BLOCKED_BY_RESPONSE, blank pane), while a line like this one
      // sat here looking sufficient. `frame-options-route-coverage.test.ts`
      // now fails CI if a serving route lacks its entry.
      ...(disposition === "inline" ? { "x-frame-options": "SAMEORIGIN" } : {}),
    },
  });
});
