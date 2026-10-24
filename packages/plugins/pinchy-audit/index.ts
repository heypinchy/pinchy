interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
}

interface ToolHookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface PluginLogger {
  warn?: (message: string) => void;
}

/** The fields of OpenClaw's agent hook context the budget gate reads. */
interface AgentRunContext {
  agentId?: string;
  sessionKey?: string;
  /** Channel/plugin id for channel-originated runs, e.g. `telegram`. */
  channel?: string;
  messageProvider?: string;
  senderId?: string;
  trigger?: string;
}

/** OpenClaw's input-gate decision. `reason` is internal; `message` is shown. */
type GateDecision =
  { outcome: "pass" } | { outcome: "block"; reason: string; message?: string; category?: string };

interface PluginApi {
  pluginConfig?: PluginConfig;
  logger?: PluginLogger;
  on: {
    (
      hookName: "before_tool_call" | "after_tool_call",
      handler: (
        event: BeforeToolCallEvent | AfterToolCallEvent,
        ctx: ToolHookContext
      ) => Promise<void>
    ): void;
    (
      hookName: "before_agent_run",
      handler: (event: unknown, ctx: AgentRunContext) => Promise<GateDecision>
    ): void;
  };
}

interface ToolAuditPayload {
  phase: "start" | "end";
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface RecentToolStart {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  at: number;
}

// ── Standalone sanitization (no imports from @pinchy/web) ───────────

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_DEPTH = 10;

// SYNC: This sanitization logic is duplicated in packages/web/src/lib/audit-sanitize.ts
// Keep both copies in sync when adding/removing patterns.
const SENSITIVE_KEYS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "private_key",
  "privatekey",
  "passphrase",
  "access_key",
  "accesskey",
  "client_secret",
  "clientsecret",
];

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9\-]{20,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /xoxb-[a-zA-Z0-9\-]+/g,
  /xoxp-[a-zA-Z0-9\-]+/g,
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/g,
  /[0-9]{8,10}:[a-zA-Z0-9_\-]{35}/g,
  /EAA[a-zA-Z0-9]{20,}/g,
];

const ENV_SECRET_LINE = /^([A-Z_]*(SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*)=(.+)$/gim;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((pattern) => lower.includes(pattern));
}

// Numeric values under keys ending in "tokens" are token COUNTS (usage
// counters like inputTokens/totalTokens), not credentials. Conservative on
// purpose: only numbers are exempt — a string under such a key stays redacted.
function isExemptTokenCount(key: string, value: unknown): boolean {
  return typeof value === "number" && /tokens$/i.test(key);
}

