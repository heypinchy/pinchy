import { OdooClient } from "odoo-node";
import type { PinnedOdooFetch } from "./odoo-pin";
import { runWithConcurrency } from "@/lib/concurrency";
import {
  describeOdooError,
  isOdooTimeout,
  odooTimeoutMessage,
} from "@/lib/integrations/odoo-error";
import { readOdooFields } from "@/lib/integrations/odoo-calls";

export { MODEL_CATEGORIES, type ModelCategory } from "./odoo-model-catalog";
import { MODEL_CATEGORIES } from "./odoo-model-catalog";

/**
 * Given synced schema data, return the labels of categories that have at least one accessible model.
 * Used by the integration card to show a summary.
 */
export function getAccessibleCategoryLabels(
  data: { models?: Array<{ model: string }> } | null
): string[] {
  if (!data?.models) return [];
  const modelNames = new Set(data.models.map((m) => m.model));
  return MODEL_CATEGORIES.filter((cat) => cat.models.some((m) => modelNames.has(m.model))).map(
    (cat) => cat.label
  );
}

/** Flat list of all known models (derived from categories). */
const ALL_KNOWN_MODELS = MODEL_CATEGORIES.flatMap((cat) =>
  cat.models.map((m) => ({ ...m, category: cat.id }))
);

export interface CategorySummary {
  id: string;
  label: string;
  accessible: boolean;
  accessibleModels: string[];
  totalModels: number;
}

export interface OdooSyncResult {
  success: true;
  models: number;
  lastSyncAt: string;
  categories: CategorySummary[];
  data: {
    models: Array<{
      model: string;
      name: string;
      fields: unknown[];
      access: { read: boolean; create: boolean; write: boolean; delete: boolean };
    }>;
    lastSyncAt: string;
  };
}

export interface OdooSyncError {
  success: false;
  error: string;
  isAuthError: boolean;
}

const MAX_CONCURRENCY = 5;
const MAX_RETRIES = 2;

/**
 * Returns true if the error is Odoo refusing this user access (should not
 * retry). An HTTP-level error is not: "HTTP 405: Method Not Allowed" is the
 * server refusing the method, whatever words its status line uses.
 */
function isAccessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isHttpLevelError(error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("accesserror") ||
    msg.includes("access denied") ||
    msg.includes("not allowed") ||
    msg.includes("permission denied")
  );
}

/**
 * Did any answer arrive? odoo-node's errors say so by shape: Odoo's own
 * JSON-RPC error carries `data` (its `code` is the JSON-RPC one, e.g. 200);
 * an HTTP error, a refused redirect or a non-JSON-RPC body carries the HTTP
 * status in `code` and no `data`; a request that got no answer at all carries
 * `code` 0 — and a bare error from elsewhere carries neither.
 */
function odooAnswered(error: unknown): boolean {
  return isHttpLevelError(error) || (error as { data?: unknown } | null)?.data !== undefined;
}

/** odoo-node's shape for an HTTP-level failure: the status in `code`, no `data`. */
function isHttpLevelError(error: unknown): boolean {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: unknown };
  return typeof code === "number" && code >= 100 && data === undefined;
}

/** odoo-node's shape for no usable answer at all — even one that broke off. */
function isNoAnswerError(error: unknown): boolean {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: unknown };
  return code === 0 && data === undefined;
}

/** How many distinct failure texts a mixed sync failure names. */
const MAX_NAMED_FAILURES = 3;

/** Returns true when retrying the fields_get probe could plausibly succeed. */
function isTransientOdooProbeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("econnaborted") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to access host") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("429") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout") ||
    msg.includes("temporarily unavailable")
  );
}

