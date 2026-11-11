/**
 * pinchy-knowledge — a thin credential-proxy plugin (see agent-rules/secrets.md "Pattern
 * B") in front of Pinchy's internal knowledge-base retrieval API. All
 * retrieval logic (hybrid search, path scoping, embeddings) lives in
 * packages/web (POST /api/internal/knowledge/search); this plugin's
 * `knowledge_search` tool does nothing but call that route with the gateway
 * token and format the results for the model. Keeping retrieval out of the
 * plugin means Postgres/pgvector access, RBAC, and audit stay where the rest
 * of Pinchy's governance logic already lives.
 */

import { detectQuestionLanguage, questionText } from "./question-language";
import { refusingUnknownParams } from "./unknown-params";
import { formatLocator, type ChunkLocator } from "./locator";

// Bounds the call to Pinchy's own internal API against a hung container /
// network blackhole. A healthy search answers in well under a second, even
// queued: query embeddings take 16-24 ms each on a 2-vCPU box, and one queued
// behind a reindex waits for at most one ~1 s indexing chunk (the embedder is
// one shared context with a FIFO evaluate lock — see embeddings.ts). Ten
// seconds is an order of magnitude of headroom over that, not a budget a
// healthy search is expected to approach.
const FETCH_TIMEOUT_MS = 10_000;

// What the model reads when the budget runs out. The raw abort reason ("The
// operation was aborted due to timeout") is what an agent relayed to a user on
// staging; it names neither what timed out nor what to do next.
const TIMEOUT_MESSAGE =
  `the knowledge base did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds. ` +
  "Retry the search once; if it times out again, tell the user the knowledge base " +
  "is not responding right now.";

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

interface PluginToolContext {
  agentId?: string;
  sessionKey?: string;
  /** Changes when a session is reset in place, while sessionKey stays. Hook context only. */
  sessionId?: string;
  /** One run can make several attempts; each fires before_prompt_build. Hook context only. */
  runId?: string;
}

interface PromptBuildEvent {
  prompt?: unknown;
}

interface PromptBuildResult {
  appendSystemContext?: string;
  appendContext?: string;
}

// Presence-only per-agent gating: an entry in `agents` means the agent may
// call knowledge_search. There are no per-agent parameters (unlike
// pinchy-files' allowed_paths or pinchy-web's allowedDomains) because the
// route itself resolves an agent's KB visibility from the SAME
// pinchy-files allowed_paths that already scope its file access (see the
// route's doc comment) — nothing more for this plugin to carry per agent.
interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, Record<string, never>>;
}

interface PluginLogger {
  warn?: (message: string) => void;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  logger?: PluginLogger;
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string }
  ) => void;
  on?: (
    hookName: "before_prompt_build",
    handler: (event: PromptBuildEvent, ctx: PluginToolContext) => PromptBuildResult | undefined
  ) => void;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

// Mirrors the response shape of POST /api/internal/knowledge/search
// (packages/web/src/app/api/internal/knowledge/search/route.ts). Note there
// is deliberately no `documentId` here — the route's public response only
// exposes chunkId/text/sourcePath/citationPath/locator/docName, so the plugin
// uses `sourcePath` as the per-document identity below.
//
// Two paths, two jobs: `sourcePath` is absolute and IDENTIFIES the document
// (audit refs, anything that has to open the file); `citationPath` is what the
// reader is shown, relative to the data root, and is the only one that belongs
// in the citation string.
export interface KnowledgeSearchResult {
  chunkId: string;
  text: string;
  sourcePath: string;
  citationPath: string;
  locator: ChunkLocator | null;
  docName: string;
}

export interface DocumentRef {
  id: string;
  name: string;
}

/**
 * Dedupe the unique documents referenced by a set of chunk results into
 * {id, name} refs — the same shape as the route's own `retrieval.query`
 * audit entry (EntityRef), so a reviewer correlating the tool-call audit
 * row (from this plugin's `details`) with the retrieval audit row (from the
 * route) sees comparable document identities. `sourcePath` stands in for
 * the route's internal `documentId`, which is not part of the public
 * response.
 */
