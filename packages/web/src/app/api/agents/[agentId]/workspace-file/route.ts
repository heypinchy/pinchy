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
import { getOfficeArtifactStore, hashFileContents } from "@/lib/knowledge/office-artifacts";
import { convertedPdfName, isOfficeFile } from "@/lib/knowledge/office-formats";
import type { AgentPluginConfig } from "@/db/schema";

type Params = { params: Promise<{ agentId: string }> };

/**
 * Which representation of one document the caller wants.
 *
 * An Office source has two, and they answer different needs: the reader looks
 * at the CONVERTED PDF (a `.doc` renders in no browser) and sends a customer
 * the ORIGINAL (the file that exists on their drive). Both are the same
 * document, which is why this is a parameter on one route rather than a second
 * route with a second access check to keep in step.
 *
 * Absent means "whatever this document is meant to be LOOKED at as", which is
 * the converted PDF for an Office source and the file itself for everything
 * else. That default is what keeps `buildSourceHref` — and every citation
 * already rendered — unchanged: a viewer asks for the document, not for a
 * representation of it.
 */
type Variant = "original" | "converted";

/**
 * Three answers, not two: the variant itself, `null` for "not named" (serve
 * what this document is meant to be looked at as), and `undefined` for "named
 * something that is not a variant" — which is a 400, not a default. A parser
 * that folded the last two together would answer an unknown `variant=` with a
 * document, and a client with a typo would never learn it had one.
 */
function parseVariant(raw: string | null): Variant | null | undefined {
  if (raw === null) return null;
  return raw === "original" || raw === "converted" ? raw : undefined;
}

/**
 * The stored PDF for an Office source, or null when there is none to serve.
 *
 * ## Why this cannot widen what a request can reach
 *
 * The artifact store lives OUTSIDE `/data` — it has to, because `/data` is
 * mounted read-only and that is a product promise (#936) — so it is outside
 * `FILE_SERVE_ROOTS` and `resolveAllowedFile` would refuse every artifact.
 * Containment is therefore re-argued rather than reused, and it rests on two
 * facts:
 *
 *   1. This is reached ONLY after `resolveAllowedFile` accepted the ORIGINAL
 *      path. An artifact is exactly as reachable as the document it was
 *      converted from, never more.
 *   2. The artifact path is DERIVED, never requested: `pathFor` re-hashes its
 *      argument, so what is opened is `<root>/v<n>/ab/<64 hex>.pdf` — a shape
 *      no caller-supplied string can steer, whatever it contains.
 *
 * ## Why this is also the staleness check
 *
 * The store is keyed on the source's content hash, so an artifact is only
 * found while the bytes it was converted from are still the bytes on disk.
 * Replace the document on the share and the key moves with it: the old
 * artifact becomes unreachable in the same instant, with no invalidation pass
 * to run and no window in which a reader is shown a document that no longer
 * exists. The cost is a hash per request, paid on a file small enough that
 * LibreOffice converted it in about a second.
 */
async function resolveConvertedArtifact(realPath: string): Promise<string | null> {
  if (!isOfficeFile(realPath)) return null;
  try {
    return await getOfficeArtifactStore().get(await hashFileContents(realPath));
  } catch {
    // An unreadable source, or an artifact volume that is missing, full or not
    // mounted. Neither is a verdict on this document and neither is worth a
    // 500: the answer is the same as "not converted yet", and the ORIGINAL
    // download keeps working throughout.
    return null;
  }
}

/**
 * Reading a cited document and taking a copy of it out of the building are
 * different acts, so they are different rows: `knowledge.source_viewed` for the
 * pane, `knowledge.source_downloaded` for the copy. Same read, same gate, same
 * detail shape — the event type is the only thing that differs, and it is the
 * thing an analyst filters on when the question is "who has this file now".
 *
 * Chosen by the caller rather than inferred from the response, because the
 * disposition alone cannot tell them apart: a .docx is served `attachment`
 * whether the user opened it or saved it.
 */
type SourceAccessEvent = "knowledge.source_viewed" | "knowledge.source_downloaded";