/**
 * Fetch schema from an Odoo instance by probing curated models via fields_get().
 * Does NOT require admin/ir.model access — only needs read access on individual models.
 * Models the user cannot access are silently skipped. When no model is
 * readable and no probe reported an access problem, every probe failed for
 * another reason, and the error says which: "Could not reach Odoo: …" when
 * none got an answer, the shared error when all failed alike (a refused
 * redirect, a proxy error), otherwise the first few distinct failures.
 * Retries transient errors (network resets, rate limits, 5xx) up to MAX_RETRIES times.
 * A request the pinned fetch's bound cut off is not retried, and no further
 * probe starts: Odoo took the connection and went silent, and each probe of
 * it would cost the whole bound again. Such a sync fails, even when some
 * models answered first — a partial schema would drop the rest.
 * The same holds for a probe that gives up without an answer from Odoo
 * itself: no answer at all, or an HTTP-level one (a proxy's 502 or 504, a
 * page that is not JSON-RPC). Every model goes through the same endpoint, so
 * that is the connection failing, not a model to skip; probes already
 * running finish, none starts after it, and the sync fails. Only Odoo's own
 * error about one model (it is not installed, say) skips that model.
 * Limits concurrency to MAX_CONCURRENCY to avoid overwhelming the server.
 * Does NOT save anything — returns the data for the caller to handle.
 */
