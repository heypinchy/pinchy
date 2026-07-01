// Enrich a diagnostics bundle's tool-call arguments from the audit log.
//
// OpenClaw's trajectory capture caps nested values at depth 6 and writes a
// `{ truncated: true, reason: "trajectory-depth-limit", limitDepth: 6 }` marker
// in their place. Pinchy passes those markers through verbatim into span
// `gen_ai.tool.call.arguments`, which makes exactly the payloads a bundle
// exists to explain (odoo_create `values`, odoo_read `filters`, …) unreadable.
//
// Pinchy already holds a fuller copy of the same arguments: `pinchy-audit`
// records tool `params` sanitized at depth 10 (no depth-6 cap). This module
// swaps a truncated trajectory argument for the matching audit `params` when we
// can match it unambiguously, and stamps every tool-call argument with an
// `argsSource: "audit" | "trajectory"` marker so a reader knows which calls were
// enriched.
//
// Two independent truncation axes exist and only one is fixed here:
//   - trajectory depth-6 cap (this module recovers it from audit params), and
//   - the audit `detail` 2048-byte byte-cap (`truncateDetail` in lib/audit.ts),
//     which replaces the whole detail with a `{ _truncated, summary }` marker.
// When the audit row itself was byte-cap truncated it carries no `params`, so we
// keep the trajectory marker rather than fabricate — the real fix for oversized
// payloads is an upstream OpenClaw change to the trajectory depth cap.
//
// This runs BEFORE `sanitizeBundle` in the export route so the injected params
// are counted toward the 5 MB size cap. Redaction of the injected params does
// not rely on that later bundle-level pass (which reaches them only shallowly at
// their depth in the tree); we re-scrub each params object from its own root as
// we inject it — see `applyAuditParams`.

import { sanitizeDetail } from "@/lib/audit-sanitize";
import type { OtelSpan } from "./otel-builder";
import type { CollectedAuditEntry } from "./audit-collector";

const DEPTH_LIMIT_REASON = "trajectory-depth-limit";
const TOOL_EVENT_PREFIX = "tool.";

interface ToolCallArg {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  argsSource?: "audit" | "trajectory";
  [key: string]: unknown;
}

/**
 * True when `value` is — or contains anywhere in its object/array tree — a
 * trajectory depth-limit marker. A marker can replace the whole `arguments`
 * object or just one nested value (e.g. `arguments.fields`), so we look for it
 * recursively and, when present, replace the entire `arguments` with the
 * complete audit copy.
 */
export function containsDepthLimitMarker(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsDepthLimitMarker);
  const obj = value as Record<string, unknown>;
  if (obj.reason === DEPTH_LIMIT_REASON) return true;
  return Object.values(obj).some(containsDepthLimitMarker);
}

