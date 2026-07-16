/**
 * LLM-backed `NliClient` + `RelevanceJudge` for the KB eval harness's Layer-3
 * groundedness sweep (KB Eval Harness plan, Task 3.4).
 *
 * `nli.ts`'s doc comment calls the mDeBERTa-v3-base-xnli sidecar "the real
 * judge (Task 3.4)" — but that sidecar does not exist yet (design §6's
 * "offline model-serving pattern" is future work, not landed). This module is
 * the MVP substitute: an instruction-following LLM (Ollama Cloud, the same
 * provider the sweep already dispatches candidate models against) plays the
 * NLI-judge role instead of a dedicated classifier. It is a deliberately
 * documented seam, not a permanent design: swap `LlmNliClient`/
 * `LlmRelevanceJudge` for a sidecar-backed client later without touching any
 * caller — both already satisfy `nli.ts`'s `NliClient` and
 * `answer-graders.ts`'s `RelevanceJudge` interfaces, which is the whole point
 * of those interfaces being dependency-injected in the first place.
 *
 * The model call itself is injected as a plain `(prompt) => Promise<string>`
 * function (`LlmChatFn`) rather than hardcoded to a specific HTTP client, so
 * `parseNliResponse`/`parseRelevanceResponse`/`entails`/`score` are all
 * unit-testable with a scripted stub `chat` — no network, no key, no live
 * stack. `createOllamaCloudChatFn` below is the one piece that DOES need a
 * live key + network and is therefore NOT unit-tested; it is the thin wiring
 * `kb-eval-models.spec.ts` uses to turn this into a real judge.
 */

import type { NliClient, NliLabel, NliVerdict } from "./nli";
import type { RelevanceJudge } from "./answer-graders";

/** A model call: send one prompt, get back the model's raw text reply. Dependency-injected — see module doc comment. */
export type LlmChatFn = (prompt: string) => Promise<string>;

/**
 * Fallback verdict returned by `parseNliResponse` when the judge's reply
 * cannot be parsed into a verdict at all (no JSON found, invalid JSON,
 * missing/invalid `label` or `score`). `neutral`/`0` is a deliberately
 * CONSERVATIVE choice, not an optimistic one: `gradeGroundedness` fails a
 * sentence whose mean-of-k score is below τ (default 0.6), so a fallback of 0
 * makes an unparseable judge reply count AGAINST groundedness rather than
 * silently passing it — a parse failure must never masquerade as "entailed."
 * This must be a thrown-free path: one bad reply out of k judge calls (or one
 * bad relevance call) must not crash the whole sweep run.
 */
export const NLI_PARSE_FALLBACK: NliVerdict = { label: "neutral", score: 0 };

/** Same conservative-failure reasoning as `NLI_PARSE_FALLBACK`, for `parseRelevanceResponse`. */
export const RELEVANCE_PARSE_FALLBACK = 0;

const VALID_NLI_LABELS: readonly NliLabel[] = ["entailment", "neutral", "contradiction"];