export async function fetchOdooSchema(credentials: {
  url: string;
  db: string;
  uid: number;
  apiKey: string;
  /** The fetch from `withPinnedOdoo` for this URL: every probe goes through it. */
  fetch: PinnedOdooFetch;
}): Promise<OdooSyncResult | OdooSyncError> {
  const client = new OdooClient({
    url: credentials.url,
    db: credentials.db,
    uid: credentials.uid,
    apiKey: credentials.apiKey,
    fetch: credentials.fetch,
  });

  type AccessRights = {
    read: boolean;
    create: boolean;
    write: boolean;
    delete: boolean;
  };

  type ProbeResult = {
    model: string;
    name: string;
    category: string;
    fields: unknown[];
    accessible: boolean;
    access?: AccessRights;
    hadAccessError?: boolean;
    /**
     * Why the probe failed, when it failed for a reason other than access.
     * `unreachable`: it ran out of retries without any answer from Odoo.
     */
    failure?: { text: string; unreachable: boolean; connection?: boolean };
    /** Never probed: an earlier probe gave up on the connection. */
    skipped?: boolean;
  };

  /** Set once any request timed out; probes not yet started are skipped. */
  let stoppedAnswering = false;
  /** Set once a probe gave up without an answer from Odoo itself. */
  let gaveUp = false;

  const tasks = ALL_KNOWN_MODELS.map(({ model, name, category }) => {
    return async (): Promise<ProbeResult> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (stoppedAnswering) {
          const failure = { text: odooTimeoutMessage(), unreachable: true };
          return { model, name, category, fields: [], accessible: false, failure };
        }
        if (attempt === 0 && gaveUp) {
          return { model, name, category, fields: [], accessible: false, skipped: true };
        }
        try {
          const fields = await readOdooFields(client, model);

          // Check per-operation access rights
          const safeCheck = async (
            op: "read" | "create" | "write" | "unlink"
          ): Promise<boolean> => {
            try {
              return await client.checkAccessRights(model, op);
            } catch (error) {
              // Only Odoo's own error says something about access; anything
              // else (no answer, a proxy's status, a reset) is the request
              // failing, and goes the way of a failed fields_get.
              if ((error as { data?: unknown } | null)?.data !== undefined) return false;
              throw error;
            }
          };

          const [read, create, write, unlink] = await Promise.all([
            safeCheck("read"),
            safeCheck("create"),
            safeCheck("write"),
            safeCheck("unlink"),
          ]);

          const access = { read, create, write, delete: unlink };

          // Skip models without read access
          if (!read) {
            return { model, name, category, fields: [], accessible: false };
          }

          return { model, name, category, fields, accessible: true, access };
        } catch (error) {
          if (isOdooTimeout(error)) {
            stoppedAnswering = true;
            const failure = { text: describeOdooError(error), unreachable: true };
            return { model, name, category, fields: [], accessible: false, failure };
          }
          if (isAccessError(error)) {
            // Permanent access denial — flag it so the caller can distinguish
            // auth-related failures (which should mark the integration as
            // auth_failed) from transient errors.
            return { model, name, category, fields: [], accessible: false, hadAccessError: true };
          }
          const transient = isTransientOdooProbeError(error);
          if (!transient || attempt === MAX_RETRIES) {
            // Non-transient, or out of retries — no point in trying again.
            const described = describeOdooError(error);
            const unreachable = isNoAnswerError(error) || (transient && !odooAnswered(error));
            const connection = unreachable || isHttpLevelError(error);
            if (connection) gaveUp = true;
            // A bare status line may come from a proxy in front of Odoo as
            // much as from Odoo, retried or not; a described message that
            // already says what came back ("Odoo answered with …") needs no
            // prefix. Only an error carrying Odoo's `data` is Odoo's own.
            const text = unreachable
              ? described
              : isHttpLevelError(error) && described.startsWith("HTTP ")
                ? `The Odoo address answered with an error: ${described}`
                : transient && !isHttpLevelError(error)
                  ? `Odoo did not answer successfully: ${described}`
                  : described;
            return {
              model,
              name,
              category,
              fields: [],
              accessible: false,
              failure: { text, unreachable, connection },
            };
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      return { model, name, category, fields: [], accessible: false };
    };
  });

  const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

  if (stoppedAnswering) {
    const answeredFirst = results.some((r) => !r.failure?.unreachable);
    return {
      success: false,
      error: answeredFirst
        ? `Odoo stopped answering partway through reading its models: ${odooTimeoutMessage()}`
        : `Could not reach Odoo: ${odooTimeoutMessage()}`,
      isAuthError: false,
    };
  }

  const probed = results.filter((r) => !r.skipped);
  const accessibleModels = probed.filter((r) => r.accessible && r.fields.length > 0);

  /** The first few distinct failure texts, and whether none got an answer. */
  const summarize = (failures: Array<{ text: string; unreachable: boolean }>) => {
    const distinct = [...new Set(failures.map((f) => f.text))];
    const texts =
      distinct.slice(0, MAX_NAMED_FAILURES).join("; ") +
      (distinct.length > MAX_NAMED_FAILURES ? "; …" : "");
    // Every probe failing to reach Odoo, or failing the same way (a refused
    // redirect, a proxy error), is one failure of the connection.
    const error = failures.every((f) => f.unreachable)
      ? `Could not reach Odoo: ${texts}`
      : distinct.length === 1
        ? texts
        : `Could not read any Odoo model: ${texts}`;
    return { texts, error };
  };

  if (gaveUp) {
    // Only what stopped the sync: Odoo's own error about a model it doesn't
    // have would otherwise push the proxy or network error out of view.
    const failures = probed.flatMap((r) => (r.failure?.connection ? [r.failure] : []));
    const { texts, error } = summarize(failures);
    return {
      success: false,
      error:
        accessibleModels.length > 0
          ? `Reading Odoo's models failed partway through, so nothing was saved: ${texts}`
          : error,
      isAuthError: false,
    };
  }

  if (accessibleModels.length === 0) {
    const anyAccessError = results.some((r) => r.hadAccessError);
    const failures = results.map((r) => r.failure);
    // Only claim missing read access when a probe actually reported an access
    // problem: Odoo denied it, or granted no read right.
    if (!anyAccessError && failures.every((f) => f !== undefined)) {
      return {
        success: false,
        error: summarize(failures.map((f) => f!)).error,
        isAuthError: false,
      };
    }
    return {
      success: false,
      error:
        "Could not access any Odoo models. Please ensure the API user has at least " +
        "read access to the modules you want to use (e.g. Sales, Inventory, Contacts).",
      isAuthError: anyAccessError,
    };
  }

  // Build category summary
  const categories: CategorySummary[] = MODEL_CATEGORIES.map((cat) => {
    const catResults = results.filter((r) => r.category === cat.id);
    const accessible = catResults.filter((r) => r.accessible && r.fields.length > 0);
    return {
      id: cat.id,
      label: cat.label,
      accessible: accessible.length > 0,
      accessibleModels: accessible.map((r) => r.name),
      totalModels: cat.models.length,
    };
  });

  const models = accessibleModels.map(({ model, name, fields, access }) => ({
    model,
    name,
    fields,
    access: access!,
  }));
  const lastSyncAt = new Date().toISOString();
  const data = { models, lastSyncAt };

  return { success: true, models: models.length, lastSyncAt, categories, data };
}
