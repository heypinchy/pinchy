// audit-exempt: read-only, no state change (see AGENTS.md § audit rules).
// Still deliberately audited below (knowledge.source_viewed) for governance —
// the ESLint require-audit-log rule only gates POST/PUT/PATCH/DELETE, so this
// comment documents intent for a human reader rather than satisfying the rule.
import { NextResponse } from "next/server";
import { stat, readFile } from "node:fs/promises";
import { basename } from "node:path";

import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { deferAuditLog } from "@/lib/audit-deferred";
import type { AuditLogEntry } from "@/lib/audit";
import { resolveAllowedFile } from "@/lib/agent-file-access";
import { contentTypeForFile } from "@/lib/agent-file-content-type";
import type { AgentPluginConfig } from "@/db/schema";

type Params = { params: Promise<{ agentId: string }> };

// Defense in depth against loading an oversized file fully into memory. Well
// above any real KB source PDF; mirrors pinchy-files' MAX_PDF_FILE_SIZE (50MB)
// in packages/plugins/pinchy-files/validate.ts (a separate package, so the
// constant is duplicated rather than imported).
const MAX_SERVE_FILE_SIZE = 50 * 1024 * 1024;

function sourceViewedAuditEntry(args: {
  userId: string;
  agentId: string;
  agentName: string | null;
  documentName: string;
  outcome: "success" | "failure";
  reason?: string;
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

  let info;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- realPath is containment-checked by resolveAllowedFile above
    info = await stat(realPath);
  } catch {
    deferAuditLog(
      sourceViewedAuditEntry({
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName: basename(realPath),
        outcome: "failure",
        reason: "not_found",
      })
    );
    return new NextResponse("Not found", { status: 404 });
  }

  // Only regular files. A directory (or anything else — socket, FIFO, ...)
  // is not servable content; treat it the same as "missing" rather than
  // disclosing what it actually is.
  if (!info.isFile()) {
    deferAuditLog(
      sourceViewedAuditEntry({
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName: basename(realPath),
        outcome: "failure",
        reason: "not_a_file",
      })
    );
    return new NextResponse("Not found", { status: 404 });
  }

  if (info.size > MAX_SERVE_FILE_SIZE) {
    deferAuditLog(
      sourceViewedAuditEntry({
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName: basename(realPath),
        outcome: "failure",
        reason: "file_too_large",
      })
    );
    return new NextResponse("File too large", { status: 413 });
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- realPath is containment-checked by resolveAllowedFile above
  const buffer = await readFile(realPath);
  const documentName = basename(realPath);
  const { contentType, disposition } = contentTypeForFile(realPath);

  deferAuditLog(
    sourceViewedAuditEntry({
      userId: session.user.id!,
      agentId: agent.id,
      agentName: agent.name,
      documentName,
      outcome: "success",
    })
  );

  return new NextResponse(Uint8Array.from(buffer), {
    headers: {
      "content-type": contentType,
      "content-length": String(buffer.byteLength),
      "cache-control": "private, max-age=3600",
      // nosniff so the browser can never override our extension-derived
      // Content-Type via its own MIME sniffing — the anti-XSS control that
      // makes the inline/attachment split above meaningful.
      "x-content-type-options": "nosniff",
      "content-disposition": `${disposition}; filename="${documentName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(documentName)}`,
      // Only relevant for the inline (PDF) case: without this override
      // Next.js emits X-Frame-Options: DENY by default, which blocks a
      // same-origin <embed>/<iframe> PDF viewer (see uploads/[filename]/route.ts
      // for the same gotcha with the same fix).
      ...(disposition === "inline" ? { "x-frame-options": "SAMEORIGIN" } : {}),
    },
  });
});