// A usable audit candidate is a stored tool row whose detail survived the
// byte-cap (not `_truncated`) and still carries structured `params`. Curated
// details that strip params (pinchy_write et al.) and byte-cap summaries both
// fail this check and are excluded, so an ambiguous count falls back to keeping
// the marker.
function usableParams(detail: unknown): Record<string, unknown> | null {
  if (detail === null || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (d._truncated === true) return null;
  const params = d.params;
  if (params === null || typeof params !== "object") return null;
  return params as Record<string, unknown>;
}

function detailToolCallId(entry: CollectedAuditEntry): string | undefined {
  const detail = entry.detail;
  if (detail === null || typeof detail !== "object") return undefined;
  const id = (detail as Record<string, unknown>).toolCallId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Replace depth-truncated trajectory arguments with the fuller audit-log
 * `params` for the same tool call, where a match can be made without guessing.
 * Returns new spans; inputs are not mutated.
 */
export function enrichToolCallArgs(
  spans: OtelSpan[],
  auditEntries: CollectedAuditEntry[]
): OtelSpan[] {
  return spans.map((span) => enrichSpan(span, auditEntries));
}

function enrichSpan(span: OtelSpan, auditEntries: CollectedAuditEntry[]): OtelSpan {
  const raw = span.attributes["gen_ai.tool.call.arguments"];
  if (!Array.isArray(raw) || raw.length === 0) return span;

  // Every tool-call argument gets a source marker; enrichment upgrades matched
  // ones to "audit" below.
  const calls: ToolCallArg[] = raw.map((c) => ({
    ...(c as ToolCallArg),
    argsSource: "trajectory",
  }));

  const windowStart = span.startTime ? Date.parse(span.startTime) : NaN;
  const windowEnd = span.endTime ? Date.parse(span.endTime) : NaN;
  const hasWindow = Number.isFinite(windowStart) && Number.isFinite(windowEnd);

  if (hasWindow) {
    const candidatesByName = collectCandidates(auditEntries, windowStart, windowEnd);
    const callsByName = groupBy(calls, (c) => (typeof c.name === "string" ? c.name : undefined));

    for (const [name, callsOfName] of callsByName) {
      const candidates = candidatesByName.get(name) ?? [];
      matchToolCalls(callsOfName, candidates);
    }
  }

  return {
    ...span,
    attributes: { ...span.attributes, "gen_ai.tool.call.arguments": calls },
  };
}

// Audit rows for one span's time window, grouped by tool name and ordered by
// timestamp so positional alignment is deterministic.
function collectCandidates(
  auditEntries: CollectedAuditEntry[],
  windowStart: number,
  windowEnd: number
): Map<string, CollectedAuditEntry[]> {
  const byName = new Map<string, CollectedAuditEntry[]>();
  for (const entry of auditEntries) {
    if (typeof entry.eventType !== "string" || !entry.eventType.startsWith(TOOL_EVENT_PREFIX)) {
      continue;
    }
    if (usableParams(entry.detail) === null) continue;
    const t =
      entry.timestamp instanceof Date
        ? entry.timestamp.getTime()
        : Date.parse(String(entry.timestamp));
    if (!Number.isFinite(t) || t < windowStart || t > windowEnd) continue;
    const name = entry.eventType.slice(TOOL_EVENT_PREFIX.length);
    const list = byName.get(name);
    if (list) list.push(entry);
    else byName.set(name, [entry]);
  }
  // Stable sort by timestamp. Entries arrive already ordered by (timestamp,
  // row id) from the collector query, and Array.prototype.sort is stable, so
  // equal-timestamp rows keep their insertion-order (= execution-order)
  // sequence rather than being reshuffled.
  for (const list of byName.values()) {
    list.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  return byName;
}

// Copy an audit row's `params` onto a tool call, stamping it enriched. The
// params are re-sanitized from their own root here: once embedded in the bundle
// they'd sit ~6 levels deep, where `sanitizeBundle`'s depth-10 guard barely
// reaches into them, so we scrub at depth-0 to match the write-time guarantee
// rather than rely on the shallower bundle-level pass. `sanitizeDetail` returns
// a fresh object, so the shared audit `detail.params` is never mutated.
function applyAuditParams(call: ToolCallArg, detail: unknown): void {
  call.arguments = sanitizeDetail(usableParams(detail));
  call.argsSource = "audit";
}

// For a single tool name:
//   - Preferred (audit rows written since #640 carry `toolCallId`): match each
//     truncated call to its row strictly by id. This is the ONLY path taken once
//     any usable candidate carries an id — a marker call whose id isn't present
//     keeps its marker rather than falling back to positional guessing. That
//     matters because `fetchAuditEntriesForSession` scopes rows by agent + user
//     + time only (no chat discriminator), so a positional guess could pull in a
//     concurrent same-agent chat's same-tool row. Ids are unique per call, so
//     the id path can never mismatch across sessions.
//   - Legacy fallback (rows predating the id, e.g. an already-captured bundle):
//     positional alignment within the span's time window, guarded by a strict
//     count check. Candidates are ordered by (timestamp, audit-row id), so nth
//     call ↔ nth row holds even for equal-timestamp calls. This remains a
//     heuristic for the narrow concurrent-chat case, but only legacy id-less
//     rows can reach it; anything captured since #640 takes the id path above.
function matchToolCalls(callsOfName: ToolCallArg[], candidates: CollectedAuditEntry[]): void {
  const markerCalls = callsOfName.filter((c) => containsDepthLimitMarker(c.arguments));
  if (markerCalls.length === 0) return;

  const candidatesHaveIds =
    candidates.length > 0 && candidates.every((c) => detailToolCallId(c) !== undefined);
  if (candidatesHaveIds) {
    const byId = new Map<string, CollectedAuditEntry>();
    for (const c of candidates) byId.set(detailToolCallId(c)!, c);
    for (const call of markerCalls) {
      const id = typeof call.id === "string" ? call.id : undefined;
      const match = id !== undefined ? byId.get(id) : undefined;
      // No id match ⇒ this call's own row is absent. Keep the marker; do NOT
      // guess positionally, which could inject a concurrent chat's params.
      if (match) applyAuditParams(call, match.detail);
    }
    return;
  }

  // Positional: the audit log records every call, so the number of usable
  // candidates must equal the total number of same-tool calls in the span for
  // the alignment to be unambiguous. Otherwise we keep the markers. Candidates
  // are (timestamp, row-id) ordered — insertion order under the audit chain lock
  // is execution order — so nth call ↔ nth row; consume them as a queue so each
  // call maps to its positional peer without index arithmetic.
  if (callsOfName.length !== candidates.length) return;
  const queue = [...candidates];
  for (const call of callsOfName) {
    const candidate = queue.shift();
    if (candidate === undefined) continue;
    if (!containsDepthLimitMarker(call.arguments)) continue;
    applyAuditParams(call, candidate.detail);
  }
}

function groupBy<T>(items: T[], keyOf: (item: T) => string | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined) continue;
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}