function redactPatterns(value: string): string {
  if (value === REDACTED) return value;
  let result = value;
  ENV_SECRET_LINE.lastIndex = 0;
  result = result.replace(ENV_SECRET_LINE, `$1=${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  // The depth cap exists to stop unbounded recursion (a cyclic or
  // pathologically deep structure), not to grant an escape hatch from
  // redaction. Returning the container here would forward every key inside it
  // UNREDACTED into an append-only, HMAC-chained audit row that can never be
  // rewritten — a real Odoo command tuple nests to depth ~6, well within reach
  // of a secret this cap would otherwise pass through verbatim.
  //
  // Only containers are truncated, because only containers are what the cap
  // stops us from inspecting. A leaf at this depth was handed down by an object
  // at depth < MAX_DEPTH, which already applied the sensitive-key check to it,
  // and pattern redaction below is depth-independent — so a deep scalar is
  // exactly as sanitized as a shallow one. Replacing it too would cost
  // diagnostics bundles their deepest tool arguments for no gain.
  if (depth >= MAX_DEPTH && typeof value === "object" && !(value instanceof Date)) {
    return TRUNCATED;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  // Dates have no own enumerable properties — the generic object branch below
  // would strip them to {}. Serialize like JSON.stringify would.
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (
        isSensitiveKey(key) &&
        val !== null &&
        val !== undefined &&
        !isExemptTokenCount(key, val)
      ) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeValue(val, depth + 1);
      }
    }
    return result;
  }
  if (typeof value === "string") return redactPatterns(value);
  return value;
}

function sanitizePayloadFields(payload: ToolAuditPayload): ToolAuditPayload {
  return {
    ...payload,
    params: sanitizeValue(payload.params, 0) as Record<string, unknown>,
    result: sanitizeValue(payload.result, 0),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function extractAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1];
}

function cleanupRecentToolStarts(recentStarts: Map<string, RecentToolStart>): void {
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000;

  for (const [key, value] of recentStarts.entries()) {
    if (now - value.at > maxAgeMs) {
      recentStarts.delete(key);
    }
  }
}

// Key the start record by a per-call identity, not by tool name. The plugin
// instance is shared across agents, so two overlapping calls of the SAME tool
// name (two agents, or one agent's parallel tool calls) would collide on a
// name-only key and the after-hook would read back the wrong agent/session,
// misattributing a tamper-evident audit row. toolCallId is the most specific;
// runId scopes the fallback to one run; toolName alone is the last resort.
function toolStartKey(
  toolCallId: string | undefined,
  runId: string | undefined,
  toolName: string
): string {
  if (toolCallId) return toolCallId;
  if (runId) return `${runId}:${toolName}`;
  return toolName;
}

const MAX_RETRIES = 2;
// Deliberately short: this hook runs synchronously in the tool-call path, so
// every millisecond here is a millisecond the agent's tool call is blocked.
const RETRY_BACKOFF_MS = 250;

// Longest reason string worth putting in a warning/error. Pinchy's own API
// errors are a short `error` string, and anything longer than this is a
// stack trace or an HTML error page, neither of which belongs in a one-line
// message.
const MAX_REASON_CHARS = 200;

/**
 * Best-effort read of a rejection body, for the error/log message only.
 * Returns an empty string if the body is unreadable — diagnosing a failure
 * must never cause a different one. Mirrors pinchy-transcript's
 * readErrorBody (#599: a bare status code once sent a debugging session
 * hunting the wrong layer, when the body already named the real cause), and
 * pinned to it by read-error-body-drift.test.ts.
 */
async function readErrorBody(res: { text?: () => Promise<string> }): Promise<string> {
  try {
    // Collapse first: a proxy answers with a multi-line HTML document, and a
    // warning that spans lines stops being one log entry — whatever ships
    // these logs onward indexes the fragments separately.
    const trimmed = ((await res.text?.()) ?? "").replace(/\s+/g, " ").trim();
    if (!trimmed) return "";
    // Pinchy's API errors are `{"error":"…"}`; unwrap so the reason reads as a
    // sentence rather than as JSON.
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error) {
        return parsed.error.slice(0, MAX_REASON_CHARS);
      }
    } catch {
      // Not JSON (a proxy's HTML error page, say) — fall through to raw text.
    }
    return trimmed.slice(0, MAX_REASON_CHARS);
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is this status one the server will answer the same way for an identical
 * retry? True for most of 4xx — a bad payload stays bad, a revoked token stays
 * revoked — but NOT for the two statuses whose whole meaning is "try again":
 *
 *   408 Request Timeout    the server gave up waiting, not a claim about us
 *   429 Too Many Requests  load shedding, and by definition temporary
 *
 * The carve-out matters more here than in pinchy-transcript, which the 4xx
 * shortcut is modelled on: transcript drops the message, this hook fails
 * CLOSED. Calling a 429 definitive would abort the tool call of every agent
 * for as long as Pinchy is shedding load — turning a self-healing overload
 * into a platform-wide outage. `/api/internal/usage/record` already answers
 * 429 from a pre-auth rate limiter, so this is one sibling route away from
 * being live rather than hypothetical.
 */
function isDefinitiveRejection(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

// Bounds every attempt against a hung Pinchy container / network blackhole.
// This hook runs before EVERY tool call of EVERY agent, so an unbounded fetch
// here blocks all tool dispatch indefinitely. Note the worst case is this
// times MAX_RETRIES + 1, plus the backoff spent between those attempts — an
// unreachable Pinchy costs ~30.75s per tool call before the hook fails closed.
const FETCH_TIMEOUT_MS = 10_000;

async function postToolAuditEvent(
  cfg: PluginConfig,
  logger: PluginLogger | undefined,
  payload: ToolAuditPayload
): Promise<void> {
  const endpoint = `${normalizeBaseUrl(cfg.apiBaseUrl)}/api/internal/audit/tool-use`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let nonRetryable = false;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.gatewayToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.ok) return;

      // A definitive 4xx is our own bug (bad payload, revoked token, ...), not
      // a transient fault — the server will reject an identical retry the same
      // way, so retrying only spends this hook's tool-call-blocking window
      // for nothing. Quote the body so the eventual error names the real
      // reason instead of a bare status code.
      if (isDefinitiveRejection(res.status)) {
        const reason = await readErrorBody(res);
        lastError = new Error(
          `[pinchy-audit] audit endpoint rejected ${payload.phase} ${payload.toolName} (${res.status}${reason ? `: ${reason}` : ""})`
        );
        nonRetryable = true;
      } else {
        lastError = new Error(
          `[pinchy-audit] audit endpoint returned ${res.status} for ${payload.phase} ${payload.toolName}`
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (nonRetryable) break;

    if (attempt < MAX_RETRIES) {
      logger?.warn?.(
        `[pinchy-audit] audit failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying: ${lastError?.message}`
      );
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  // Every attempt failed (or landed on a definitive rejection above). Throwing
  // is deliberate, not an oversight: audit is a product feature — see AGENTS.md
  // § "API Routes And Audit Trail" — not a best-effort side channel, so a
  // failure to record must surface rather than be swallowed.
  //
  // What the throw buys differs per hook, and only one of the two is genuinely
  // fail-closed. Do not read the stronger guarantee onto both:
  //
  //   before_tool_call  the tool has NOT run yet, so raising here is what stops
  //                     an un-auditable action from happening at all.
  //   after_tool_call   the tool has ALREADY run. Nothing here can undo it; the
  //                     throw only reports the missing end-of-call record.
  //
  // The tests in index.test.ts assert that this function rejects — they say
  // nothing about how OpenClaw handles a rejecting hook, which is the runtime's
  // contract and not ours to claim from here.
  throw lastError;
}

// ── Budget gate (before_agent_run) ──────────────────────────────────
//
// Pinchy's blocking cost budgets (#36), enforced where every run passes: here,
// before the model reads the prompt, on every channel. Design of record:
// plans/2026-10-19-budget-runtime-gate-design.md.
//
// Two runtime facts shape this code (OpenClaw 2026.7.1):
//   - returning `undefined` is a BLOCK, not a pass — always return a decision;
//   - a throw or the 15s hook timeout is a block too — never throw, and bound
//     the fetch well inside that window.
//
// When Pinchy cannot be asked, the gate fails OPEN, unless the last answer for
// that agent was a block: failing closed would turn every Pinchy restart into
// a refused message on every channel of every instance, budgets or not.

const PASS: GateDecision = { outcome: "pass" };
// A pass is reused for this long, so a busy agent asks Pinchy at most a few
// times a minute. A block is never reused while Pinchy answers: every refused
// turn is audited, and a raised budget reopens on the very next message.
const BUDGET_PASS_CACHE_MS = 15_000;
// Same Docker network, one indexed query: a healthy answer takes milliseconds.
const BUDGET_CHECK_TIMEOUT_MS = 3_000;
// After a failed check, answer from what is known for this long before asking
// again: a down Pinchy must not add a 3s timeout to every run of every agent.
const BUDGET_FAILURE_PAUSE_MS = 10_000;

/** Pinchy answered, and will answer an identical request the same way. */
class BudgetCheckRejected extends Error {}

type BudgetAnswer = { blocked: false } | { blocked: true; message: string };

function parseBudgetAnswer(body: unknown): BudgetAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { blocked?: unknown; message?: unknown };
  if (b.blocked === false) return { blocked: false };
  if (b.blocked === true && typeof b.message === "string" && b.message.trim()) {
    return { blocked: true, message: b.message };
  }
  return null;
}

function budgetBlock(message: string): GateDecision {
  return { outcome: "block", reason: "budget_exhausted", message, category: "cost_limit" };
}

async function askBudget(cfg: PluginConfig, body: Record<string, unknown>): Promise<BudgetAnswer> {
  const res = await fetch(`${normalizeBaseUrl(cfg.apiBaseUrl)}/api/internal/budgets/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.gatewayToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BUDGET_CHECK_TIMEOUT_MS),
  });
  if (!res.ok) {
    const reason = await readErrorBody(res);
    const message = `budget check returned ${res.status}${reason ? `: ${reason}` : ""}`;
    throw isDefinitiveRejection(res.status) ? new BudgetCheckRejected(message) : new Error(message);
  }
  const answer = parseBudgetAnswer(await res.json());
  if (!answer) throw new Error("budget check returned an answer it could not read");
  return answer;
}