function sourceAccessAuditEntry(args: {
  eventType: SourceAccessEvent;
  userId: string;
  agentId: string;
  agentName: string | null;
  documentName: string;
  outcome: "success" | "failure";
  reason?: string;
  partial?: boolean;
  representation?: Variant;
}): AuditLogEntry {
  return {
    actorType: "user",
    actorId: args.userId,
    eventType: args.eventType,
    resource: `agent:${args.agentId}`,
    outcome: args.outcome,
    // The actor lives in `actorId` ONLY — appendAuditLog pseudonymizes that
    // column (resolveActorId) for GDPR crypto-erasure, while `detail` is
    // stored verbatim. A raw users.id repeated here would be un-erasable in
    // an HMAC-chained row, and redundant besides (#824).
    detail: {
      agent: { id: args.agentId, name: args.agentName ?? args.agentId },
      // Always the SOURCE document's name, even when the bytes served are its
      // converted PDF: the artifact is named for its content key, and a row
      // saying `3f9a2c….pdf` names nothing an analyst can act on. Which of the
      // two representations actually left is a separate field, because "who
      // took the spec sheet" and "in which format" are different questions.
      document: { name: args.documentName },
      ...(args.representation !== undefined ? { representation: args.representation } : {}),
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

  // The reader asked to keep the file rather than look at it. Two consequences,
  // and both have to be decided here rather than in the browser: the response
  // is forced to `attachment` (a `download` attribute on the link would do it
  // too, but only for a same-origin fetch, and it would leave the server
  // believing every download was a view), and the audit row says so.
  const isDownload = req.nextUrl.searchParams.get("download") === "1";
  const eventType: SourceAccessEvent = isDownload
    ? "knowledge.source_downloaded"
    : "knowledge.source_viewed";

  // Rejected before any path is resolved and before any audit row is written:
  // a request naming a representation that does not exist has not asked for a
  // document, so there is no access decision to record about one.
  const variant = parseVariant(req.nextUrl.searchParams.get("variant"));
  if (variant === undefined) {
    return NextResponse.json(
      { error: "variant must be 'original' or 'converted'" },
      { status: 400 }
    );
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
        sourceAccessAuditEntry({
          eventType,
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
      sourceAccessAuditEntry({
        eventType,
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
      sourceAccessAuditEntry({
        eventType,
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName,
        outcome: "failure",
        reason,
      })
    );
  };

  // Which representation is actually served. `converted` is asked for
  // explicitly by the second download control, and implicitly by any viewer
  // opening an Office source — a `.doc` renders in no browser, so the document
  // a reader was promised IS the converted PDF.
  const wantsConverted = variant === "converted" || (variant === null && isOfficeFile(realPath));
  const artifactPath = wantsConverted ? await resolveConvertedArtifact(realPath) : null;
  if (wantsConverted && artifactPath === null) {
    // Falling back to the original here would be worse than answering nothing:
    // it is served `attachment`, so a viewer's <embed> would turn an
    // unconverted document into a surprise download rather than a preview.
    auditFailure("no_converted_artifact");
    return new NextResponse("Not found", { status: 404 });
  }

  const servedPath = artifactPath ?? realPath;
  const servedName = artifactPath ? convertedPdfName(documentName) : documentName;
  const representation: Variant = artifactPath ? "converted" : "original";

  // Open FIRST, then stat the open handle rather than re-stat the path: a
  // stat-then-open pair is a TOCTOU race (js/file-system-race), and the
  // handle's own stat is authoritative for the bytes we are about to serve.
  // Same posture as `serve-workspace-file.ts`.
  let fh;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- servedPath is either realPath (containment-checked by resolveAllowedFile above) or an artifact path derived from the store's content key, which no request input can steer — see resolveConvertedArtifact.
    fh = await open(servedPath, "r");
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

  // `attachment` is the stricter of the two, so forcing it can only narrow what
  // the browser is allowed to do with these bytes — it never relaxes the
  // extension-derived anti-XSS split, it only ever overrides `inline`.
  // Derived from the name the bytes are SERVED under, not from the source's:
  // the converted artifact is a PDF and has to be typed and dispositioned as
  // one, or the viewer gets an `application/msword` attachment where it asked
  // for something to render.
  const { contentType, disposition: servedDisposition } = contentTypeForFile(servedName);
  const disposition = isDownload ? "attachment" : servedDisposition;

  deferAuditLog(
    sourceAccessAuditEntry({
      eventType,
      userId: session.user.id!,
      agentId: agent.id,
      agentName: agent.name,
      documentName,
      outcome: "success",
      partial: isPartial,
      representation,
    })
  );

  // The bytes are streamed off disk, never materialised: a knowledge base
  // legitimately contains documents larger than this process's memory (the
  // corpus this was built against has a 268 MB scanned binder, and it is also
  // its most-cited document). `createReadStream` on the already-open handle
  // closes it when the stream ends OR when the client disconnects mid-download.
  //
  // A body nobody ever touches does NEITHER, and that is reachable: Next.js
  // auto-implements HEAD by calling this handler and then discarding the body
  // unread (`send-response.js` skips `pipeToNodeResponse` for HEAD), so a
  // streamed HEAD parks the descriptor until a GC that may never come. On a
  // route proxies and PDF viewers probe with HEAD, that is a descriptor leak
  // per request. HEAD wants the headers anyway, so close the handle and answer
  // without a body — which is also what the method is defined to return.
  const wantsBody = req.method !== "HEAD" && contentLength > 0;
  const body = wantsBody
    ? (Readable.toWeb(fh.createReadStream({ start, end })) as ReadableStream<Uint8Array>)
    : (await fh.close(), null);

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
      "content-disposition": `${disposition}; filename="${servedName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(servedName)}`,
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
