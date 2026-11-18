// packages/web/eval/kb/getRawAssistantMessage.ts
//
// KB Eval Harness Task 3.4: captures the RAW assistant message text for a
// dispatched chat — NOT a DOM scrape. Task 2.3's finding (carried forward,
// see docs/plans/2026-07-16-kb-eval-harness.md's "DOM-scrape finding") is
// that grading the rendered chat DOM is broken: react-markdown+remark-gfm
// turns `- [N] …` bullets into `<ul><li>`, and `.innerText` drops the
// leading `- `, so the attribution graders' `BULLET_LINE`/`SOURCES_HEADING`
// regexes (which match raw markdown) never match rendered output. Grading
// MUST use the raw text an LLM actually emitted.
//
// DEVIATION FROM THE ORIGINAL PLAN TEXT, DOCUMENTED HERE: the plan named
// `GET /api/agents/[agentId]/chats` as returning "the assistant message
// content." Verified against the actual route
// (packages/web/src/app/api/agents/[agentId]/chats/route.ts): it returns
// only per-chat METADATA (chatId, sessionId, origin, writable, title,
// lastInteractionAt) — no message content at all. There is in fact no REST
// endpoint that returns a chat's raw message text directly; the live web
// chat gets it over the OpenClaw WebSocket bridge (see
// src/hooks/use-ws-runtime.ts / src/server/client-router.ts), which is
// exactly the DOM-adjacent path this module exists to avoid.
//
// The plan's own fallback ("or the audit/session-history") points at the
// real answer: `POST /api/diagnostics/export` (packages/web/src/app/api/
// diagnostics/export/route.ts) reads the same on-disk trajectory JSONL the
// live chat is built from and returns each turn's assistant text VERBATIM —
// `data.assistantTexts.join("\n\n")` in
// src/lib/diagnostics/turn-extractor.ts, carried into each OTel span's
// `attributes["gen_ai.output.messages"][0].parts[0].content"` in
// src/lib/diagnostics/otel-builder.ts. That is genuinely raw markdown, never
// touched by react-markdown or the DOM. So the capture here is a two-call
// combination of real, already-tested routes:
//   1. GET /api/agents/[agentId]/chats — resolve our own dispatched `chatId`
//      (we choose it ourselves at dispatch time, same as ../run-eval.ts's
//      dispatchAndScrape) to its OpenClaw `sessionId`.
//   2. POST /api/diagnostics/export { agentId, sessionId } — read the raw
//      trajectory bundle and extract the last assistant turn's text.
//
// NEEDS VALIDATION AGAINST THE RUNNING STACK (orchestrator's dry-run): this
// two-call combination is read from source, not observed live. In
// particular, confirm the diagnostics-export bundle actually contains a span
// for a chat dispatched entirely by this harness (a fresh agent, one turn,
// no prior "Report bug" UI involvement) and that `sanitizeBundle` never
// alters ordinary KB-answer prose (its own doc comment says it only
// substitutes secret-shaped SUBSTRINGS, so this should be a no-op for KB
// answers, but has not been observed against a real bundle).
import type { Page } from "@playwright/test";

/** Minimal shape of one span's relevant attributes, mirroring `OtelSpan` (src/lib/diagnostics/otel-builder.ts). */
export interface DiagnosticsBundleSpanFixture {
  attributes?: {
    "gen_ai.output.messages"?: Array<{
      role?: string;
      parts?: Array<{ type?: string; content?: string }>;
    }>;
  };
}

/** Minimal shape of the diagnostics-export response body this module reads, mirroring `Bundle` (src/lib/diagnostics/bundle-builder.ts). */
export interface DiagnosticsBundleFixture {
  spans: DiagnosticsBundleSpanFixture[];
}

/**
 * Extracts the raw text of the LAST assistant message in a diagnostics-export
 * bundle. PURE — no I/O — so this is unit-testable directly against a
 * hand-built fixture mirroring the real route's response shape, without a
 * live stack. Walks spans and their messages in REVERSE (last span, last
 * assistant message within it) so a multi-turn bundle always yields the most
 * recent assistant turn, matching what a single-dispatch KB eval run expects
 * (one user turn, one assistant response). Returns `null` (not a throw) when
 * no assistant text is found at all — the caller decides whether that's
 * fatal for its context.
 */
export function extractRawAssistantText(bundle: DiagnosticsBundleFixture): string | null {
  for (let i = bundle.spans.length - 1; i >= 0; i--) {
    const messages = bundle.spans[i]?.attributes?.["gen_ai.output.messages"];
    if (!Array.isArray(messages)) continue;

    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      if (message?.role !== "assistant") continue;
      const textPart = message.parts?.find(
        (part) =>
          part?.type === "text" && typeof part.content === "string" && part.content.length > 0
      );
      if (textPart?.content) return textPart.content;
    }
  }
  return null;
}

/** One entry of `GET /api/agents/[agentId]/chats`'s response — see `ChatListItem` (src/lib/schemas/sessions.ts). Only the fields this module reads. */
interface ChatListItemFixture {
  chatId: string | null;
  sessionId: string;
}

/**
 * Fetches the RAW assistant message text for `chatId` on `agentId` — see the
 * module doc comment for the two-call combination and why it exists in place
 * of a DOM scrape. `page` must already be authenticated (an admin/user
 * session cookie), same precondition as `../run-eval.ts`'s `dispatchAndScrape`.
 * Throws (does not return an empty string) when the chat can't be resolved or
 * the bundle carries no assistant text at all — a silent-empty raw-text
 * capture would grade a real answer as an ungrounded/off-topic empty string
 * instead of surfacing the capture failure itself.
 */
export async function getRawAssistantMessage(
  page: Page,
  agentId: string,
  chatId: string
): Promise<string> {
  const chatsRes = await page.request.get(`/api/agents/${agentId}/chats`);
  if (!chatsRes.ok()) {
    throw new Error(
      `getRawAssistantMessage: failed to list chats for agent ${agentId}: HTTP ${String(chatsRes.status())}`
    );
  }
  const { chats } = (await chatsRes.json()) as { chats: ChatListItemFixture[] };
  const match = chats.find((c) => c.chatId === chatId);
  if (!match) {
    throw new Error(
      `getRawAssistantMessage: no chat found for chatId=${chatId} on agent ${agentId} — was it dispatched yet?`
    );
  }

  // The CSRF gate (src/server/csrf-check.ts) rejects any mutating /api/ POST
  // that carries neither an Origin nor a Referer header — reason
  // "missing-origin-and-referer", surfaced as 403. Playwright's
  // page.request.post sends neither by default (it is an API request context,
  // not a browser fetch from page JS), so this capture was the one mutating
  // eval call that bypassed run-eval.ts's `mutatingHeaders` helper (which sets
  // `Origin: PINCHY_URL` on every pinchyPost/Patch/Delete). Send an Origin that
  // matches the page's own host so the gate's Origin===Host check passes.
  const exportRes = await page.request.post("/api/diagnostics/export", {
    data: { agentId, sessionId: match.sessionId },
    headers: { Origin: new URL(page.url()).origin },
  });
  if (!exportRes.ok()) {
    throw new Error(
      `getRawAssistantMessage: diagnostics export failed for session ${match.sessionId}: ` +
        `HTTP ${String(exportRes.status())}`
    );
  }
  const bundle = (await exportRes.json()) as DiagnosticsBundleFixture;
  const text = extractRawAssistantText(bundle);
  if (text === null) {
    throw new Error(
      `getRawAssistantMessage: no assistant text found in the trajectory for chat ${chatId} ` +
        `(session ${match.sessionId})`
    );
  }
  return text;
}