/** Only real strings: OpenClaw's context fields are typed, not guaranteed. */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function createBudgetGate(cfg: PluginConfig, logger: PluginLogger | undefined) {
  // The last answer per agent, and when it came.
  const lastAnswer = new Map<string, { answer: BudgetAnswer; at: number }>();
  // Pinchy-wide, not per agent: when one check fails, they all would.
  let lastFailureAt: number | undefined;
  let failing = false;

  // What to do without an answer: keep a block, otherwise let the run through.
  const fallback = (agentId: string): GateDecision => {
    const last = lastAnswer.get(agentId);
    return last?.answer.blocked ? budgetBlock(last.answer.message) : PASS;
  };

  return async (_event: unknown, ctx: AgentRunContext): Promise<GateDecision> => {
    const agentId = stringField(ctx.agentId) ?? extractAgentIdFromSessionKey(ctx.sessionKey);
    if (!agentId) return PASS;

    const last = lastAnswer.get(agentId);
    if (last && !last.answer.blocked && Date.now() - last.at < BUDGET_PASS_CACHE_MS) return PASS;
    if (lastFailureAt !== undefined && Date.now() - lastFailureAt < BUDGET_FAILURE_PAUSE_MS) {
      return fallback(agentId);
    }

    try {
      // Who and where only — never the prompt, the history or the system
      // prompt the hook is handed.
      const answer = await askBudget(cfg, {
        agentId,
        sessionKey: stringField(ctx.sessionKey),
        channel: stringField(ctx.channel) ?? stringField(ctx.messageProvider),
        senderId: stringField(ctx.senderId),
        trigger: stringField(ctx.trigger),
      });
      lastAnswer.set(agentId, { answer, at: Date.now() });
      lastFailureAt = undefined;
      if (failing) {
        failing = false;
        logger?.warn?.("[pinchy-audit] budget check answers again; blocking budgets are enforced");
      }
      return answer.blocked ? budgetBlock(answer.message) : PASS;
    } catch (error) {
      lastFailureAt = Date.now();
      const decision = fallback(agentId);
      // Once per outage: during one, every run of every agent lands here.
      if (!failing) {
        failing = true;
        const message = error instanceof Error ? error.message : String(error);
        const effect =
          error instanceof BudgetCheckRejected
            ? "Pinchy rejected it, so blocking budgets are not enforced until this is fixed"
            : decision.outcome === "block"
              ? "keeping the last answer for paused agents and letting the others through"
              : "letting runs through until Pinchy answers";
        logger?.warn?.(
          `[pinchy-audit] budget check failed for agent ${agentId}: ${message} — ${effect}`
        );
      }
      return decision;
    }
  };
}

