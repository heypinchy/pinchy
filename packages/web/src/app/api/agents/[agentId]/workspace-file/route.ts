// audit-exempt: read-only, no state change (see AGENTS.md § audit rules).
// Still deliberately audited below (knowledge.source_viewed) for governance —
// the ESLint require-audit-log rule only gates POST/PUT/PATCH/DELETE, so this
// comment documents intent for a human reader rather than satisfying the rule.
import { NextResponse } from "next/server";
import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename } from "node:path";

import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { deferAuditLog } from "@/lib/audit-deferred";
import type { AuditLogEntry } from "@/lib/audit";
import { resolveAllowedFile } from "@/lib/agent-file-access";
import { contentTypeForFile } from "@/lib/agent-file-content-type";
import { parseRangeHeader } from "@/lib/http-range";
import { errorLine, LOG_PATH_MAX, oneLine } from "@/lib/log-line";
import {
  getOfficeArtifactStore,
  hashOpenFile,
  liveStagingDirOf,
} from "@/lib/knowledge/office-artifacts";
import {
  convertedPdfName,
  isOfficeFile,
  isSpreadsheetFile,
  OfficeFileRejectedError,
} from "@/lib/knowledge/office-formats";
import { SHEET_RANGE_MAX_ROWS, XlsxExtractionError } from "@/lib/knowledge/xlsx-extract";
import { XLSX_MAX_FILE_BYTES } from "@/lib/knowledge/office-preflight";
import {
  checkSheetReaderQueue,
  readSheetRangeIsolated,
  SHEET_PREVIEW_MAX_QUEUED,
  SheetReaderBusyError,
  SheetReaderCancelledError,
} from "@/lib/knowledge/xlsx-isolated";
import {
  copyOpenSource,
  openVerifiedSource,
  SourceRefusedError,
  type VerifiedCopy,
  type VerifiedSource,
} from "@/lib/knowledge/verified-source";
import type { AgentPluginConfig } from "@/db/schema";
import {
  ifNoneMatchHits,
  rangeAllowedByIfRange,
  sessionScopedRevalidateHeaders,
  weakFileEtag,
  weakStoredFileEtag,
} from "@/lib/session-scoped-cache";

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
type Variant = "original" | "converted" | "rows";

/**
 * Three answers, not two: the variant itself, `null` for "not named" (serve
 * what this document is meant to be looked at as), and `undefined` for "named
 * something that is not a variant" — which is a 400, not a default. A parser
 * that folded the last two together would answer an unknown `variant=` with a
 * document, and a client with a typo would never learn it had one.
 */
function parseVariant(raw: string | null): Variant | null | undefined {
  if (raw === null) return null;
  return raw === "original" || raw === "converted" || raw === "rows" ? raw : undefined;
}

/**
 * The row range a spreadsheet preview asks for — and `undefined` when the
 * request is malformed, which is a 400 for the same reason an unknown
 * `variant=` is: a client with a typo must learn it had one rather than
 * silently receive a different slice.
 *
 * Naming NOTHING is not a typo: a bare workbook citation carries no sheet and
 * no rows, and asks for the top of the workbook — `sheet: null` resolves to
 * the first visible sheet (see `readSheetRange`). A PARTIAL range, in
 * contrast, is a typo and stays a 400.
 */