function isValidNliLabel(value: unknown): value is NliLabel {
  return typeof value === "string" && (VALID_NLI_LABELS as readonly string[]).includes(value);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Extracts the first plausible JSON object substring from a raw model reply,
 * robust to the two common wrapping shapes an instruction-following LLM adds
 * even when told to reply with "ONLY a JSON object":
 *   - a fenced code block (``` or ```json ... ```) around the JSON;
 *   - extra prose before/after the JSON ("Here is my verdict: {...}").
 * A flat first-`{`-to-last-`}` slice is sufficient here (not a real balanced-
 * brace parser) because the verdict shapes this module parses are single flat
 * objects with no nested braces of their own. Returns null if no `{`/`}` pair
 * is found at all.
 */
function extractJsonObjectText(raw: string): string | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenceMatch ? fenceMatch[1] : raw;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * Parses an LLM-as-NLI-judge reply into an `NliVerdict`. PURE — no I/O — so
 * every shape below is directly unit-testable: a clean JSON reply, JSON
 * wrapped in a ```json fence, JSON surrounded by extra prose, and a malformed
 * reply (falls back to `NLI_PARSE_FALLBACK` rather than throwing — see its
 * doc comment for why that fallback must never crash the caller).
 *
 * Expected reply shape (see `buildNliPrompt`'s instructions to the judge):
 * `{"label": "entailment" | "neutral" | "contradiction", "score": <0..1>}`.
 * `score` is clamped into [0, 1] defensively (a judge that returns 1.2 or a
 * percentage-scale 85 should not silently corrupt the mean-of-k average).
 */
export function parseNliResponse(raw: string): NliVerdict {
  const jsonText = extractJsonObjectText(raw);
  if (jsonText === null) {
    console.warn(
      `[llm-nli] no JSON object found in NLI judge reply, falling back to neutral/0: ${raw.slice(0, 200)}`
    );
    return NLI_PARSE_FALLBACK;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.warn(
      `[llm-nli] NLI judge reply is not valid JSON, falling back to neutral/0: ${String(err)}`
    );
    return NLI_PARSE_FALLBACK;
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.warn("[llm-nli] NLI judge reply parsed to a non-object, falling back to neutral/0");
    return NLI_PARSE_FALLBACK;
  }

  const obj = parsed as Record<string, unknown>;
  if (!isValidNliLabel(obj.label)) {
    console.warn(
      `[llm-nli] NLI judge reply has an invalid label ${JSON.stringify(obj.label)}, falling back to neutral/0`
    );
    return NLI_PARSE_FALLBACK;
  }
  if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) {
    console.warn(
      `[llm-nli] NLI judge reply has an invalid score ${JSON.stringify(obj.score)}, falling back to neutral/0`
    );
    return NLI_PARSE_FALLBACK;
  }

  return { label: obj.label, score: clamp01(obj.score) };
}

/**
 * Parses an LLM-as-relevance-judge reply into a [0, 1] score. Mirrors
 * `parseNliResponse`'s robustness (fence-wrapped JSON, surrounding prose,
 * malformed replies fall back to `RELEVANCE_PARSE_FALLBACK` rather than
 * throwing) but expects the simpler `{"score": <0..1>}` shape — relevance has
 * no entailment label, only a degree of "does this address the question."
 */
export function parseRelevanceResponse(raw: string): number {
  const jsonText = extractJsonObjectText(raw);
  if (jsonText === null) {
    console.warn(
      `[llm-nli] no JSON object found in relevance judge reply, falling back to ${RELEVANCE_PARSE_FALLBACK}: ${raw.slice(0, 200)}`
    );
    return RELEVANCE_PARSE_FALLBACK;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.warn(
      `[llm-nli] relevance judge reply is not valid JSON, falling back to ${RELEVANCE_PARSE_FALLBACK}: ${String(err)}`
    );
    return RELEVANCE_PARSE_FALLBACK;
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.warn(
      `[llm-nli] relevance judge reply parsed to a non-object, falling back to ${RELEVANCE_PARSE_FALLBACK}`
    );
    return RELEVANCE_PARSE_FALLBACK;
  }

  const score = (parsed as Record<string, unknown>).score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    console.warn(
      `[llm-nli] relevance judge reply has an invalid score ${JSON.stringify(score)}, falling back to ${RELEVANCE_PARSE_FALLBACK}`
    );
    return RELEVANCE_PARSE_FALLBACK;
  }

  return clamp01(score);
}

/**
 * Prompt contract for the NLI judge role. Deliberately strict ("Respond with
 * ONLY a JSON object") because `parseNliResponse` still has to tolerate a
 * model that ignores this — the instruction reduces how often the fallback
 * path fires, it does not make `parseNliResponse`'s robustness unnecessary.
 */
export function buildNliPrompt(premise: string, hypothesis: string): string {
  return `You are a strict natural-language-inference judge. Decide whether the PREMISE entails the HYPOTHESIS.

- "entailment": the PREMISE, on its own, supports the HYPOTHESIS as true.
- "contradiction": the PREMISE contradicts the HYPOTHESIS.
- "neutral": the PREMISE neither supports nor contradicts the HYPOTHESIS (e.g. it is silent on the claim, or only tangentially related).

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"label": "entailment" | "neutral" | "contradiction", "score": <number between 0 and 1, the probability the PREMISE entails the HYPOTHESIS>}

PREMISE:
${premise}

HYPOTHESIS:
${hypothesis}`;
}

/** Prompt contract for the answer-relevance judge role — see `parseRelevanceResponse`. */
export function buildRelevancePrompt(query: string, answer: string): string {
  return `You are grading whether an ANSWER addresses a QUESTION. Judge ONLY whether the answer is on-topic and responsive to what was asked — do NOT judge whether the answer's claims are factually correct or well-supported; that is graded separately.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"score": <number between 0 and 1, how well the ANSWER addresses the QUESTION; 1 = fully addresses it, 0 = completely off-topic>}

QUESTION:
${query}

ANSWER:
${answer}`;
}

/**
 * `NliClient` implementation backed by an injected LLM chat function. See the
 * module doc comment for why this exists in place of the design's planned
 * mDeBERTa-v3-base-xnli sidecar.
 */
export class LlmNliClient implements NliClient {
  constructor(private readonly chat: LlmChatFn) {}

  async entails(premise: string, hypothesis: string): Promise<NliVerdict> {
    const raw = await this.chat(buildNliPrompt(premise, hypothesis));
    return parseNliResponse(raw);
  }
}

/** `RelevanceJudge` implementation backed by an injected LLM chat function — see `LlmNliClient`. */
export class LlmRelevanceJudge implements RelevanceJudge {
  constructor(private readonly chat: LlmChatFn) {}

  async score(query: string, answer: string): Promise<number> {
    const raw = await this.chat(buildRelevancePrompt(query, answer));
    return parseRelevanceResponse(raw);
  }
}

/**
 * Wires an `LlmChatFn` to a real Ollama Cloud model via its OpenAI-compatible
 * `/v1/chat/completions` endpoint (same endpoint `src/lib/providers.ts` and
 * `src/lib/openclaw-config/build.ts` use for provider validation/config —
 * see those files for the established base-URL pattern this mirrors).
 *
 * NOT unit-tested: this is a thin network call that needs a real
 * `OLLAMA_CLOUD_API_KEY` and live network to exercise meaningfully: every
 * other piece of behavior worth testing (prompt construction, response
 * parsing) is already covered by `buildNliPrompt`/`buildRelevancePrompt`/
 * `parseNliResponse`/`parseRelevanceResponse`'s unit tests via a stub
 * `LlmChatFn`. NEEDS VALIDATION AGAINST THE RUNNING STACK + a real key
 * (orchestrator's dry-run) — in particular, whether the pinned judge model id
 * below is available on the account under test, and whether the response
 * shape matches the OpenAI-compatible `choices[0].message.content` field
 * every other Ollama Cloud call site in this repo assumes.
 */
export function createOllamaCloudChatFn(opts: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): LlmChatFn {
  const model = opts.model ?? "ollama-cloud/gpt-oss:20b";
  const baseUrl = opts.baseUrl ?? "https://ollama.com";

  return async (prompt: string): Promise<string> => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: model.replace(/^ollama-cloud\//, ""),
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama Cloud judge call failed: HTTP ${String(res.status)} ${text}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Ollama Cloud judge call returned no message content");
    }
    return content;
  };
}