export function returnedDocumentIds(results: KnowledgeSearchResult[]): DocumentRef[] {
  const seen = new Map<string, string>();
  for (const result of results) {
    if (!seen.has(result.sourcePath)) {
      seen.set(result.sourcePath, result.docName);
    }
  }
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

/**
 * What the caller is expected to do with these passages, carried by the result
 * itself rather than by the agent's instructions.
 *
 * The distinction is not cosmetic. On the customer corpus (2026-07-27) the same
 * question produced a fully-cited answer from an agent carrying the
 * knowledge-base template and an uncited one from an agent whose template slot
 * was empty — identical retrieval, five successful searches with eight hits
 * each, only the prose differed. Anything stated only in a template is absent
 * for every agent created without one, which includes every agent an admin
 * builds from scratch. A tool result reaches the model on every call, for
 * every agent, whatever it was configured from.
 *
 * It leads rather than trails so it reads as a directive about the passages
 * instead of one more block of text after the last quoted one.
 *
 * The Sources sentence is not decoration. Inline numbers alone would turn "no
 * citation" into "unresolvable citation" — the reader never sees this tool
 * result, so a bare `[1]` in the answer points at nothing. Pinchy's own KB
 * graders name both halves of that failure: `gradeCitationResolution` fails an
 * inline `[N]` with no Sources entry ("the reader hits a dead end") and a
 * Sources entry never cited inline (a retrieved-but-unused chunk dressed up as
 * corroboration), and `gradePathCitation` fails an entry shortened to a bare
 * filename.
 */
const CITATION_CONTRACT =
  "Cite the passages you use inline as [1], [2] next to the claim each one supports. " +
  "The reader sees only your answer, never these passages, so end it with a Sources list " +
  // "position", not "page": the anchor is a ChunkLocator now, and only PDFs
  // have pages. Asking for a page would make the model state something false of
  // a Word file, whose pagination is a rendering result rather than a property
  // of the document the reader opens (#933).
  // A Word chunk with no outline heading has a null locator and is printed as
  // its path alone. Demanding a position for every entry made the model fill
  // the slot with "page number not available", so the position is conditional.
  "giving each number you cited the document path and position exactly as written above (the position only when the passage shows one). " +
  "When a passage shows no position, write the path alone and never say a position is missing or unavailable. " +
  "List every number you cite, and no number you did not. " +
  "If they do not answer the question, say so instead of answering from memory.";

/**
 * Which language the answer is written in, stated after the passages (#1296).
 *
 * A Knowledge Base agent on Claude Haiku 5.5 answered Polish questions in
 * German whenever the passages were German, although SOUL.md and the
 * knowledge-search skill both say to answer in the user's language. Both
 * sit far above the tool results, and the skill reaches the model only if it
 * reads SKILL.md first. The last thing the model saw before writing was a
 * block of German text, and that won.
 *
 * So this sentence trails, unlike CITATION_CONTRACT. The contract tells the
 * model how to treat the passages and leads them. This one is about the answer
 * that comes next, so it sits directly before the model starts writing.
 *
 * This is the wording used when the language could not be named: the hook saw
 * no message for this session, or `detectQuestionLanguage` could not tell.
 * The search query is no substitute, because the model often writes it in the
 * documents' language rather than the user's.
 */
const ANSWER_LANGUAGE =
  "Write your answer in the language of the user's question (unless the question asks for a " +
  "different language), even when these passages " +
  "are in another language: translate what they say, and keep document paths, titles " +
  "and quoted wording as written.";

/** The question a search was made for, as the before_prompt_build hook saw it. */
export interface AskedQuestion {
  language: string;
  text: string;
}

/**
 * The language rule with the language named and the question quoted (#1296).
 *
 * Measured, not guessed: with a German-named agent and German sources, Claude
 * Haiku 5.5 and Sonnet 5 kept answering Polish questions in German when the
 * rule only said "the language of the user's question". Naming the language
 * moved them. The question is quoted so the sentence stays tied to it: this
 * text is stored in the transcript, and a later turn in another language must
 * read it as being about an earlier question, not as an order for its own.
 */
function namedAnswerLanguage({ language, text }: AskedQuestion): string {
  return (
    `The question these passages are for was written in ${language}: "${text}". ` +
    `Write your whole answer to it in ${language} (unless the question asks for a different ` +
    `language), even though these passages are in another ` +
    "language: translate what they say, and keep document paths, titles and quoted wording as written."
  );
}

/**
 * The passages are wrapped as quoted source material. With a German-named
 * agent, a block of German passages otherwise reads as the language of the
 * conversation. The note says what they are; the tags mark where they end.
 */
const SOURCES_OPEN =
  '<source_passages note="Quoted documents in their original language. Their language is not the language of the conversation.">';
const SOURCES_CLOSE = "</source_passages>";

/** The fixed answer-language rule appended to the system prompt of every agent with knowledge_search. */
export const ANSWER_LANGUAGE_RULE =
  "Answer language: always write your whole answer in the language of the user's latest message, " +
  "unless they ask for another one, even when the documents, your name or your instructions are " +
  "in another language. Quote document passages in their original language.";

/** The note added to this turn's message when its language could be named. */
export function turnLanguageNote(language: string): string {
  return (
    `(This message is in ${language}. Write your whole reply in ${language} unless the user has ` +
    "asked for another language, even if the documents, your name, your instructions or earlier " +
    "messages are in another language.)"
  );
}

/** A quoted question longer than this is cut, so a pasted document can't flood the result. */
const MAX_QUOTED_QUESTION = 300;

/**
 * The language and wording of the latest message per session, seen by the
 * before_prompt_build hook and read by the tool call that follows. Bounded,
 * oldest first out, because sessions are never told to us as finished.
 */
const MAX_TRACKED_SESSIONS = 1000;

function quotedQuestion(prompt: string): string {
  const text = questionText(prompt).replace(/\s+/g, " ").trim();
  return text.length > MAX_QUOTED_QUESTION ? `${text.slice(0, MAX_QUOTED_QUESTION)}…` : text;
}

/**
 * The other half of grounding, and the half a template is least likely to
 * spell out: an empty retrieval is a fact about the corpus, not an invitation
 * to fall back on training data.
 */
const NO_RESULTS =
  "No matching passages found in the knowledge base. Tell the user, in the language of " +
  "their question, that the knowledge base does not cover this instead of answering " +
  "from memory.";

/**
 * Render retrieval results as a numbered, citable source list so the model
 * can cite-then-answer against a closed set of ids, prefixed by the contract
 * that says what to do with them. Deterministic and unit-tested: the same
 * input always yields the same output string.
 *
 * Sources are identified by their PATH, not `docName`. A citation only earns
 * trust if the reader can FIND the document and check it: a bare basename is
 * unfindable in a deep corpus and, worse, collapses same-named files from
 * different folders into one indistinguishable citation. The model can only
 * cite what it is shown, so the path has to be in this string — the tool result
 * never reaches the browser. `docName` stays in the response shape for
 * `returnedDocumentIds`, which wants a human-readable name for the audit row,
 * not a locator.
 *
 * The path shown is `citationPath` — relative to the data root — because the
 * absolute `/data/<mount>/…` form is what the CONTAINER sees and nobody at the
 * customer recognises it (#933). And the anchor is a `ChunkLocator`, not a
 * page: only PDFs have pages, and a Word file's page number is a rendering
 * result, so citing one would state something false of the document the reader
 * opens.
 */
export function formatWithCitations(
  results: KnowledgeSearchResult[],
  question?: AskedQuestion
): string {
  if (results.length === 0) {
    return NO_RESULTS;
  }
  const sources = results
    .map((result, index) => {
      const anchor = result.locator ? ` (${formatLocator(result.locator)})` : "";
      return `[${index + 1}] ${result.citationPath}${anchor}: "${result.text}"`;
    })
    .join("\n\n");
  const language = question ? namedAnswerLanguage(question) : ANSWER_LANGUAGE;
  return `${CITATION_CONTRACT}\n\n${SOURCES_OPEN}\n${sources}\n${SOURCES_CLOSE}\n\n${language}`;
}

function normalizeBaseUrl(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return url.slice(0, end);
}

const plugin = {
  id: "pinchy-knowledge",
  name: "Pinchy Knowledge",
  description:
    "Retrieves knowledge-base passages for agents via Pinchy's internal hybrid-search API.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "apiBaseUrl" in value &&
        "gatewayToken" in value &&
        "agents" in value
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Missing required keys in config"],
      };
    },
  },

  register(pluginApi: PluginApi) {
    // Every tool refuses a parameter it does not declare (unknown-params.ts).
    const api = refusingUnknownParams(pluginApi);
    const config = api.pluginConfig;
    if (!config?.apiBaseUrl || !config?.gatewayToken) {
      api.logger?.warn?.("[pinchy-knowledge] plugin config is missing apiBaseUrl or gatewayToken");
      return;
    }

    const { gatewayToken, agents: agentConfigs } = config;
    const apiBaseUrl = normalizeBaseUrl(config.apiBaseUrl);

    // Two additions to the prompt, and the language the tool result names.
    //
    // The system-prompt rule is the same string on every turn, so it never
    // changes the prompt's prefix or its cache. The per-turn note names the
    // language of this message; OpenClaw does not store it in the transcript,
    // so later turns replay the message without it. That matters for Claude
    // models with preserved thinking, which refuse a thinking block whose
    // prefix changed. The only one Pinchy offers, Claude Haiku 5.5, runs with
    // thinking off on the pinned OpenClaw version, and a test fails when that
    // version changes so the question gets asked again.
    //
    // It also costs prompt caching: a cache entry written over a message with
    // its note no longer matches when that message is replayed without it. So
    // the note goes only on the turn the language changes, one cache miss per
    // switch instead of one per turn. Measured on Haiku 5.5: first questions
    // 47/48 with the note; same-language follow-ups, which carry none, 43/48.
    // (Putting the session's language in the fixed rule instead keeps the
    // cache entirely, and measured 42/48 on first questions.)
    //
    // Measured (German-named agent, German sources, Haiku 5.5): the tool
    // result alone ~80 % right, with the rule and the note 94 %.
    const askedQuestions = new Map<string, AskedQuestion>();
    const notedLanguages = new Map<string, { language: string; runId?: string }>();
    api.on?.("before_prompt_build", (event, ctx) => {
      if (!ctx.agentId || !agentConfigs?.[ctx.agentId]) return undefined;
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      const sessionKey = ctx.sessionKey;
      const noteKey = ctx.sessionId ?? sessionKey;
      const noted = noteKey ? notedLanguages.get(noteKey) : undefined;
      // A retry of the same run: OpenClaw may have appended an English
      // instruction to the prompt ("The previous attempt did not produce a
      // user-visible answer…"), so the language this run was asked in, and
      // the question it quotes, are the ones the first attempt saw.
      const sameRun = noted !== undefined && ctx.runId !== undefined && noted.runId === ctx.runId;
      const language = sameRun ? noted.language : detectQuestionLanguage(prompt);
      if (sessionKey && !sameRun) {
        askedQuestions.delete(sessionKey);
        if (language) {
          askedQuestions.set(sessionKey, { language, text: quotedQuestion(prompt) });
          if (askedQuestions.size > MAX_TRACKED_SESSIONS) {
            const oldest = askedQuestions.keys().next().value;
            if (oldest !== undefined) askedQuestions.delete(oldest);
          }
        }
      }
      // Only on the turn the language changes: the first turn of a session,
      // and a real switch. Same-language follow-ups carry no note, so the
      // history they replay stays byte-identical and keeps the prompt cache.
      //
      // Tracked per sessionId, not sessionKey: a reset (web or Telegram /new)
      // keeps the key and starts a session with no history, whose first turn
      // needs the note. And a retried attempt of the same run gets it again,
      // since OpenClaw fires this hook once per attempt.
      let note: string | undefined;
      if (language && (!noted || noted.language !== language || sameRun)) {
        note = turnLanguageNote(language);
        if (noteKey) {
          notedLanguages.delete(noteKey);
          notedLanguages.set(noteKey, { language, runId: ctx.runId });
          if (notedLanguages.size > MAX_TRACKED_SESSIONS) {
            const oldest = notedLanguages.keys().next().value;
            if (oldest !== undefined) notedLanguages.delete(oldest);
          }
        }
      }
      return {
        appendSystemContext: ANSWER_LANGUAGE_RULE,
        ...(note ? { appendContext: note } : {}),
      };
    });

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        if (!agentConfigs?.[agentId]) return null;

        return {
          name: "knowledge_search",
          label: "Search Knowledge Base",
          description:
            "Search the organization's indexed documents for passages relevant to a question. Use this FIRST for any question about document content, before reaching for file tools: it returns numbered passages together with their document path and, where the document has one, a position (page, slide, section heading, rows), which is what makes an answer citable. Reading a file directly gives you no such anchor, so anything found that way cannot be cited. Cite the returned numbers inline in your answer.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Natural-language search query",
              },
              include_archived: {
                type: "boolean",
                description:
                  "Also search archived documents (OLD/Archive folders). By default only current documents are searched — set this only when the user explicitly asks for archived or historical material.",
              },
            },
            required: ["query"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const query = typeof params.query === "string" ? params.query.trim() : "";
            if (!query) {
              return {
                isError: true,
                content: [{ type: "text", text: "A search query is required." }],
                // details.error mirrors the two failure paths below — see the
                // comment there for why this is error-only (no other keys).
                details: { error: "A search query is required." },
              };
            }
            // Forwarded only when true so the route's audit detail stays
            // unmarked for the common, archive-free default query.
            const includeArchived = params.include_archived === true;

            try {
              const res = await fetch(`${apiBaseUrl}/api/internal/knowledge/search`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${gatewayToken}`,
                },
                body: JSON.stringify({
                  query,
                  agentId,
                  ...(includeArchived ? { includeArchived: true } : {}),
                }),
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
              });

              if (!res.ok) {
                const data = await res.json().catch(() => ({}) as Record<string, unknown>);
                const message = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
                return {
                  isError: true,
                  content: [{ type: "text", text: `Knowledge base search failed: ${message}` }],
                  // details.error (and ONLY error — no other keys) is set on
                  // every failure path so the audit endpoint's isError-
                  // stripping defense (#404) can't mask the failure, WITHOUT
                  // suppressing raw params: /api/internal/audit/tool-use only
                  // suppresses params when a curated field beyond `error` is
                  // present (see its "curatesNonErrorFields" check), and a
                  // failed call's params are exactly what forensics needs —
                  // see the 2026-06-25 false-success incident referenced
                  // there. Same shape as pinchy-files' write/read error path.
                  details: { error: message },
                };
              }

              const data = (await res.json()) as { results: KnowledgeSearchResult[] };
              const results = Array.isArray(data.results) ? data.results : [];

              return {
                content: [
                  {
                    type: "text",
                    text: formatWithCitations(
                      results,
                      ctx.sessionKey ? askedQuestions.get(ctx.sessionKey) : undefined
                    ),
                  },
                ],
                details: {
                  toolName: "knowledge_search",
                  returnedDocumentIds: returnedDocumentIds(results),
                },
              };
            } catch (error) {
              const message = isTimeout(error)
                ? TIMEOUT_MESSAGE
                : error instanceof Error
                  ? error.message
                  : "Unknown error";
              return {
                isError: true,
                content: [{ type: "text", text: `Knowledge base search failed: ${message}` }],
                // error-only details — see the identical comment on the
                // !res.ok branch above.
                details: { error: message },
              };
            }
          },
        };
      },
      { name: "knowledge_search" }
    );
  },
};

export default plugin;