function parseSheetRange(
  params: URLSearchParams
): { sheet: string | null; startRow: number; endRow: number } | undefined {
  const sheet = params.get("sheet");
  const from = params.get("from");
  const to = params.get("to");
  if (sheet === null && from === null && to === null) {
    return { sheet: null, startRow: 1, endRow: SHEET_RANGE_MAX_ROWS };
  }
  if (sheet === null || sheet === "" || from === null || to === null) return undefined;
  const startRow = Number(from);
  const endRow = Number(to);
  if (
    !Number.isInteger(startRow) ||
    !Number.isInteger(endRow) ||
    startRow < 1 ||
    endRow < startRow
  ) {
    return undefined;
  }
  return { sheet, startRow, endRow };
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
 *
 * The hash is read through the VERIFIED descriptor, never the path: the store
 * is keyed on content, so hashing whatever a link swapped in after the
 * containment check would find — and serve, under this document's name — the
 * conversion of a file this reader may not see.
 */
async function resolveConvertedArtifact(
  source: VerifiedSource,
  realPath: string
): Promise<string | null> {
  if (!isOfficeFile(realPath)) return null;
  try {
    return await getOfficeArtifactStore().get(await hashOpenFile(source.handle));
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
  revalidated?: boolean;
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
      // A 304: the reader looked at the copy their browser already held, after
      // the access check allowed it. `partial` still says whether a chunk was
      // asked for, so a viewer re-reading in ranges counts as one view.
      ...(args.revalidated ? { revalidated: true } : {}),
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
      { error: "variant must be 'original', 'converted' or 'rows'" },
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

  // Every read of the document goes through ONE verified open of `realPath`
  // (lib/knowledge/verified-source.ts): no link followed, a regular file, and
  // the descriptor really at that path. `resolveAllowedFile` checked the path;
  // this is what keeps a link swapped in after that check from being followed
  // by the read. Answered 404 like a missing file, so the reader learns
  // nothing about what the link pointed at — the audit row says why.
  const openSource = async (): Promise<VerifiedSource | null> => {
    try {
      return await openVerifiedSource(realPath);
    } catch (err) {
      if (err instanceof SourceRefusedError) {
        auditFailure(err.refusal === "not_a_file" ? "not_a_file" : `refused_${err.refusal}`);
      } else {
        auditFailure("not_found");
      }
      return null;
    }
  };

  // A spreadsheet preview answers with the cited ROWS rather than with bytes.
  //
  // It rides this route rather than getting its own for the reason the variant
  // parameter exists at all: one access check, one audit row, one place where
  // "which document may this reader see" is decided. Reading rows IS looking at
  // the document, so it writes the same `knowledge.source_viewed` row as any
  // other view — a second event type would split one act across two filters.
  if (variant === "rows") {
    const range = parseSheetRange(req.nextUrl.searchParams);
    if (!range) {
      return NextResponse.json(
        {
          error:
            "rows takes sheet, from and to together (from >= 1, to >= from) — or none of them, for the top of the workbook",
        },
        { status: 400 }
      );
    }
    if (!isSpreadsheetFile(realPath)) {
      // Asking for rows of a PDF is a client defect, not a missing document.
      return NextResponse.json({ error: "not a spreadsheet" }, { status: 400 });
    }

    // The reader takes a path, so it is handed a private copy of the
    // workbook, streamed from the verified descriptor onto the staging
    // volume: never the share's path (a link swapped in after the check would
    // be followed). The copy is streamed; the workbook reader then loads that
    // copy in its heap-capped child (xlsx-isolated.ts).
    const tooLarge = () => {
      auditFailure("document_too_large");
      return NextResponse.json({ error: "The workbook is too large to read" }, { status: 413 });
    };
    const busy = () => {
      auditFailure("reader_busy");
      return NextResponse.json(
        { error: "Too many spreadsheet previews are being read right now. Try again shortly." },
        { status: 503, headers: { "retry-after": "10" } }
      );
    };

    const source = await openSource();
    if (!source) return new NextResponse("Not found", { status: 404 });
    let copy: VerifiedCopy;
    try {
      // Both refusals come before the copy, which writes the workbook to the
      // staging volume. A workbook past the reader's limit is refused unopened
      // there anyway: copied first, it would cost its full size on every
      // reload, and on a volume too full to take it, answer "reader
      // unavailable" about a workbook that is simply too large. A preview the
      // queue will turn away would leave a copy for a read that never happens.
      // The descriptor's own size: the bytes the copy would read.
      if (source.stat.size > BigInt(XLSX_MAX_FILE_BYTES)) return tooLarge();
      try {
        checkSheetReaderQueue(SHEET_PREVIEW_MAX_QUEUED);
      } catch (err) {
        if (err instanceof SheetReaderBusyError) return busy();
        throw err;
      }
      // A file still being written can grow past that check while the copy
      // runs. One byte past the limit is all the reader needs to refuse it.
      copy = await copyOpenSource(source, realPath, liveStagingDirOf(), {
        maxBytes: XLSX_MAX_FILE_BYTES + 1,
      });
    } catch (err) {
      // The workbook was opened; only the copy could not be written — the
      // staging volume is full, read-only or missing. A fact about the
      // reader, not the workbook, so it is not audited as one.
      console.error(
        `[workspace-file] could not stage ${oneLine(documentName, LOG_PATH_MAX)} for reading:`,
        errorLine(err)
      );
      auditFailure("reader_unavailable");
      return NextResponse.json(
        { error: "The spreadsheet reader is unavailable right now. Try again shortly." },
        { status: 503 }
      );
    } finally {
      await source.handle.close();
    }

    let sheetRange;
    try {
      // In a heap-capped child process (xlsx-isolated.ts): exceljs costs
      // ~20× the sheet XML, and this route is reachable by any member with
      // agent access, uncached and repeatably. The web process never holds a
      // workbook's cell model.
      //
      // The request's signal goes along: a reader that reloads or closes the
      // dialog takes its read out of the queue, or has its child killed, and
      // `maxQueued` keeps reloads from stacking reads in front of the indexer.
      sheetRange = await readSheetRangeIsolated(
        copy.path,
        range.sheet,
        range.startRow,
        range.endRow,
        { signal: req.signal, maxQueued: SHEET_PREVIEW_MAX_QUEUED }
      );
    } catch (err) {
      if (err instanceof OfficeFileRejectedError && err.code === "too_large") {
        // Refused before exceljs inflated anything (a compressed bomb costs a
        // central-directory read, not a heap), or the child reading it ran out
        // of heap. Either way the server is still standing.
        return tooLarge();
      }
      if (err instanceof OfficeFileRejectedError || err instanceof XlsxExtractionError) {
        // The workbook is on disk and inside the grant but will not open. That
        // is a fact about the document, so it is audited like one.
        auditFailure("unreadable_document");
        return NextResponse.json({ error: "The workbook could not be read" }, { status: 422 });
      }
      if (err instanceof SheetReaderCancelledError) {
        // The reader went away first; nobody is waiting for this answer. Still
        // a row — the document was asked for — but not one that blames it.
        auditFailure("cancelled");
        return NextResponse.json({ error: "The request was cancelled" }, { status: 499 });
      }
      // The queue filled between the check above and this read.
      if (err instanceof SheetReaderBusyError) return busy();
      // Anything else is the READER failing, not the document: a child that
      // could not be started, was killed by the system or ran out of time.
      // Answering 422 and auditing
      // `unreadable_document` would write a false statement about the
      // document into an immutable row.
      // The name is the share's and the error can quote it: escaped, neither
      // writes a line of its own into the log.
      console.error(
        `[workspace-file] spreadsheet reader failed for ${oneLine(documentName, LOG_PATH_MAX)}:`,
        errorLine(err)
      );
      auditFailure("reader_unavailable");
      return NextResponse.json(
        { error: "The spreadsheet reader is unavailable right now. Try again shortly." },
        { status: 503 }
      );
    } finally {
      await copy.dispose();
    }

    deferAuditLog(
      sourceAccessAuditEntry({
        eventType,
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName,
        outcome: "success",
        // "Which representation left" is a separate question from "did one" —
        // same field the byte-serving path answers with original/converted.
        representation: "rows",
      })
    );
    // A named sheet the workbook does not have answers 200 with an empty range
    // rather than 404: the DOCUMENT was found and shown, and the citation
    // pointing into a sheet that is not there is what the reader needs to see.
    return NextResponse.json(sheetRange ?? { sheet: range.sheet ?? "", columns: [], rows: [] });
  }

  // Which representation is actually served. `converted` is asked for
  // explicitly by the second download control, and implicitly by any viewer
  // opening an Office source — a `.doc` renders in no browser, so the document
  // a reader was promised IS the converted PDF.
  const source = await openSource();
  if (!source) return new NextResponse("Not found", { status: 404 });

  const wantsConverted = variant === "converted" || (variant === null && isOfficeFile(realPath));
  const artifactPath = wantsConverted ? await resolveConvertedArtifact(source, realPath) : null;
  if (wantsConverted && artifactPath === null) {
    // Falling back to the original here would be worse than answering nothing:
    // it is served `attachment`, so a viewer's <embed> would turn an
    // unconverted document into a surprise download rather than a preview.
    await source.handle.close();
    auditFailure("no_converted_artifact");
    return new NextResponse("Not found", { status: 404 });
  }

  const servedPath = artifactPath ?? realPath;
  const servedName = artifactPath ? convertedPdfName(documentName) : documentName;
  const representation: Variant = artifactPath ? "converted" : "original";

  // The original is served from the verified descriptor itself. The artifact
  // is opened from the store — a path derived from the content key, which no
  // request input can steer (see resolveConvertedArtifact) — and the source's
  // descriptor is no longer needed once that path is known.
  //
  // Stat the open handle rather than re-stat the path: a stat-then-open pair
  // is a TOCTOU race (js/file-system-race), and the handle's own stat is
  // authoritative for the bytes we are about to serve.
  let fh: FileHandle;
  if (artifactPath) {
    await source.handle.close();
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- an artifact path derived from the store's content key, which no request input can steer — see resolveConvertedArtifact.
      fh = await open(servedPath, "r");
    } catch {
      auditFailure("not_found");
      return new NextResponse("Not found", { status: 404 });
    }
  } else {
    fh = source.handle;
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
  // disclosing what it actually is. The original was already checked by
  // `openSource`; this is the artifact's check.
  if (!info.isFile()) {
    await fh.close();
    auditFailure("not_a_file");
    return new NextResponse("Not found", { status: 404 });
  }

  // The browser keeps this document `no-cache`, so every reuse of its copy
  // arrives here as a conditional request — past the agent-access and
  // allowed_paths checks above, which is the point: a revoked grant answers
  // 403 here, never 304. Only an unchanged document the reader may still see
  // is answered 304, without its bytes. A 304 is the reader looking at the
  // document again, so it is audited as a view like any other.
  // The artifact store touches each artifact on read, so its timestamps move
  // every request; its content-addressed path identifies it instead. That
  // path comes from hashing the source in full (resolveConvertedArtifact),
  // which therefore runs before a 304 too: the hash is what tells a current
  // conversion from one of a document since replaced, so it cannot be skipped
  // for a reuse. A 304 saves sending the PDF, not reading the source.
  const etag = artifactPath
    ? weakStoredFileEtag(info, artifactPath, representation)
    : weakFileEtag(info, representation);
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) {
    await fh.close();
    deferAuditLog(
      sourceAccessAuditEntry({
        eventType,
        userId: session.user.id!,
        agentId: agent.id,
        agentName: agent.name,
        documentName,
        outcome: "success",
        revalidated: true,
        // Whether the reuse was a chunk request, so a viewer reading a cached
        // document in ranges is not counted as many reopens.
        partial: parseRangeHeader(req.headers.get("range"), info.size).kind === "partial",
        representation,
      })
    );
    return new NextResponse(null, { status: 304, headers: sessionScopedRevalidateHeaders(etag) });
  }

  // A range continues a copy the client already holds. With If-Range it is
  // asked for only if that copy is current, which a weak validator cannot
  // vouch for — so the whole document is sent rather than a spliced one.
  const range = rangeAllowedByIfRange(req.headers.get("if-range"))
    ? parseRangeHeader(req.headers.get("range"), info.size)
    : ({ kind: "full" } as const);
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
      // Kept, but revalidated on every reuse so the reuse passes the access
      // check above; keyed to the session so a copy never reaches the next
      // user on the same browser (#1286).
      ...sessionScopedRevalidateHeaders(etag),
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