const plugin = {
  id: "pinchy-audit",
  name: "Pinchy Audit",
  description:
    "Source-level tool execution audit logging for all OpenClaw tools, and the runtime gate for Pinchy's blocking cost budgets.",
  configSchema: {
    validate: (value: unknown) => {
      if (value && typeof value === "object" && "apiBaseUrl" in value && "gatewayToken" in value) {
        return { ok: true as const, value };
      }
      return { ok: false as const, errors: ["Missing required keys in config"] };
    },
  },

  register(api: PluginApi) {
    const cfg = api.pluginConfig;
    if (!cfg?.apiBaseUrl || !cfg?.gatewayToken) {
      api.logger?.warn?.("[pinchy-audit] plugin config is missing apiBaseUrl or gatewayToken");
      return;
    }

    const recentStarts = new Map<string, RecentToolStart>();

    api.on("before_agent_run", createBudgetGate(cfg, api.logger));

    api.on("before_tool_call", async (event, ctx) => {
      cleanupRecentToolStarts(recentStarts);
      const beforeEvent = event as BeforeToolCallEvent;
      const agentId = ctx.agentId ?? extractAgentIdFromSessionKey(ctx.sessionKey);

      const startKey = toolStartKey(
        beforeEvent.toolCallId ?? ctx.toolCallId,
        beforeEvent.runId ?? ctx.runId,
        beforeEvent.toolName
      );
      recentStarts.set(startKey, {
        agentId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        runId: beforeEvent.runId ?? ctx.runId,
        at: Date.now(),
      });

      await postToolAuditEvent(
        cfg,
        api.logger,
        sanitizePayloadFields({
          phase: "start",
          toolName: beforeEvent.toolName,
          params: beforeEvent.params,
          runId: beforeEvent.runId ?? ctx.runId,
          toolCallId: beforeEvent.toolCallId ?? ctx.toolCallId,
          agentId,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
        })
      );
    });

    api.on("after_tool_call", async (event, ctx) => {
      cleanupRecentToolStarts(recentStarts);
      const afterEvent = event as AfterToolCallEvent;
      const startKey = toolStartKey(
        afterEvent.toolCallId ?? ctx.toolCallId,
        afterEvent.runId ?? ctx.runId,
        afterEvent.toolName
      );
      const recent = recentStarts.get(startKey);
      const sessionKey = ctx.sessionKey ?? recent?.sessionKey;
      const sessionId = ctx.sessionId ?? recent?.sessionId;
      const runId = afterEvent.runId ?? ctx.runId ?? recent?.runId;
      const agentId = ctx.agentId ?? extractAgentIdFromSessionKey(sessionKey) ?? recent?.agentId;

      await postToolAuditEvent(
        cfg,
        api.logger,
        sanitizePayloadFields({
          phase: "end",
          toolName: afterEvent.toolName,
          params: afterEvent.params,
          runId,
          toolCallId: afterEvent.toolCallId ?? ctx.toolCallId,
          agentId,
          sessionKey,
          sessionId,
          result: afterEvent.result,
          error: afterEvent.error,
          durationMs: afterEvent.durationMs,
        })
      );
    });
  },
};

export default plugin;
