import { readFile, stat } from "./io";
import { basename, extname } from "path";
import { OdooClient, type OdooDomain } from "odoo-node";
import { checkPermission, type Permissions } from "./permissions";
import {
  decodeRef,
  encodeRef,
  isIntegrationRef,
  MalformedIntegrationRefError,
  type IntegrationRefPayload,
} from "./integration-ref";

const WORKSPACE_ROOT = "/root/.openclaw/workspaces";

// 25 MB matches Odoo's default `web.max_file_upload_size` setting. Keeps the
// plugin process from OOMing on a single attachment (readFile + base64 string
// roughly triple the file's footprint in memory).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

function mimeForFilename(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// Reject filenames that could escape the agent's uploads directory.
// `basename` strips POSIX path components; the extra checks catch
// Windows-style backslashes, leading-dot hidden files, and ".." / "."
// segments that survive basename on Linux.
function isSafeFilename(filename: string): boolean {
  if (typeof filename !== "string" || filename.length === 0) return false;
  if (filename !== basename(filename)) return false;
  if (filename.startsWith(".")) return false;
  if (filename.includes("\\")) return false;
  return true;
}

interface PluginToolContext {
  agentId?: string;
}

interface ContentBlock {
  type: string;
  text: string;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string }
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
    content: ContentBlock[];
    isError?: boolean;
    details?: unknown;
  }>;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, AgentOdooConfig>;
}

export interface AgentOdooConfig {
  connectionId: string;
  permissions: Permissions;
  modelNames?: Record<string, string>;
}

interface OdooCredentials {
  url: string;
  db: string;
  uid: number;
  apiKey: string;
}

export interface OdooField {
  name: string;
  string?: string;
  type?: string;
  relation?: string;
  selection?: Array<[string, string]>;
  readonly?: boolean;
  required?: boolean;
}

type OdooRecord = Record<string, unknown>;

interface OdooRefValue {
  ref: string;
  label: string;
  model: string;
}

interface RelationLookup {
  name?: string;
  code?: string;
}

const COUNTRY_ALIASES_TO_CODE: Record<string, string> = {
  america: "US",
  usa: "US",
  us: "US",
  unitedstates: "US",
  unitedstatesofamerica: "US",
};

function getAgentConfig(
  agentConfigs: Record<string, AgentOdooConfig>,
  agentId: string
): AgentOdooConfig | null {
  return agentConfigs[agentId] ?? null;
}

/**
 * Defense-in-depth: fail fast with a clear error if the credentials API
 * returns the wrong shape (e.g. a SecretRef object instead of strings —
 * the bug that caused Odoo's Python server to crash with
 * `unhashable type: 'dict'`, see issue #209). Without this assertion a
 * malformed payload would propagate all the way to Odoo before erroring.
 */
function assertCredentialsShape(creds: unknown): asserts creds is OdooCredentials {
  if (!creds || typeof creds !== "object") {
    throw new Error(`pinchy-odoo: credentials must be an object, got ${typeof creds}`);
  }
  const obj = creds as Record<string, unknown>;
  // Detect the SecretRef-shaped payload (#209) up front so the error
  // message points at the actual root cause instead of a "field missing"
  // symptom that's harder to debug.
  const looksLikeSecretRef =
    typeof obj.source === "string" &&
    typeof obj.provider === "string" &&
    typeof obj.id === "string";
  const expected: Array<[keyof OdooCredentials, "string" | "number"]> = [
    ["url", "string"],
    ["db", "string"],
    ["uid", "number"],
    ["apiKey", "string"],
  ];
  for (const [name, type] of expected) {
    const actual = typeof obj[name];
    if (actual !== type) {
      const hint = looksLikeSecretRef
        ? " (the credentials API returned an unresolved SecretRef — see #209)"
        : actual === "object"
          ? " (looks like an unresolved SecretRef — see #209)"
          : "";
      throw new Error(`pinchy-odoo: credentials.${name} must be a ${type}, got ${actual}${hint}`);
    }
  }
}

/**
 * Fetch decrypted Odoo credentials from Pinchy's internal credentials API.
 *
 * The plugin only ever sees the connectionId and a gateway token — the
 * actual apiKey lives in Pinchy's encrypted database and is delivered
 * over a single authenticated HTTP request per cache miss. This keeps
 * `openclaw.json` free of long-lived per-tenant secrets and lets Pinchy
 * own rotation, audit, and per-agent authorization centrally.
 *
 * See: packages/web/src/app/api/internal/integrations/[connectionId]/credentials/route.ts
 */
async function fetchCredentials(
  apiBaseUrl: string,
  gatewayToken: string,
  connectionId: string
): Promise<OdooCredentials> {
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`,
    { headers: { Authorization: `Bearer ${gatewayToken}` } }
  );
  if (!response.ok) {
    // The credentials route puts an actionable message in the JSON body (e.g. a
    // 404 "This integration is no longer connected …") — surface it so the agent
    // reports something a user can act on, not a bare HTTP status. Read the body
    // tolerantly: a non-JSON body must not mask the original status.
    const body = await (async () => {
      try {
        return (await response.json()) as { error?: unknown };
      } catch {
        return null;
      }
    })();
    const detail = body && typeof body.error === "string" ? `: ${body.error}` : "";
    throw new Error(
      `Failed to fetch Odoo credentials for connection ${connectionId}: ` +
        `HTTP ${response.status} ${response.statusText}${detail}`
    );
  }
  const data = (await response.json()) as { credentials?: unknown };
  assertCredentialsShape(data.credentials);
  return data.credentials;
}

function createClient(creds: OdooCredentials): OdooClient {
  return new OdooClient({
    url: creds.url,
    db: creds.db,
    uid: creds.uid,
    apiKey: creds.apiKey,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Some LLMs (observed: ollama-cloud/gemini-3-flash-preview during v0.5.4 staging
// click-through) emit tool_call arguments where the keys of object-valued args
// are wrapped in literal JSON-quoted strings — e.g. `{"\"name\"": "Tesla"}`
// instead of `{"name": "Tesla"}`. Whether this is the model's tokenizer leaking
// raw JSON into the arguments string or a pi-ai parsing quirk is upstream of us;
// at the plugin edge we just strip a single surrounding pair of quotes from each
// key before forwarding to Odoo. Odoo field names never contain quotes, so this
// rewrite is information-preserving for the well-formed case.
//
// Recursion matters: Odoo's many2many/one2many commands nest fresh records,
// e.g. `{ invoice_line_ids: [[0, 0, { quantity: 1, price_unit: 8.33 }]] }`.
// Strip quotes at every depth so the inner field names land clean too.
function unquoteFieldKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unquoteFieldKeysDeep);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const stripped =
      key.length >= 2 && key.startsWith('"') && key.endsWith('"') ? key.slice(1, -1) : key;
    out[stripped] = unquoteFieldKeysDeep(val);
  }
  return out;
}

// A second, distinct model-serialization quirk (observed: ollama-cloud/
// deepseek-v4-pro in production, pinchy-bugreport-penny-20260716): array-valued
// tool arguments arrive wrapped as single-key `{item: …}` objects, nested for
// nested arrays — e.g. `tax_ids: [[6, 0, [172]]]` becomes
// `{item: {item: ["6", "0", {item: "172"}]}}`. This is the XML-style array
// serialization certain tool-calling transports produce (documented across
// runtimes, e.g. llama.cpp ggml-org/llama.cpp#21384), and it is upstream of us.
//
// Unlike the quoted-key quirk above, this one is LOSSY: single-element arrays
// collapse to scalars and ints stringify, so it cannot be reconstructed here
// without Odoo's schema (which command position is an id list). Silently
// guessing would forward wrong data. So we DETECT it and return an actionable
// error naming the artifact and the correct plain-array shape — best-practice
// for tool robustness (typed, self-correcting error over hidden coercion) —
// instead of letting Odoo reject it with an opaque "unhashable type: 'dict'" or
// "Wrong value for …: {'item': …}" that the model cannot act on.
export function hasItemWrappedArray(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(value)) {
    return value.some((v) => hasItemWrappedArray(v, depth + 1));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "item") return true;
    return Object.values(value).some((v) => hasItemWrappedArray(v, depth + 1));
  }
  return false;
}

/**
 * Error for the `{item: …}` array-wrapping quirk, naming the artifact and
 * showing the correct plain-array shape so the model can re-issue the call.
 */
function itemWrappedError(paramName: string): Error {
  return new Error(
    `Your \`${paramName}\` arrived with arrays wrapped as {"item": …} objects instead of plain JSON arrays — a serialization artifact from the model, not a value Odoo can accept. ` +
      `Re-issue the call with plain arrays. For example, a one2many field is invoice_line_ids: [[0, 0, {…}]], ` +
      `a many2many is tax_ids: [[6, 0, [<id>]]], and a domain is [["state", "=", "posted"]] — ` +
      `never {"item": {"item": [...]}}.`
  );
}

function unquoteFieldKeys(values: Record<string, unknown>): Record<string, unknown> {
  return unquoteFieldKeysDeep(values) as Record<string, unknown>;
}

const TYPE_ABBREVIATIONS: Record<string, string> = {
  integer: "int",
  char: "char",
  text: "text",
  float: "float",
  monetary: "float",
  boolean: "bool",
  date: "date",
  datetime: "datetime",
  binary: "binary",
  html: "html",
};

const MAX_SELECTION_OPTIONS = 20;

export function compactType(field: OdooField): string {
  if (field.type === "many2one") return `m2o:${field.relation ?? "?"}`;
  if (field.type === "one2many") return `o2m:${field.relation ?? "?"}`;
  if (field.type === "many2many") return `m2m:${field.relation ?? "?"}`;
  if (field.type === "selection") {
    const all = field.selection ?? [];
    const opts = all.slice(0, MAX_SELECTION_OPTIONS).map(([key]) => key);
    const tail = all.length > MAX_SELECTION_OPTIONS ? "|..." : "";
    return `selection:${opts.join("|")}${tail}`;
  }
  const t = TYPE_ABBREVIATIONS[field.type ?? ""];
  return t ?? field.type ?? "unknown";
}

const COMMON_FIELDS = [
  "id",
  "name",
  "display_name",
  "state",
  "active",
  "create_date",
  "write_date",
  "partner_id",
  "company_id",
  "currency_id",
  "journal_id",
  "user_id",
  "amount_total",
  "amount_untaxed",
  "amount_residual",
  "date",
  "invoice_date",
  "invoice_date_due",
  "move_type",
  "ref",
] as const;

const COMMON_INDEX = new Map<string, number>(COMMON_FIELDS.map((f, i) => [f, i]));

export function sortFieldsByPriority(fields: OdooField[]): OdooField[] {
  return [...fields].sort((a, b) => {
    const ia = COMMON_INDEX.get(a.name) ?? Infinity;
    const ib = COMMON_INDEX.get(b.name) ?? Infinity;
    if (ia !== ib) return ia - ib;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Narrow an untrusted, tool-supplied `filters` value into an Odoo search
 * domain. A domain is always an array of `[field, op, value]` tuples plus
 * `&`/`|`/`!` operators; an omitted filter means "match everything" (`[]`).
 * Reject non-array input early with a clear message instead of forwarding
 * garbage to Odoo, where it surfaces as an opaque server error. Individual
 * tuple shapes are left to Odoo to validate.
 */
function asDomain(value: unknown): OdooDomain {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("`filters` must be an array (an Odoo search domain).");
  }
  return value as OdooDomain;
}

interface CompactSchemaOptions {
  fields?: string[];
  limit: number;
  verbose: boolean;
}

interface CompactSchemaResult {
  fields: Record<string, unknown>;
  _meta: {
    total: number;
    returned: number;
    truncated: boolean;
    hint?: string;
  };
}

const DEFAULT_FIELD_LIMIT = 40;

// Issue #377: agents (and the LLMs behind them) routinely confuse Odoo's
// internal numeric primary key `id` with `default_code` (the human-readable
// SKU / internal reference). Each silent mismatch returns no results, the
// model guesses, and the downstream action lands on the wrong record. When a
// model declares both fields in its schema, surface a one-line hint next to
// each so the LLM sees the distinction at the point of decision.
const ID_DISAMBIGUATION_NOTE = "Odoo's internal numeric primary key. NOT the SKU.";
const DEFAULT_CODE_DISAMBIGUATION_NOTE =
  "Human-readable internal reference / SKU. NOT the database id.";

/**
 * Shared hint for tool descriptions whose tools accept domain filters
 * (`odoo_read`, `odoo_count`, `odoo_aggregate`). Spliced verbatim into every
 * such description so the disambiguation wording stays in lockstep across
 * tools — and so the test suite can pin its directional correctness in one
 * place (`PRODUCT_REF_DISAMBIGUATION_HINT (issue #377)` in `tools.test.ts`).
 *
 * Exported so consumer tests can assert `.toContain(constant)` without
 * re-encoding the rule, which would defeat the point.
 */
export const PRODUCT_REF_DISAMBIGUATION_HINT =
  "When the user mentions a product reference, SKU, or 'internal reference', use `default_code`, not `id`. When they reference 'the record ID' or pass a number from a URL, use `id`.";

export function compactSchema(
  allFields: OdooField[],
  opts: CompactSchemaOptions
): CompactSchemaResult {
  const sorted = sortFieldsByPriority(allFields);

  // Empty `fields: []` is treated the same as omitted — the agent didn't ask
  // for anything specific, so fall through to the default-truncate path.
  const hasFieldsFilter = Array.isArray(opts.fields) && opts.fields.length > 0;
  const wantsAll = hasFieldsFilter && opts.fields!.length === 1 && opts.fields![0] === "__all__";

  // Clamp limit: NaN / non-finite → default; negative → 0.
  const safeLimit = Number.isFinite(opts.limit)
    ? Math.max(0, Math.trunc(opts.limit))
    : DEFAULT_FIELD_LIMIT;

  let selected: OdooField[];
  let hint: string | undefined;

  if (hasFieldsFilter && !wantsAll) {
    const requested = new Set(opts.fields);
    selected = sorted.filter((f) => requested.has(f.name));
    if (selected.length === 0) {
      hint =
        "no requested fields matched this model's schema; call again without `fields` to see what is available";
    }
  } else if (wantsAll) {
    selected = sorted;
  } else {
    selected = sorted.slice(0, safeLimit);
  }

  // Detect models that *declare* both `id` and `default_code` in their full
  // schema. We deliberately check `allFields` here, not `selected`: when an
  // agent narrows the request to e.g. `fields: ["id"]` on a product, that's
  // exactly when the disambiguation matters most — the agent is about to
  // use `id` without `default_code` next to it. Scoping to the request
  // window would hide the warning in the case that needs it.
  //
  // Non-product models (`account.move`, `res.users`, ...) lack
  // `default_code`, so they never trigger the annotation. This keeps the
  // note off models that happen to share a column name with products.
  //
  // Scope reminder: this is the *describe-model* output the LLM is reading
  // right now, NOT records returned by `odoo_read` (Odoo always returns
  // `id` on records regardless of the requested field list — annotating
  // runtime records would be misplaced).
  const allFieldNames = new Set(allFields.map((f) => f.name));
  const annotateIdVsCode = allFieldNames.has("id") && allFieldNames.has("default_code");

  function noteFor(name: string): string | undefined {
    if (!annotateIdVsCode) return undefined;
    if (name === "id") return ID_DISAMBIGUATION_NOTE;
    if (name === "default_code") return DEFAULT_CODE_DISAMBIGUATION_NOTE;
    return undefined;
  }

  const out: Record<string, unknown> = {};
  for (const f of selected) {
    const note = noteFor(f.name);
    if (opts.verbose) {
      out[f.name] = {
        type: f.type,
        ...(f.type === "many2one" || f.type === "one2many" || f.type === "many2many"
          ? { relation: f.relation }
          : {}),
        ...(f.type === "selection" ? { selection: f.selection ?? [] } : {}),
        required: f.required ?? false,
        readonly: f.readonly ?? false,
        ...(f.string ? { string: f.string } : {}),
        ...(note ? { note } : {}),
      };
    } else {
      out[f.name] = note ? `${compactType(f)} — ${note}` : compactType(f);
    }
  }

  const truncated = !hasFieldsFilter && !wantsAll && sorted.length > selected.length;
  if (truncated) {
    hint =
      "default-truncated to most common fields; pass fields:['__all__'] for the full list or fields:[…] to target specific ones";
  }

  return {
    fields: out,
    _meta: {
      total: sorted.length,
      returned: selected.length,
      truncated,
      ...(hint ? { hint } : {}),
    },
  };
}

/**
 * If the LLM asked for a specific fields list AND the model has a `company_id`
 * many2one field, append `company_id` so the wrapper can surface the company
 * in `_pinchy_ref` labels. Multi-company UX hinges on the LLM being able to
 * see which company each record belongs to without having to know to ask.
 *
 * Returns the original list unchanged when:
 * - The LLM asked for all fields (`undefined`) OR an empty fields list (`[]`),
 * - The model has no `company_id` field,
 * - The LLM already included `company_id`.
 *
 * The empty-array case mirrors `compactSchema` in the same file: `fields: []`
 * is treated as "didn't ask" — Odoo then returns its default field set. If we
 * appended `company_id` to `[]` we'd silently flip the request into "only
 * company_id, please", changing behaviour vs. pre-Task-1.
 */
/**
 * Find the `company_id` many2one field on a model's field list, or undefined.
 * Single source of truth for "does this relation carry a company_id?" — used
 * by the read-side augmentation (`augmentFieldsWithCompanyId`) and the
 * write-side scoping (`searchRelationByName`, `normalizeMany2OneValues`).
 * Keeping the predicate in one place stops the write-side scoping gate from
 * drifting from the read-side notion of "has a company_id".
 */
export function findCompanyIdField(fields: OdooField[]): OdooField | undefined {
  return fields.find((f) => f.name === "company_id" && f.type === "many2one");
}

/**
 * Boolean form of {@link findCompanyIdField}: true when the model has a
 * `company_id` many2one field. Note this says nothing about whether the
 * field is REQUIRED — `res.partner` and `product.product` have an OPTIONAL
 * company_id (false = shared across companies), so "has a company_id field"
 * is NOT "company-exclusive". Scoping code must use the OR-with-false domain
 * pattern, not a strict equality, to keep shared records reachable.
 */
export function relationHasCompanyId(fields: OdooField[]): boolean {
  return findCompanyIdField(fields) !== undefined;
}

export function augmentFieldsWithCompanyId(
  requested: string[] | undefined,
  modelFields: OdooField[]
): string[] | undefined {
  if (!requested || requested.length === 0) return requested;
  if (!relationHasCompanyId(modelFields)) return requested;
  if (requested.includes("company_id")) return requested;
  return [...requested, "company_id"];
}

/**
 * Field names the plugin invents in `odoo_read` output that do not exist on
 * the underlying Odoo model — currently only `_pinchy_ref` (see
 * `wrapReadResult`). Single source of truth so the set can grow without
 * scattering string literals across every call site that strips it.
 *
 * These exist because the plugin teaches the model a vocabulary Odoo does
 * not share: the tool prompt tells it to work with `_pinchy_ref`, so it
 * inevitably asks for the field back in a later `fields`/`groupby` list, and
 * Odoo hard-errors on the unknown column (2026-07-15, agent "Piper"). Any
 * field the plugin invents on the way out has to be swallowed on the way
 * back in — teaching a name and then rejecting it is the plugin's bug, not
 * the model's.
 */
export const SYNTHETIC_FIELD_NAMES: ReadonlySet<string> = new Set(["_pinchy_ref"]);

/**
 * Remove synthetic (plugin-invented) field names from a model-supplied
 * `fields`/`groupby` list before it reaches Odoo. Entries may carry an
 * aggregation or date-granularity suffix (`odoo_aggregate`'s `field:agg` /
 * `field:month` syntax) — matched by base name, not exact string, so
 * `_pinchy_ref:count_distinct` is stripped too.
 *
 * Mirrors the `undefined`/`[]` "didn't ask" convention from
 * `augmentFieldsWithCompanyId` (empty stays empty, not "return nothing").
 * Preserves referential equality when nothing was stripped, so callers that
 * pass the result straight into `augmentFieldsWithCompanyId` don't lose that
 * function's own referential-equality guarantee for the common case.
 *
 * Deliberately separate from `augmentFieldsWithCompanyId`: that function's
 * other caller (`lookupFields`) builds its field list internally from Odoo
 * metadata and never sees model-supplied input, so it must not go through
 * this stripping.
 */
export function stripSyntheticFields<T extends string[] | undefined>(requested: T): T {
  if (!requested || requested.length === 0) return requested;
  const filtered = requested.filter((entry) => !SYNTHETIC_FIELD_NAMES.has(entry.split(":")[0]));
  return (filtered.length === requested.length ? requested : filtered) as T;
}

/**
 * `odoo_aggregate` entry point for the two model-supplied lists it forwards
 * verbatim to `readGroup`. Validates the shape (both are declared `required`
 * in the tool schema but arrive as whatever the model sent), then strips
 * synthetic names — and refuses a list that strips down to NOTHING.
 *
 * The refusal is the point: an empty `groupby` means "one global aggregate"
 * to Odoo and an empty `fields` means "counts only", so silently forwarding
 * either answers a different question than the model asked. A wrong answer
 * that looks right is worse than an error the model can act on, and
 * `_pinchy_ref` is never a legitimate thing to group by — it is per-record
 * by construction, so `id` is what the model actually wants.
 */
export function prepareAggregateFields(value: unknown, paramName: "fields" | "groupby"): string[] {
  if (!Array.isArray(value) || value.some((e) => typeof e !== "string")) {
    throw new Error(`\`${paramName}\` must be an array of field-name strings.`);
  }
  const stripped = stripSyntheticFields(value as string[]);
  if (value.length > 0 && stripped.length === 0) {
    const synthetic = [...SYNTHETIC_FIELD_NAMES].map((name) => `\`${name}\``).join(", ");
    throw new Error(
      `\`${paramName}\` contained only synthetic field names (${synthetic}), ` +
        `which do not exist on the Odoo model. Use a real column — to count ` +
        `or group per record, use \`id\`.`
    );
  }
  return stripped;
}

function getSearchReadRecords(result: unknown): OdooRecord[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (isRecord(result) && Array.isArray(result.records)) {
    return result.records.filter(isRecord);
  }
  return [];
}

export function normalizeFields(fields: unknown): OdooField[] {
  if (Array.isArray(fields)) {
    return fields.filter(isRecord).flatMap((field) => {
      if (typeof field.name !== "string") return [];
      return [
        {
          name: field.name,
          string: typeof field.string === "string" ? field.string : undefined,
          type: typeof field.type === "string" ? field.type : undefined,
          relation: typeof field.relation === "string" ? field.relation : undefined,
          selection: Array.isArray(field.selection)
            ? (field.selection as Array<[string, string]>)
            : undefined,
          readonly: typeof field.readonly === "boolean" ? field.readonly : undefined,
          required: typeof field.required === "boolean" ? field.required : undefined,
        },
      ];
    });
  }

  if (!isRecord(fields)) return [];

  return Object.entries(fields).flatMap(([name, field]) => {
    if (!isRecord(field)) return [];
    return [
      {
        name,
        string: typeof field.string === "string" ? field.string : undefined,
        type: typeof field.type === "string" ? field.type : undefined,
        relation: typeof field.relation === "string" ? field.relation : undefined,
        selection: Array.isArray(field.selection)
          ? (field.selection as Array<[string, string]>)
          : undefined,
        readonly: typeof field.readonly === "boolean" ? field.readonly : undefined,
        required: typeof field.required === "boolean" ? field.required : undefined,
      },
    ];
  });
}

/**
 * Request-scoped cache of a model's normalized field schema, keyed by model
 * name. A single `odoo_create`/`odoo_write` normalization pass resolves the
 * parent record plus every nested one2many line, and each of those resolves
 * its own many2one lookups — all of which need `fields_get`. Without a shared
 * cache, booking an N-line journal entry issued N identical `fields_get` RPCs
 * for the line model (once per recursive `normalizeMany2OneValues`) and N more
 * for each relation looked up by name (once per `searchRelationByName`). A
 * fresh cache is created per top-level normalization, so credential rotation
 * and schema changes between tool calls still take effect.
 */
type FieldsCache = Map<string, OdooField[]>;

async function loadFields(
  client: OdooClient,
  model: string,
  cache: FieldsCache
): Promise<OdooField[]> {
  const cached = cache.get(model);
  if (cached) return cached;
  const fields = normalizeFields(await client.fields(model));
  cache.set(model, fields);
  return fields;
}

function normalizeLookupText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCountryAliasKey(value: string): string {
  return normalizeLookupText(value).replace(/[\s._-]/g, "");
}

function countryCodeForInput(value: string): string | null {
  const trimmed = value.trim();
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_ALIASES_TO_CODE[normalizeCountryAliasKey(trimmed)] ?? null;
}

function recordId(record: OdooRecord): number | null {
  return typeof record.id === "number" ? record.id : null;
}

function recordText(record: OdooRecord, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function uniqueIds(records: OdooRecord[]): number[] {
  return [...new Set(records.map(recordId).filter((id): id is number => id !== null))];
}

function recordLabel(record: OdooRecord): string {
  return (
    recordText(record, "display_name") ?? recordText(record, "name") ?? String(record.id ?? "")
  );
}

/**
 * Cap on how many distinct labels we splice into a "too many matches"-style
 * error message. Five is enough for the LLM to recognize the ambiguity
 * pattern without blowing past the context window when a query lands on a
 * malformed Odoo table; the overflow suffix tells the model the list was
 * truncated. Shared between suggestion lists and multi-company breakdowns so
 * the two error shapes stay visually consistent.
 */
const MAX_DISPLAYED_LABELS = 5;

function formatSuggestions(records: OdooRecord[]): string {
  const labels = [...new Set(records.map(recordLabel).filter((label) => label.length > 0))].slice(
    0,
    MAX_DISPLAYED_LABELS
  );
  return labels.length > 0 ? ` Suggestions: ${labels.join(", ")}.` : "";
}

/**
 * Build a multi-match error that explains *why* the lookup is ambiguous when
 * the matches differ only by company. If at least two matches sit in different
 * companies, surface the breakdown so the LLM (and the user reading the chat)
 * can react with a `company_id` filter or an exact `_pinchy_ref` instead of
 * silently picking one. Falls back to the plain message when matches are
 * single-company or untagged.
 */
export function formatMultiMatchError(
  field: OdooField,
  lookup: { name?: string | null; code?: string | null },
  matches: OdooRecord[]
): string {
  const label = field.string ?? field.name;
  const input = lookup.code ?? lookup.name ?? "";
  const companies = matches
    .map((m) => extractCompanyLabel(m.company_id))
    .filter((c): c is string => Boolean(c));
  const distinctCompanies = Array.from(new Set(companies));

  if (distinctCompanies.length >= 2) {
    const shown = distinctCompanies.slice(0, MAX_DISPLAYED_LABELS);
    const overflow =
      distinctCompanies.length > shown.length
        ? ` (+${distinctCompanies.length - shown.length} more)`
        : "";
    const list = shown.map((c) => `"${c}"`).join(", ") + overflow;
    return (
      `Could not resolve ${field.name}: multiple ${label} records match "${input}" ` +
      `across companies (${list}). This is a multi-company collision. The ` +
      `simplest fix is to add \`company_id\` to the values of this create/write ` +
      `— the lookup is then scoped to that company automatically. Otherwise ` +
      `re-read the relation filtered by company and pass the exact \`_pinchy_ref\` ` +
      `of the right record (a bare \`_pinchy_ref\` string works for many2one fields).`
    );
  }
  return `Could not resolve ${field.name}: multiple ${label} records match "${input}".`;
}

function rankedSuggestions(input: string, records: OdooRecord[]): OdooRecord[] {
  const requested = normalizeLookupText(input);
  const startsWith = records.filter((record) => {
    const name = recordText(record, "name");
    const displayName = recordText(record, "display_name");
    return (
      (name !== null && normalizeLookupText(name).startsWith(requested)) ||
      (displayName !== null && normalizeLookupText(displayName).startsWith(requested))
    );
  });
  return startsWith.length > 0 ? startsWith : records;
}

function parseLookup(field: OdooField, value: unknown): RelationLookup | null {
  if (typeof value === "string") {
    const input = value.trim();
    if (input === "") return { name: "" };
    const countryCode = field.relation === "res.country" ? countryCodeForInput(input) : null;
    return countryCode ? { code: countryCode } : { name: input };
  }

  if (!isRecord(value) || !isRecord(value.lookup)) return null;
  const lookup = value.lookup;
  return {
    name: typeof lookup.name === "string" ? lookup.name.trim() : undefined,
    code: typeof lookup.code === "string" ? lookup.code.trim().toUpperCase() : undefined,
  };
}

function resolveReferenceFromRecords(
  field: OdooField,
  lookup: RelationLookup,
  records: OdooRecord[]
): number {
  const label = field.string ?? field.name;
  const input = lookup.code ?? lookup.name ?? "";

  if (field.relation === "res.country" && lookup.code) {
    const codeMatches = records.filter(
      (record) => recordText(record, "code")?.toUpperCase() === lookup.code
    );
    const ids = uniqueIds(codeMatches);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) {
      throw new Error(
        `Could not resolve ${field.name}: multiple countries match code "${lookup.code}".`
      );
    }
  }

  if (!lookup.name) {
    throw new Error(
      `Could not resolve ${field.name} from "${input}".${formatSuggestions(records)} Provide an exact ${label} name or ref.`
    );
  }

  const requested = normalizeLookupText(lookup.name);
  const exactMatches = records.filter((record) => {
    const name = recordText(record, "name");
    const displayName = recordText(record, "display_name");
    return (
      (name !== null && normalizeLookupText(name) === requested) ||
      (displayName !== null && normalizeLookupText(displayName) === requested)
    );
  });
  const ids = uniqueIds(exactMatches);
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) {
    throw new Error(formatMultiMatchError(field, lookup, exactMatches));
  }

  throw new Error(
    `Could not resolve ${field.name} from "${input}".${formatSuggestions(
      rankedSuggestions(input, records)
    )} Provide an exact ${label} name or ref.`
  );
}

/**
 * Decode an opaque integration ref and enforce per-connection isolation: the
 * integration must be `odoo` and the encoded `connectionId` must match the
 * current tenant. A ref minted for a different connection decodes validly
 * under a deployment's single ref key, so this gate is what stops a
 * cross-connection ref from being acted on. Returns the decoded payload
 * (model + id + optional company tag) so the caller can apply its own
 * model-specific checks.
 *
 * Single source of truth for the connection gate — shared by every
 * ref-consuming site: the many2one field resolver (`decodeAndValidateRef`),
 * the assignee resolver, and every `target`/`targetRef` consumer
 * (`decodeTargetRef`). A future tightening (key rotation, v2 prefix,
 * deployment scoping) lands here and reaches all of them at once.
 */
function decodeOdooRefForConnection(
  connectionId: string,
  refString: string
): IntegrationRefPayload {
  const ref = decodeRef(refString);
  if (ref.integrationType !== "odoo") {
    throw new Error("Invalid ref: expected odoo integration.");
  }
  if (ref.connectionId !== connectionId) {
    throw new Error("Invalid ref: connection does not match.");
  }
  return ref;
}

/**
 * Turn a caught decode failure into a caller-facing error, naming the
 * parameter the model actually passed so it knows which ref to re-fetch.
 *
 * A {@link MalformedIntegrationRefError} means the string never decoded at
 * all. The model garbling a long base64url token is the common cause, but a
 * rotated `PINCHY_REF_TOKEN_KEY` is indistinguishable from here — every ref
 * minted under the old key fails the same auth-tag check. So the message
 * names the remedy (re-fetch, which is correct either way) and claims
 * nothing about the cause. Anything else already carries a specific message
 * and passes through untouched.
 */
function refDecodeError(err: unknown, paramName: string): Error {
  if (err instanceof MalformedIntegrationRefError) {
    return new Error(
      `\`${paramName}\` ref could not be decoded — it looks corrupted or ` +
        `truncated. Re-fetch the record with \`odoo_read\` and pass the ` +
        `fresh \`_pinchy_ref\` exactly as returned.`
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Decode a `target`/`targetRef` for a tool that acts on an arbitrary target
 * model (schedule/complete/reschedule activity, record-action tools,
 * attach_file). Returns the payload on success, or throws a descriptive
 * error otherwise. No model check: these tools accept any target model and
 * gate it through the permissions map instead.
 *
 * The two failure causes must stay distinguishable: `decodeRef` throws a
 * typed {@link MalformedIntegrationRefError} for "this string doesn't decode
 * at all", while `decodeOdooRefForConnection` throws a plain `Error` for
 * "decoded fine, but wrong integration type or connectionId". Both share the
 * generic "Invalid integration reference" text, so `instanceof` — not string
 * matching — is what tells them apart. Collapsing them again sends a garbled
 * ref down a connection-config trail; that is the 2026-07-15 prod incident
 * the `odoo_schedule_activity` "Cause 1 / Cause 2" tests pin.
 */
function decodeTargetRef(
  connectionId: string,
  refString: string,
  paramName = "target"
): IntegrationRefPayload {
  try {
    return decodeOdooRefForConnection(connectionId, refString);
  } catch (err) {
    if (err instanceof MalformedIntegrationRefError) {
      throw refDecodeError(err, paramName);
    }
    throw new Error(`\`${paramName}\` ref does not belong to this Odoo connection.`);
  }
}

/**
 * Decode an opaque integration ref string and validate it against the field
 * being written: the connection gate runs via {@link decodeOdooRefForConnection},
 * and the encoded model must equal the field's relation (prevents a
 * `res.partner` ref from being written into a `journal_id` / `account.journal`
 * field). Returns the decoded record id on success, throws a descriptive
 * error otherwise.
 *
 * Shared by the two many2one ref entry points: the `{ ref: "…" }` object form
 * (`refToId`) and the bare `_pinchy_ref` string form accepted by
 * `resolveRelationValue`. Both forms carry the same encoded payload, so
 * both get the same validation — accepting the bare string loses no safety
 * versus the object form.
 */
function decodeAndValidateRef(connectionId: string, field: OdooField, refString: string): number {
  let ref: IntegrationRefPayload;
  try {
    ref = decodeOdooRefForConnection(connectionId, refString);
  } catch (err) {
    throw refDecodeError(err, field.name);
  }
  if (ref.model !== field.relation) {
    throw new Error(`Invalid ref for ${field.name}: expected ${field.relation}, got ${ref.model}.`);
  }
  return ref.id;
}

function refToId(
  connectionId: string,
  field: OdooField,
  value: Record<string, unknown>
): number | null {
  // Accept BOTH wire shapes: the m2o wrapper's `{ ref }` (wrapMany2OneValue)
  // and the one2many wrapper's `{ _pinchy_ref }` (wrapOne2ManyValue). Without
  // this an agent pasting a whole read-emitted o2m line object — or the
  // read `line_ids` array verbatim — into a Command tuple id position would
  // hit the "Raw numeric IDs are not accepted" guard below, because only the
  // bare string decoded, not the object carrying it.
  const refString =
    typeof value.ref === "string"
      ? value.ref
      : typeof value._pinchy_ref === "string"
        ? value._pinchy_ref
        : null;
  if (refString === null) return null;
  return decodeAndValidateRef(connectionId, field, refString);
}

/**
 * Guard against cross-company writes. When the `values` map contains a
 * `company_id` ref AND other m2o refs that carry a `companyId` tag, every
 * tagged ref must point to the same company. Untagged refs (legacy or
 * company-shared models like `res.partner`, `res.country`) pass through.
 * We never fetch Odoo for this check — only the encrypted tag in the ref
 * is consulted, so the cost is zero.
 *
 * Throws when a tagged sibling disagrees on company. The caller's try/catch
 * converts the throw into the standard `{ isError: true }` shape.
 *
 * Audit visibility: the throw propagates to `errorResult`, which sets
 * `isError: true` on the tool response. `pinchy-audit`'s `after_tool_call`
 * hook captures the full result + error on every tool call, so cross-company
 * rejections already land in `audit_log` as a failed `tool.odoo_create` /
 * `tool.odoo_write` entry with the literal "Cross-company write rejected"
 * prefix in `detail`. Admins can grep / filter for that string — no separate
 * audit pipeline is needed here.
 *
 * Scope: top-level fields of `values` AND nested one2many/many2many command
 * tuples (e.g. `line_ids: [[0, 0, { account_id: <ref> }]]`) are inspected.
 * A line-level ref whose company tag disagrees with the parent's (or its
 * own line-level `company_id`, when the line declares one) is rejected with
 * the same "Cross-company write rejected" prefix and a path like
 * `line_ids[0].account_id`. Odoo's server-side `company_id` constraint
 * remains the ultimate authority.
 */
export function assertNoCrossCompanyRefs(values: Record<string, unknown>): void {
  const intended = readRefCompanyTag(values.company_id);
  if (intended === null) return;
  const intendedLabel = intended.label ?? `id=${intended.id}`;

  for (const [field, value] of Object.entries(values)) {
    if (field === "company_id") continue;
    assertNoCrossCompanyValue(value, intended, intendedLabel, field, 0);
  }
}

// Depth cap for the cross-company guard's tuple recursion — a defensive
// bound against a pathologically deep/self-referential nested structure,
// mirroring the bound `normalizeMany2OneValues` already applies to its own
// nested walk (one level today). Generous enough for any real Odoo o2m/m2m
// nesting while still stopping unbounded recursion.
const MAX_CROSS_COMPANY_DEPTH = 8;

/**
 * Recursive companion to {@link assertNoCrossCompanyRefs}. Checks a single
 * value: if it carries a company-tagged ref, compare against `intended`;
 * if it is a one2many/many2many command-tuple array, descend into the
 * create (0) and update (1) tuples' values dicts and check each field.
 * `path` is threaded for actionable error messages (e.g.
 * `line_ids[0].account_id`).
 */
function assertNoCrossCompanyValue(
  value: unknown,
  intended: { id: number; label: string | null },
  intendedLabel: string,
  path: string,
  depth: number
): void {
  if (depth >= MAX_CROSS_COMPANY_DEPTH) return;
  const sibling = readRefCompanyTag(value);
  if (sibling !== null) {
    if (sibling.id !== intended.id) {
      const otherLabel = sibling.label ?? `id=${sibling.id}`;
      throw new Error(
        `Cross-company write rejected: values.company_id points to "${intendedLabel}" ` +
          `but values.${path} points to a record in "${otherLabel}". ` +
          `Re-resolve ${path} in the right company first.`
      );
    }
    return;
  }
  if (!Array.isArray(value)) return;
  value.forEach((tuple, i) => {
    if (!Array.isArray(tuple)) return;
    // Odoo Command tuple: [code, ...]. 0 (create) and 1 (update) carry a
    // values dict at index 2 with refs to check.
    if ((tuple[0] === 0 || tuple[0] === 1) && isRecord(tuple[2])) {
      const lineDict = tuple[2] as Record<string, unknown>;
      // A line may declare its OWN company_id; normalizeMany2OneValues
      // re-scopes that line's m2o lookups to it, so the guard must use the
      // SAME baseline or it false-rejects a self-consistent line. Fall back
      // to the parent's company when the line declares none.
      const lineTag = readRefCompanyTag(lineDict.company_id);
      const lineIntended = lineTag ?? intended;
      const lineIntendedLabel = lineTag ? (lineTag.label ?? `id=${lineTag.id}`) : intendedLabel;
      for (const [k, v] of Object.entries(lineDict)) {
        if (k === "company_id") continue; // the scoping anchor itself
        assertNoCrossCompanyValue(
          v,
          lineIntended,
          lineIntendedLabel,
          `${path}[${i}].${k}`,
          depth + 1
        );
      }
    }
    // Codes 1 (update), 2 (delete), 3 (unlink), 4 (link) all carry a
    // company-taggable id at tuple[1]. (0 has no id; 6 is handled below.)
    if (tuple[0] === 1 || tuple[0] === 2 || tuple[0] === 3 || tuple[0] === 4) {
      assertNoCrossCompanyValue(tuple[1], intended, intendedLabel, `${path}[${i}]`, depth + 1);
    }
    // replace (6, 0, [ids]) — check every id in the replacement list.
    if (tuple[0] === 6 && Array.isArray(tuple[2])) {
      (tuple[2] as unknown[]).forEach((id, j) => {
        assertNoCrossCompanyValue(id, intended, intendedLabel, `${path}[${i}][${j}]`, depth + 1);
      });
    }
  });
}

/**
 * Validate `selection`-type field values in `values` against the model's field
 * schema. An Odoo selection field only accepts its declared option keys; an
 * out-of-set value is a silent footgun:
 *   - on create/write Odoo rejects it with an opaque server error;
 *   - in a read/count DOMAIN it matches nothing, so the agent wrongly concludes
 *     the record doesn't exist and books a DUPLICATE — the staging incident:
 *     it searched account.move with move_type="in_bill" (not a valid move_type;
 *     vendor bills are "in_invoice"), found nothing, then created move_id 40
 *     duplicating move_id 39.
 *
 * Returns the offending entries with the valid option keys so the caller can
 * throw a helpful error naming the enum instead of forwarding a bad value.
 * Skips fields with an empty/dynamic selection set (can't validate) and
 * non-primitive values (relational command tuples, refs).
 */
export function findInvalidSelectionValues(
  fields: OdooField[],
  values: Record<string, unknown>
): Array<{ field: string; value: string; validValues: string[] }> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const invalid: Array<{ field: string; value: string; validValues: string[] }> = [];
  for (const [name, raw] of Object.entries(values)) {
    const field = byName.get(name);
    if (!field || field.type !== "selection") continue;
    const options = field.selection ?? [];
    if (options.length === 0) continue;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const value = String(raw);
    const validValues = options.map(([optValue]) => optValue);
    if (!validValues.includes(value)) invalid.push({ field: name, value, validValues });
  }
  return invalid;
}

/** Human-readable error for invalid selection values, listing the valid keys. */
export function formatInvalidSelectionError(
  model: string,
  invalid: Array<{ field: string; value: string; validValues: string[] }>
): string {
  return invalid
    .map(
      (e) =>
        `Invalid value "${e.value}" for ${model}.${e.field}. ` +
        `Valid values: ${e.validValues.join(", ")}.`
    )
    .join(" ");
}

/**
 * Decode the company tag (id + label) from a `{ ref }` shape in one pass.
 * Returns null when the value is not a tagged ref, when decoding fails, or
 * when the payload lacks a `companyId` tag (legacy / untagged refs). The
 * label may still be null even when the id is present, mirroring the
 * encoder's tolerance of partial tags on the read side.
 */
function readRefCompanyTag(value: unknown): { id: number; label: string | null } | null {
  // Accept the ref in any wire form the agent may pass: the m2o wrapper's
  // `{ ref: "…" }` object, the one2many wrapper's `{ _pinchy_ref: "…" }`
  // object (so a pasted whole o2m line object is visible to this guard too),
  // OR a bare `_pinchy_ref` string (the form odoo_read emits and the prose
  // tells the agent to copy verbatim). Without the bare-string branch,
  // Layer 1's bare-ref support would let a bare ref slip past the
  // cross-company guard entirely.
  const refString = isRecord(value)
    ? typeof value.ref === "string"
      ? value.ref
      : typeof value._pinchy_ref === "string"
        ? value._pinchy_ref
        : null
    : isIntegrationRef(value)
      ? value
      : null;
  if (refString === null) return null;
  try {
    const payload = decodeRef(refString);
    if (payload.companyId === undefined) return null;
    return { id: payload.companyId, label: payload.companyLabel ?? null };
  } catch {
    return null;
  }
}

/**
 * Run the `name ilike` lookup on `field.relation`, requesting `company_id`
 * only when the relation actually has it. Models like `res.currency`,
 * `res.country`, `res.lang`, or `res.company` itself lack `company_id` —
 * asking for it makes Odoo throw "Invalid field 'company_id' on model …".
 *
 * The gating mirrors `augmentFieldsWithCompanyId`, which is also used by
 * `odoo_read` to keep multi-company UX consistent. One extra `client.fields`
 * call per non-country lookup is the cost.
 *
 * When `scopeCompanyId` is set (because the parent record's `company_id` was
 * resolvable), constrain the search to that company. Odoo journal codes/names
 * are unique per-company, not globally — without this scope, a name/code that
 * exists in two companies returns multiple matches and the create fails with
 * a multi-company collision. Scoping to the record's company is Odoo's own
 * fix pattern (PR #269835 / commit 3fcd8a9). Only applied when the relation
 * actually has a `company_id` field, so company-shared models (res.currency,
 * res.partner, res.country) are never scoped.
 */
async function searchRelationByName(
  client: OdooClient,
  field: OdooField,
  lookup: RelationLookup,
  scopeCompanyId: number | null = null,
  fieldsCache: FieldsCache = new Map()
): Promise<unknown> {
  const relation = field.relation as string;
  const relationFields = await loadFields(client, relation, fieldsCache);
  const lookupFields = augmentFieldsWithCompanyId(
    ["id", "name", "display_name"],
    relationFields
  ) ?? ["id", "name", "display_name"];
  const domain: OdooDomain = [["name", "ilike", lookup.name ?? ""]];
  if (scopeCompanyId !== null && relationHasCompanyId(relationFields)) {
    // Mirror Odoo's `_check_company_domain`: include SHARED records
    // (company_id = false), not just the target company. A strict
    // `("company_id", "=", scope)` filter would exclude shared partners and
    // products (company_id false, visible across companies) and break name
    // lookups that resolved before. For company-EXCLUSIVE relations
    // (account.journal, where company_id is required) the false branch
    // never matches, so this is equivalent to the strict filter there.
    domain.push("|", ["company_id", "=", false], ["company_id", "=", scopeCompanyId]);
  }
  return client.searchRead(relation, domain, {
    fields: lookupFields,
    limit: 20,
  });
}

async function resolveRelationValue(
  client: OdooClient,
  connectionId: string,
  field: OdooField,
  value: unknown,
  scopeCompanyId: number | null = null,
  fieldsCache: FieldsCache = new Map()
): Promise<unknown> {
  if (value == null || value === false) return value;
  if (typeof value === "number") {
    throw new Error(
      `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`
    );
  }
  if (Array.isArray(value) && typeof value[0] === "number") {
    throw new Error(
      `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`
    );
  }
  if (isRecord(value)) {
    const refId = refToId(connectionId, field, value);
    if (refId !== null) return refId;
    if (typeof value.id === "number") {
      throw new Error(
        `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`
      );
    }
  }

  // Bare `_pinchy_ref` string — the exact form `odoo_read` / `odoo_create`
  // emit and the tool prose tells the agent to "pass verbatim". Without this
  // branch the string would fall through to `parseLookup` and be treated as a
  // display-name search, which never matches a `pinchy_ref:v1:…` token and
  // reports a misleading "Could not resolve". Decoding here gives the agent
  // the unambiguous escape hatch the design promises — and, because the ref
  // encodes the exact record (incl. company tag), it sidesteps multi-company
  // name/code collisions entirely. Validation is shared with the `{ref}`
  // object form via `decodeAndValidateRef`, so no safety is lost.
  if (isIntegrationRef(value)) {
    return decodeAndValidateRef(connectionId, field, value);
  }

  const lookup = parseLookup(field, value);
  if (!lookup) return value;
  if (lookup.name === "") return false;
  if (lookup.name && /^\d+$/.test(lookup.name)) {
    throw new Error(
      `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`
    );
  }
  if (!field.relation) return value;

  const result =
    field.relation === "res.country"
      ? await client.searchRead(field.relation, [], {
          fields: ["id", "name", "display_name", "code"],
          limit: 1000,
        })
      : await searchRelationByName(client, field, lookup, scopeCompanyId, fieldsCache);

  return resolveReferenceFromRecords(field, lookup, getSearchReadRecords(result));
}

export async function normalizeMany2OneValues(
  client: OdooClient,
  connectionId: string,
  model: string,
  values: Record<string, unknown>,
  permissions: Permissions,
  depth = 0,
  inheritedScope: number | null = null,
  fieldsCache: FieldsCache = new Map()
): Promise<{ values: Record<string, unknown>; fields: OdooField[] }> {
  const fields = await loadFields(client, model, fieldsCache);
  if (fields.length === 0) return { values, fields };

  const normalized = { ...values };

  // Resolve `company_id` first so that company-scoped m2o lookups later in the
  // loop (e.g. `journal_id`, where two companies can share a journal name/code)
  // can be constrained to the target company — Odoo's own fix pattern for
  // multi-company collisions (PR #269835 / commit 3fcd8a9). `res.company`
  // itself has no `company_id` field, so this never recurses. When company_id
  // is absent, false, or doesn't resolve to a positive integer, fall back to
  // the `inheritedScope` (the parent record's company, for nested one2many
  // command tuples whose lines belong to the same company but don't restate
  // company_id — #615); when that is also null, no scoping is applied and
  // subsequent lookups behave exactly as before.
  let scopeCompanyId: number | null = inheritedScope;
  const companyField = findCompanyIdField(fields);
  if (companyField && "company_id" in normalized) {
    const resolved = await resolveRelationValue(
      client,
      connectionId,
      companyField,
      normalized.company_id,
      null,
      fieldsCache
    );
    normalized.company_id = resolved;
    if (typeof resolved === "number" && Number.isInteger(resolved) && resolved > 0) {
      scopeCompanyId = resolved;
    }
  }

  for (const field of fields) {
    if (field.type !== "many2one" || !(field.name in normalized)) continue;
    if (field.name === "company_id") continue; // already resolved above
    normalized[field.name] = await resolveRelationValue(
      client,
      connectionId,
      field,
      normalized[field.name],
      scopeCompanyId,
      fieldsCache
    );
  }

  // One nesting level down (#615; many2many follow-up): resolve m2o fields
  // inside one2many AND many2many command tuples (e.g. account.move
  // `line_ids: [[0, 0, { account_id: "…" }]]`, or a many2many `tax_ids: [[4,
  // "…"]]`). The nested m2o values get the same ref decoding + company
  // scoping as top-level fields, inheriting the parent's `scopeCompanyId`
  // (the lines belong to the same company). Bounded to depth 1 — Odoo's
  // command tuples can nest arbitrarily, but one level covers the
  // account.move line_ids case; deeper nesting is left to a future change to
  // avoid unbounded recursion through self-referential models.
  if (depth < 1) {
    for (const field of fields) {
      const kind =
        field.type === "one2many" ? "one2many" : field.type === "many2many" ? "many2many" : null;
      if (kind === null || !field.relation) continue;
      if (!(field.name in normalized)) continue;
      const commands = normalized[field.name];
      if (!Array.isArray(commands)) continue;
      normalized[field.name] = await normalizeCommandTuples(
        client,
        connectionId,
        field,
        commands,
        scopeCompanyId,
        permissions,
        depth,
        fieldsCache,
        kind
      );
    }
  }

  return { values: normalized, fields };
}

// Odoo Command codes on a one2many that modify EXISTING nested records and
// therefore require a grant on the line model. Inline create (0) is part of
// the parent's atomic create — already gated by the top-level `create`
// check — so it needs no separate line-model grant. Link (4) only rewires
// the parent's relation set and creates/destroys nothing. Clear (5) and
// replace (6), however, are bulk forms of unlink (3): for a one2many with a
// REQUIRED inverse many2one (e.g. account.move.line.move_id), Odoo deletes
// every orphaned child record when the relation set is cleared or replaced
// (Odoo "[FIX] fields: setting a one2many field deletes all its lines"
// #13082). They are therefore gated exactly like 2/3 — an agent needs the
// `delete` grant on the line model to clear or replace a one2many, not just
// `write` on the parent.
const NESTED_OP_BY_CODE: Record<number, "write" | "delete"> = {
  1: "write",
  2: "delete",
  3: "delete",
  5: "delete",
  6: "delete",
};

// many2many Command permission map. Unlike one2many, m2m is a join table
// with no required inverse — clearing or replacing the set never
// cascade-deletes target rows, it only rewires the join table. So only the
// codes that actually create/write/delete a TARGET record need a grant: 0
// create needs `create` on the target (relation) model, 1 update needs
// `write`, 2 delete needs `delete`. Codes 3 (unlink), 4 (link), 5 (clear), 6
// (replace) only rewire the join table and need no grant (contrast with
// `NESTED_OP_BY_CODE`, where o2m codes 2/3/5/6 all need `delete` because
// Odoo cascade-deletes orphaned children — see the comment above that map).
const M2M_OP_BY_CODE: Record<number, "create" | "write" | "delete"> = {
  0: "create",
  1: "write",
  2: "delete",
};

/**
 * Resolve a Command tuple's id position (tuple[1], or an element of the
 * code-6 id list). Raw numeric ids — the standard Odoo wire format used by
 * every pre-existing caller — pass straight through unchanged; `false`/`null`
 * (code 6's "clear" id slot) also pass through. Only a ref-shaped value
 * (`_pinchy_ref` bare string, `{ref}` object, or a name/code lookup string)
 * is resolved via `resolveRelationValue`, so a line ref captured by
 * `odoo_read` can be pasted back into an edit tuple's id position.
 */
async function resolveCommandTargetId(
  client: OdooClient,
  connectionId: string,
  relationField: OdooField,
  idValue: unknown,
  scopeCompanyId: number | null,
  fieldsCache: FieldsCache
): Promise<unknown> {
  if (typeof idValue === "number") return idValue;
  if (idValue === false || idValue == null) return idValue;
  return resolveRelationValue(
    client,
    connectionId,
    relationField,
    idValue,
    scopeCompanyId,
    fieldsCache
  );
}

/**
 * A single value is "ref-shaped" when it needs decoding before it can reach
 * Odoo: a bare `_pinchy_ref` string, or a `{ref}`/`{_pinchy_ref}` object.
 * Used by {@link commandTuplesNeedResolution} to decide whether an empty
 * line schema is actually a problem for a given set of tuples.
 */
function isRefShaped(value: unknown): boolean {
  if (isIntegrationRef(value)) return true;
  return (
    isRecord(value) && (typeof value.ref === "string" || typeof value._pinchy_ref === "string")
  );
}

/**
 * True when at least one command tuple in `tuples` actually needs relation
 * resolution: a code-0/1 values dict containing a ref-shaped value, or an id
 * position (tuple[1], or an element of a code-6 id list) that is neither a
 * raw number nor `false`/`null` (Odoo's own wire shapes, which never need
 * resolution). Pure raw-id tuples such as `[6, 0, [1, 2, 3]]` return false
 * here — they carry nothing for the line schema to resolve against, so an
 * empty/unavailable line schema is harmless for them.
 */
function commandTuplesNeedResolution(tuples: unknown[]): boolean {
  const idNeedsResolution = (id: unknown): boolean =>
    typeof id !== "number" && id !== false && id != null;
  return tuples.some((tuple) => {
    if (!Array.isArray(tuple)) return false;
    const code = tuple[0];
    if ((code === 0 || code === 1) && isRecord(tuple[2])) {
      if (Object.values(tuple[2]).some(isRefShaped)) return true;
    }
    if (code === 6 && Array.isArray(tuple[2])) {
      return (tuple[2] as unknown[]).some(idNeedsResolution);
    }
    return idNeedsResolution(tuple[1]);
  });
}

/**
 * Unified walker for one2many AND many2many Command tuples. Only the create
 * (`[0, 0, {values}]`) and update (`[1, id, {values}]`) commands carry a
 * value dict whose m2o fields get resolved recursively via
 * `normalizeMany2OneValues` at depth+1, inheriting the parent's
 * `scopeCompanyId`. Every code's id position(s) — `tuple[1]` for codes
 * 1-4, each element of code 6's id list — is ref-decoded via
 * `resolveCommandTargetId` so a ref captured by `odoo_read` can be pasted
 * back into an edit. `[5]` clear carries no id at all and passes through
 * unchanged.
 *
 * Governance: before doing any ref work for a tuple, the command's op code
 * is checked against `NESTED_OP_BY_CODE` (one2many) or `M2M_OP_BY_CODE`
 * (many2many) — see the doc comments above those maps for which codes need
 * which grant, and why the two relation kinds differ.
 */
async function normalizeCommandTuples(
  client: OdooClient,
  connectionId: string,
  relationField: OdooField,
  commands: unknown[],
  scopeCompanyId: number | null,
  permissions: Permissions,
  depth: number,
  fieldsCache: FieldsCache,
  kind: "one2many" | "many2many"
): Promise<unknown[]> {
  const relationModel = relationField.relation as string;
  const opByCode = kind === "one2many" ? NESTED_OP_BY_CODE : M2M_OP_BY_CODE;

  // Governance first: check every tuple's op against the allowlist BEFORE any
  // I/O (schema fetch) or ref resolution. A missing grant is the agent's to
  // fix and must surface as a permission error even when the line schema also
  // happens to be unavailable — and it lets an under-permissioned request fail
  // fast without a schema round trip.
  for (const cmd of commands) {
    if (!Array.isArray(cmd) || typeof cmd[0] !== "number") continue;
    const op = opByCode[cmd[0]];
    if (op !== undefined && !checkPermission(permissions, relationModel, op)) {
      // Pinchy-allowlist rejection (not an Odoo server AccessError): phrase
      // it as a permission gap, not an Odoo-side sync issue.
      throw new Error(
        `Agent missing ${op} grant on ${relationModel} ` +
          `(nested via ${relationField.name} command ${cmd[0]}). ` +
          `Add ${op} on ${relationModel} to this agent's permissions.`
      );
    }
  }

  // An empty line schema means the nested m2o resolution inside
  // `normalizeMany2OneValues` has nothing to resolve against and would
  // otherwise silently return the values dict UNCHANGED (Hardening B). When
  // the tuples carry only raw ids (no ref-shaped value anywhere), that's
  // fine — Odoo's own wire format expects raw ids and there's nothing to
  // resolve. But if resolution IS needed, silently no-op-ing here would let
  // a bare ref reach Odoo undecoded — fail loud instead.
  const lineFields = await loadFields(client, relationModel, fieldsCache);
  if (lineFields.length === 0 && commandTuplesNeedResolution(commands)) {
    throw new Error(
      `Cannot resolve references in "${relationField.name}" (relation "${relationModel}"): ` +
        `the schema for ${relationModel} came back empty, so many2one refs in its ` +
        `command tuples cannot be decoded. Re-check the connection to Odoo and try again.`
    );
  }

  const out: unknown[] = [];
  for (const cmd of commands) {
    if (!Array.isArray(cmd) || typeof cmd[0] !== "number") {
      out.push(cmd);
      continue;
    }
    const code = cmd[0];

    if ((code === 0 || code === 1) && isRecord(cmd[2])) {
      const resolvedValues = (
        await normalizeMany2OneValues(
          client,
          connectionId,
          relationModel,
          cmd[2],
          permissions,
          depth + 1,
          scopeCompanyId,
          fieldsCache
        )
      ).values;
      const resolvedId =
        code === 1
          ? await resolveCommandTargetId(
              client,
              connectionId,
              relationField,
              cmd[1],
              scopeCompanyId,
              fieldsCache
            )
          : cmd[1];
      out.push([code, resolvedId, resolvedValues]);
    } else if ((code === 2 || code === 3 || code === 4) && cmd.length >= 2) {
      const resolvedId = await resolveCommandTargetId(
        client,
        connectionId,
        relationField,
        cmd[1],
        scopeCompanyId,
        fieldsCache
      );
      out.push([code, resolvedId, ...cmd.slice(2)]);
    } else if (code === 6 && Array.isArray(cmd[2])) {
      const resolvedIds = await Promise.all(
        (cmd[2] as unknown[]).map((id) =>
          resolveCommandTargetId(
            client,
            connectionId,
            relationField,
            id,
            scopeCompanyId,
            fieldsCache
          )
        )
      );
      out.push([code, cmd[1], resolvedIds]);
    } else {
      out.push(cmd);
    }
  }
  return out;
}

// The canonical Odoo external id for the built-in "To-Do" activity type.
// Resolving the type through ir.model.data keeps the default locale-
// independent — `mail.activity.type.name` is translated ("To-Do" vs
// "Zu erledigen"), the xmlid is not.
const TODO_ACTIVITY_XMLID = { module: "mail", name: "mail_activity_data_todo" };

/**
 * Resolve the ir.model database id for a technical model name
 * (e.g. "crm.lead" → 5). `mail.activity` links to its document through the
 * required `res_model_id` FK to ir.model — NOT the readonly related
 * `res_model` char. Writing `res_model` is silently dropped by Odoo, which
 * leaves the activity's `res_id` reference dangling and trips the
 * `res_id IS NOT NULL AND res_id != 0` SQL CHECK. ir.model is world-readable
 * for internal users, so this lookup needs no extra model grant.
 */
async function resolveIrModelId(client: OdooClient, technicalModel: string): Promise<number> {
  const result = await client.searchRead("ir.model", [["model", "=", technicalModel]], {
    fields: ["id"],
    limit: 1,
  });
  const record = getSearchReadRecords(result)[0];
  const id = record ? recordId(record) : null;
  if (id === null) {
    throw new Error(
      `Could not resolve the Odoo model "${technicalModel}" — no ir.model row found.`
    );
  }
  return id;
}

/**
 * Resolve the default "To-Do" activity type id via its xmlid. Returns null
 * (rather than throwing) when ir.model.data is unreadable or the xmlid is
 * absent, so the caller can fall back to Odoo's own default activity type.
 */
async function resolveDefaultActivityTypeId(client: OdooClient): Promise<number | null> {
  try {
    const result = await client.searchRead(
      "ir.model.data",
      [
        ["module", "=", TODO_ACTIVITY_XMLID.module],
        ["name", "=", TODO_ACTIVITY_XMLID.name],
      ],
      { fields: ["res_id"], limit: 1 }
    );
    const record = getSearchReadRecords(result)[0];
    return record && typeof record.res_id === "number" ? record.res_id : null;
  } catch {
    return null;
  }
}

/** Resolve an activity type id from its exact (untranslated) name. */
async function resolveActivityTypeByName(client: OdooClient, name: string): Promise<number> {
  const result = await client.searchRead("mail.activity.type", [["name", "=", name]], {
    fields: ["id"],
    limit: 1,
  });
  const record = getSearchReadRecords(result)[0];
  const id = record ? recordId(record) : null;
  if (id === null) {
    throw new Error(
      `Could not resolve activity type "${name}". Use an exact activity type name (e.g. "To-Do", "Call", "Email").`
    );
  }
  return id;
}

/**
 * Resolve an `assignee` to a res.users id. Accepts an opaque res.users ref
 * (`pinchy_ref:…`) or an exact user name. Throws a clear error on an
 * ambiguous name or a ref that does not point at res.users.
 */
async function resolveAssigneeUserId(
  client: OdooClient,
  connectionId: string,
  assignee: string
): Promise<number> {
  if (isIntegrationRef(assignee)) {
    let ref: IntegrationRefPayload;
    try {
      ref = decodeOdooRefForConnection(connectionId, assignee);
    } catch (err) {
      throw refDecodeError(err, "assignee");
    }
    if (ref.model !== "res.users") {
      throw new Error("`assignee` ref must point to a res.users record.");
    }
    return ref.id;
  }
  const result = await client.searchRead("res.users", [["name", "=", assignee]], {
    fields: ["id"],
    limit: 2,
  });
  const ids = uniqueIds(getSearchReadRecords(result));
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw new Error(`Could not resolve assignee "${assignee}" — no matching user.`);
  }
  throw new Error(
    `Could not resolve assignee "${assignee}" — multiple users match; pass an opaque res.users ref instead.`
  );
}

/**
 * Best-effort lookup of a target record's salesperson (`user_id`) so a
 * scheduled activity lands in the right person's "My Activities" list.
 * Returns null when the model has no `user_id` field or none is set —
 * Odoo then assigns the activity to its creator.
 */
async function resolveTargetSalespersonId(
  client: OdooClient,
  targetModel: string,
  targetId: number
): Promise<number | null> {
  try {
    const result = await client.searchRead(targetModel, [["id", "=", targetId]], {
      fields: ["user_id"],
      limit: 1,
    });
    const record = getSearchReadRecords(result)[0];
    const userId = record?.user_id;
    return Array.isArray(userId) && typeof userId[0] === "number" ? userId[0] : null;
  } catch {
    return null;
  }
}

/**
 * Legacy-path safety net for direct `mail.activity` creation. Agent
 * instructions written before `odoo_schedule_activity` existed tell the model
 * to write `res_model` (a string) — but `res_model` is a readonly related
 * field of the required `res_model_id` FK, so Odoo drops the write and the
 * create fails the `res_id` CHECK. When we see that shape, resolve
 * `res_model_id` from the technical name and drop the inert `res_model`.
 * Production agents carry a frozen AGENTS.md, so this keeps them working
 * without a manual re-align. Runs AFTER many2one normalization, so the
 * injected integer id reaches Odoo verbatim (the "raw numeric IDs" guard
 * only inspects agent-supplied values, never this resolved one).
 */
async function ensureActivityResModelId(
  client: OdooClient,
  model: string,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (model !== "mail.activity") return values;
  if (values.res_model_id != null) return values;
  if (typeof values.res_model !== "string" || values.res_model.length === 0) {
    return values;
  }
  const irModelId = await resolveIrModelId(client, values.res_model);
  const next: Record<string, unknown> = { ...values, res_model_id: irModelId };
  delete next.res_model;
  return next;
}

/** Id of an Odoo many2one value, which comes back as `[id, label]` or `false`. */
export function relationId(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const id = value[0];
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/** Label of an Odoo many2one value. */
export function relationLabel(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return typeof value[1] === "string" ? value[1] : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Accounts a bill/invoice settles against, matched via
 * `account.move.line.account_type` (a related field on the line, so no join is
 * needed). Reconciliation only ever happens on these: Odoo refuses lines from
 * two different accounts outright ("Entries are not from the same account"),
 * which is why a bank transaction sitting on the journal's *suspense* account
 * can never be reconciled against a bill's payable line directly — the suspense
 * line has to be replaced first.
 */
const SETTLEMENT_ACCOUNT_TYPES = ["asset_receivable", "liability_payable"];

/**
 * Did the reconcile actually happen?
 *
 * This is the crux of the tool, and it is deliberately paranoid. Verified
 * against a real Odoo 19 instance (2026-07-16):
 *
 *  1. `account.move.line.reconcile()` returns `None` — on success AND on a
 *     silent no-op. Over RPC that is `undefined`. The return value carries no
 *     information at all.
 *  2. Odoo 19 dropped the "you can only reconcile posted entries" guard. A
 *     reconcile touching a draft line raises nothing, writes no
 *     `account.partial.reconcile`, and changes nothing. Silence is not success.
 *  3. `account.bank.statement.line.is_reconciled` is NOT a valid signal: it is
 *     computed as "no suspense line left on the move", so merely restating the
 *     counterpart (step 1 of the bank flow) already flips it to `true` while
 *     the bill stays unpaid.
 *
 * The only trustworthy evidence is the settled document's own residual going
 * down. That is what we check.
 */
export function didReconcile(residualBefore: unknown, residualAfter: unknown): boolean {
  const before = asNumber(residualBefore);
  const after = asNumber(residualAfter);
  if (before === null || after === null) return false;
  // Residuals are signed and rounded by Odoo; compare magnitudes with a
  // cent-level tolerance so a float artefact cannot read as progress.
  return Math.abs(after) < Math.abs(before) - 0.005;
}

/**
 * Variant A wizard handling for record-action tools. Odoo button/action
 * methods (e.g. `stock.picking.button_validate`, `mrp.production.button_mark_done`)
 * return `True` when they finish cleanly, but return an `ir.actions.act_window`
 * dict when Odoo needs a human decision first — a backorder, an
 * immediate-transfer confirmation, a consumption warning. We never claim the
 * operation succeeded in that case; we surface the pending wizard's model so
 * the caller can tell the user to finish it in Odoo. Returns the wizard's
 * `res_model` (or a generic label) when the result is such an action, else null.
 */
export function describePendingWizard(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const type = result.type;
  if (typeof type === "string" && type.startsWith("ir.actions")) {
    return typeof result.res_model === "string" && result.res_model.length > 0
      ? result.res_model
      : "a follow-up confirmation step";
  }
  return null;
}

/**
 * Allow-list of approval-style state transitions reachable through
 * `odoo_set_approval`. Each model maps a decision to the exact Odoo method.
 * This IS the governance surface — only these blessed (model, method) pairs are
 * callable, never an arbitrary method. `reasonPositional` methods take the
 * refusal reason as the first method argument after the recordset ids.
 */
export const APPROVAL_ROUTES: Record<
  string,
  { approve: string; refuse: string; reasonPositional?: boolean }
> = {
  "hr.expense.sheet": {
    approve: "approve_expense_sheets",
    refuse: "refuse_sheet",
    reasonPositional: true,
  },
  "purchase.order": { approve: "button_confirm", refuse: "button_cancel" },
  "hr.leave": { approve: "action_approve", refuse: "action_refuse" },
  "approval.request": { approve: "action_approve", refuse: "action_refuse" },
};

/**
 * Pull a human-readable company name out of a raw Odoo `company_id` value.
 * Odoo returns m2o values as `[id, "display_name"]` tuples (before we wrap
 * them) or `false` for single-company tenants. Returns `null` for any other
 * shape so the label stays unsuffixed — never throws.
 */
export function extractCompanyLabel(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  if (typeof value[1] !== "string" || value[1].length === 0) return null;
  return value[1];
}

/**
 * Pull the numeric company id out of a raw Odoo `company_id` value. Mirrors
 * `extractCompanyLabel`: tuples `[id, "Name"]` → id; `false` / non-arrays /
 * non-positive integers / partial tuples without a usable label → `null`.
 * Never throws.
 *
 * Mutual-presence rule: requires `extractCompanyLabel(value)` to also resolve.
 * Without this, an exported helper could feed `{ companyId, companyLabel: undefined }`
 * into encodeRef and trip `isValidCompanyTag` at runtime. Keeping the asymmetry
 * out of the public surface is cheaper than documenting it.
 */
export function extractCompanyId(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  if (typeof value[0] !== "number" || !Number.isInteger(value[0]) || value[0] <= 0) {
    return null;
  }
  if (extractCompanyLabel(value) === null) return null;
  return value[0];
}

function wrapMany2OneValue(connectionId: string, field: OdooField, value: unknown): unknown {
  if (
    field.type !== "many2one" ||
    !field.relation ||
    !Array.isArray(value) ||
    typeof value[0] !== "number"
  ) {
    return value;
  }
  const label = typeof value[1] === "string" ? value[1] : String(value[0]);
  return {
    ref: encodeRef({
      integrationType: "odoo",
      connectionId,
      model: field.relation,
      id: value[0],
      label,
    }),
    label,
    model: field.relation,
  } satisfies OdooRefValue;
}

/**
 * Wrap each child id of a one2many field into a thin ref-carrying object so
 * the agent can target that specific line (e.g. to edit or remove it) by
 * pasting the `_pinchy_ref` into a Command tuple's id position — decoded
 * back to a numeric id by `resolveCommandTargetId`. Odoo's read/search_read
 * only ever returns o2m fields as a bare array of child ids (no name or
 * company tag comes back at read time), so the label is the best we can do
 * without an extra round trip: `<relation>#<id>`.
 *
 * Scope is one2many ONLY — many2many fields are left as raw id arrays
 * (out of scope for this change).
 *
 * Only transforms a non-empty array whose elements are all numbers. Empty
 * arrays stay `[]` (nothing to wrap). Anything else (shouldn't happen for
 * o2m on read, but the field loop is generic) passes through unchanged —
 * defensive, never throws.
 */
function wrapOne2ManyValue(connectionId: string, field: OdooField, value: unknown): unknown {
  if (
    field.type !== "one2many" ||
    !field.relation ||
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "number")
  ) {
    return value;
  }
  const relation = field.relation;
  return value.map((id) => ({
    _pinchy_ref: encodeRef({
      integrationType: "odoo",
      connectionId,
      model: relation,
      id: id as number,
      label: `${relation}#${id}`,
    }),
    id,
    model: relation,
  }));
}

function wrapReadResult(
  connectionId: string,
  model: string,
  fields: OdooField[],
  result: unknown
): unknown {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const wrapRecord = (record: OdooRecord): OdooRecord => {
    const wrapped = { ...record };

    // Emit a self-ref so the LLM can chain into tools that consume opaque
    // references (most notably odoo_attach_file). Symmetric with odoo_create.
    // Without this, the LLM only sees the raw integer id and tries to
    // construct ref strings like "<model>,<id>" which decodeRef rejects.
    // Field name is `_pinchy_ref` (not `ref`) to avoid shadowing the real
    // Odoo `ref` field that exists on account.move, account.payment, etc.
    if (typeof record.id === "number") {
      const baseLabel =
        typeof record.display_name === "string"
          ? record.display_name
          : typeof record.name === "string"
            ? record.name
            : `${model}#${record.id}`;
      // Read company_id from the RAW record (still a [id, "Name"] tuple);
      // do this before the m2o-wrap loop below replaces it with {ref, label, model}.
      const companyId = extractCompanyId(record.company_id);
      const companyLabel = extractCompanyLabel(record.company_id);
      const label = companyLabel ? `${baseLabel} [${companyLabel}]` : baseLabel;
      // Spread the company tag only when BOTH fields are non-null. This is
      // mandatory, not cosmetic: a malformed Odoo tuple like [7] (id without
      // name) yields companyId=7 but companyLabel=null, and the integration-ref
      // validator (isValidCompanyTag) rejects unpaired tags — so a one-sided
      // spread would trip encodeRef at runtime.
      wrapped._pinchy_ref = encodeRef({
        integrationType: "odoo",
        connectionId,
        model,
        id: record.id,
        label,
        ...(companyId !== null && companyLabel !== null ? { companyId, companyLabel } : {}),
      });
    }

    for (const [name, value] of Object.entries(wrapped)) {
      const field = byName.get(name);
      if (field) {
        wrapped[name] = wrapMany2OneValue(connectionId, field, value);
        wrapped[name] = wrapOne2ManyValue(connectionId, field, wrapped[name]);
      }
    }
    return wrapped;
  };

  if (Array.isArray(result)) return result.filter(isRecord).map(wrapRecord);
  if (isRecord(result) && Array.isArray(result.records)) {
    return {
      ...result,
      records: result.records.filter(isRecord).map(wrapRecord),
    };
  }
  return result;
}

/**
 * Serialized-size ceiling for an `odoo_read` result, in characters.
 *
 * OpenClaw's runtime caps every tool result at `maxChars=64000` and the whole
 * prompt history at `aggregateBudgetChars=256000`, replacing the overflow with a
 * literal `[... N more characters truncated …]` marker spliced MID-JSON. A real
 * `crm.lead` read on production reached ~509,000 chars — ~8× the per-result cap
 * and ~2× the entire aggregate budget — so the model received corrupt JSON plus
 * the marker and looped on "the results are truncated" (pinchy production, Piper
 * agent, 2026-07-22). We bound the result well under 64000 so (a) our JSON is
 * never cut mid-structure, and (b) several reads still fit inside the 256000
 * aggregate before OpenClaw has to intervene. This mirrors the pre-emptive
 * ceiling `openclaw-config/bootstrap-caps.ts` applies to instruction files.
 */
export const ODOO_READ_RESULT_BUDGET_CHARS = 30000;

export const ODOO_READ_TRUNCATION_HINT =
  "Result truncated to fit the model's context budget: `returned` of `total` " +
  "matching records are included. Narrow the query with more specific `filters`, " +
  "request fewer `fields`, or page through the rest with `offset`.";

/**
 * Bound an `odoo_read` result to {@link ODOO_READ_RESULT_BUDGET_CHARS} so it can
 * never trip OpenClaw's blind mid-JSON truncation. A result that already fits is
 * returned verbatim (same reference, no added keys — existing callers/tests see
 * no change). An oversized result keeps the largest prefix of records that fits
 * and returns a self-describing object: the original `total` (full Odoo match
 * count) is preserved, `returned` gives the included count, `truncated: true`
 * flags the cut, and `hint` tells the model how to get the rest. At least one
 * record is always kept, even if that single record alone exceeds the budget, so
 * the model can still make progress (and see the hint to drop heavy `fields`).
 */
export function enforceReadResultBudget(
  result: unknown,
  budget: number = ODOO_READ_RESULT_BUDGET_CHARS
): unknown {
  const records = getSearchReadRecords(result);
  if (records.length === 0) return result;
  if (JSON.stringify(result).length <= budget) return result;

  const isObjectShape = isRecord(result) && Array.isArray(result.records);
  const base: Record<string, unknown> = isObjectShape
    ? { ...(result as Record<string, unknown>) }
    : {};
  delete base.records;
  const total =
    isObjectShape && typeof (result as Record<string, unknown>).total === "number"
      ? ((result as Record<string, unknown>).total as number)
      : records.length;

  const build = (kept: OdooRecord[]) => ({
    ...base,
    records: kept,
    total,
    returned: kept.length,
    truncated: true,
    hint: ODOO_READ_TRUNCATION_HINT,
  });

  // Grow the kept set while the *actual* serialized length stays within budget
  // (measuring the real output, not an estimate, so the result is provably under
  // the ceiling). At least one record is always kept — even a lone record that
  // busts the budget beats returning nothing, and the hint tells the model to
  // drop heavy `fields`. We only reach this branch when the full result already
  // exceeds the budget, so the loop always breaks before exhausting `records`.
  const kept: OdooRecord[] = [];
  for (const record of records) {
    if (kept.length > 0 && JSON.stringify(build([...kept, record])).length > budget) break;
    kept.push(record);
  }

  return build(kept);
}

async function reportAuthFailure(
  apiBaseUrl: string,
  connectionId: string,
  gatewayToken: string,
  reason: string
): Promise<void> {
  try {
    await fetch(`${apiBaseUrl}/api/internal/integrations/${connectionId}/report-auth-failure`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        "Content-Type": "application/json",
        "X-Plugin-Id": "pinchy-odoo",
      },
      body: JSON.stringify({ reason: reason.slice(0, 500) }),
    });
  } catch {
    // best-effort — never mask the original tool error
  }
}

/**
 * Build an MCP-style error result. Every error result MUST carry
 * `details.error`, not just the `isError` flag: OpenClaw strips `isError`
 * before forwarding the result to `/api/internal/audit/tool-use` (OC bug
 * #404), and the audit endpoint then falls back to `result.details.error` to
 * record `outcome: failure`. Without it, a failed odoo tool call is silently
 * audited as success. Route ALL error results through this helper so that
 * invariant cannot be forgotten at an individual call site.
 */
function toolError(text: string): {
  content: ContentBlock[];
  isError: true;
  details: { error: string };
} {
  return {
    isError: true,
    content: [{ type: "text", text }],
    details: { error: text },
  };
}

function permissionDenied(
  operation: string,
  model: string
): { content: ContentBlock[]; isError: true; details: { error: string } } {
  return toolError(`Permission denied: ${operation} on ${model} is not allowed for this agent.`);
}

function isOdooAccessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("accesserror") ||
    msg.includes("access denied") ||
    msg.includes("not allowed") ||
    msg.includes("permission denied")
  );
}

function errorResult(
  error: unknown,
  context?: { operation?: string; model?: string }
): { content: ContentBlock[]; isError: true; details: { error: string } } {
  if (isOdooAccessError(error) && context?.model) {
    const op = context.operation ?? "access";
    return toolError(
      `Odoo denied permission to ${op} on ${context.model}. The Odoo user's permissions may have changed since the last sync. An admin can re-sync the connection in Settings > Integrations to update available permissions.`
    );
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  // A relation field (many2one) that received a display name instead of an id
  // surfaces from Postgres as "invalid input syntax for type integer: <text>".
  // That raw DB error is not actionable for the model, so append what to do:
  // resolve the name to an id/ref first (production: Penny repeatedly sent
  // account_id: "7600 Office supplies …" and got only the bare Postgres error).
  if (/invalid input syntax for type integer:/i.test(message)) {
    return toolError(
      `Error: ${message.trim()}\n\nThis usually means a relation field (e.g. account_id, partner_id, journal_id) was given a display name or text instead of a numeric id. Look the record up with odoo_read to get its id, then pass that id or the _pinchy_ref it returns — never the display name.`
    );
  }
  return toolError(`Error: ${message}`);
}

/**
 * A snapshot of the vendor bill that already carries a given `ref`, surfaced by
 * the deterministic duplicate guard (pinchy#721) so the model can relay it to
 * the user instead of double-booking (a double-payment risk).
 */
interface ExistingBillSnapshot {
  id: number;
  name: string | null;
  state: string | null;
  amount_total: number | null;
  date: string | null;
}

// Odoo's own duplicate detection (`_fetch_duplicate_reference`, account 19)
// keys VENDOR documents on their `ref` — the supplier's invoice number. Customer
// invoices (out_invoice/out_refund) are deduped on amount+date, NEVER on ref, and
// journal entries are never deduped at all. So a ref-based guard scopes to exactly
// these two vendor move types; guarding out_* on ref would falsely reject a
// legitimately re-used customer-document reference.
const VENDOR_DOCUMENT_MOVE_TYPES = new Set(["in_invoice", "in_refund"]);

function vendorDocumentLabel(moveType: string): string {
  return moveType === "in_refund" ? "vendor credit note" : "vendor bill";
}

function toBillSnapshot(record: Record<string, unknown>): ExistingBillSnapshot {
  return {
    id: record.id as number,
    name: typeof record.name === "string" ? record.name : null,
    state: typeof record.state === "string" ? record.state : null,
    amount_total: typeof record.amount_total === "number" ? record.amount_total : null,
    // Odoo returns `false` for an unset invoice_date; normalize to null.
    date: typeof record.invoice_date === "string" ? record.invoice_date : null,
  };
}

function formatExistingBillSnapshot(s: ExistingBillSnapshot): string {
  const parts = [`id ${s.id}`];
  if (s.name) parts.push(`"${s.name}"`);
  if (s.state) parts.push(`state ${s.state}`);
  if (s.amount_total !== null) parts.push(`total ${s.amount_total}`);
  if (s.date) parts.push(`dated ${s.date}`);
  return parts.join(", ");
}

/**
 * The block message. Deliberately phrased to make the model RELAY the existing
 * bill rather than loop against the refusal (the eval's hard-rejection scenario
 * showed some models retry a refused create). It names the bill, states it was
 * not created, and points at the explicit `allow_duplicate` override.
 */
function duplicateBillBlockMessage(
  moveType: string,
  ref: string,
  snapshot: ExistingBillSnapshot
): string {
  const label = vendorDocumentLabel(moveType);
  return (
    `Duplicate ${label} blocked. A ${label} with reference "${ref}" is already on file ` +
    `in Odoo: ${formatExistingBillSnapshot(snapshot)}. It was NOT created again — booking ` +
    `it twice risks a double payment. Do not retry this create; relay the existing bill ` +
    `above to the user. If this is a deliberate, confirmed re-filing, call odoo_create ` +
    `again with allow_duplicate: true.`
  );
}

const plugin = {
  id: "pinchy-odoo",
  name: "Pinchy Odoo",
  description: "Odoo ERP integration with model-level permissions.",

  register(api: PluginApi) {
    const pluginConfig = api.pluginConfig;
    const agentConfigs = pluginConfig?.agents ?? {};
    const apiBaseUrl = pluginConfig?.apiBaseUrl ?? "";
    const gatewayToken = pluginConfig?.gatewayToken ?? "";

    // Client cache per agent. Built lazily on first tool call: fetch
    // credentials from Pinchy → instantiate OdooClient. TTL keeps the
    // cache fresh enough that credential rotation propagates within
    // CREDENTIALS_TTL_MS without anyone restarting OpenClaw — and on a
    // 401 from Odoo (which is what happens immediately after a rotation
    // or revocation) we invalidate eagerly and refetch once before
    // surfacing the error to the user.
    const CREDENTIALS_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const cache = new Map<string, { client: OdooClient; expiresAt: number }>();

    function invalidate(agentId: string) {
      cache.delete(agentId);
    }

    async function getOrCreateClient(
      agentId: string,
      config: AgentOdooConfig
    ): Promise<OdooClient> {
      const hit = cache.get(agentId);
      if (hit && hit.expiresAt > Date.now()) return hit.client;
      const creds = await fetchCredentials(apiBaseUrl, gatewayToken, config.connectionId);
      const client = createClient(creds);
      cache.set(agentId, {
        client,
        expiresAt: Date.now() + CREDENTIALS_TTL_MS,
      });
      return client;
    }

    /**
     * Run an Odoo call with one transparent retry on auth failure.
     * Odoo throws an `AccessDenied` / 401-shaped error when the apiKey is
     * stale (rotated, revoked, expired). We invalidate the cache and
     * fetch fresh credentials once — if it still fails, surface to the
     * user.
     */
    async function withAuthRetry<T>(
      agentId: string,
      config: AgentOdooConfig,
      fn: (client: OdooClient) => Promise<T>
    ): Promise<T> {
      const client = await getOrCreateClient(agentId, config);
      try {
        return await fn(client);
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : "";
        const isAuthError =
          msg.includes("access denied") ||
          msg.includes("invalid api key") ||
          msg.includes("401") ||
          msg.includes("authenticat");
        if (!isAuthError) throw err;
        invalidate(agentId);
        const fresh = await getOrCreateClient(agentId, config);
        try {
          return await fn(fresh);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          await reportAuthFailure(apiBaseUrl, config.connectionId, gatewayToken, retryMsg);
          throw retryErr;
        }
      }
    }

    // Shared implementation of the list-models tool body. Reused by the
    // deprecated `odoo_schema` alias so legacy AGENTS.md content that calls
    // `odoo_schema` (without args) keeps working through v0.5.x.
    function listModelsImpl(config: AgentOdooConfig) {
      try {
        const names = config.modelNames ?? {};
        const models = Object.entries(config.permissions).map(([model, ops]) => ({
          model,
          name: names[model] ?? model,
          operations: ops,
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ models }) }],
        };
      } catch (error) {
        return errorResult(error);
      }
    }

    // Shared implementation of the describe-model tool body. Reused by the
    // deprecated `odoo_schema` alias so legacy AGENTS.md content that calls
    // `odoo_schema` with a `model` arg keeps working — and crucially, gets
    // the new compact response shape (the whole point of the v0.5.4 split).
    async function describeModelImpl(
      agentId: string,
      config: AgentOdooConfig,
      params: Record<string, unknown>
    ) {
      try {
        const model = params.model;
        if (typeof model !== "string" || model.length === 0) {
          return toolError("`model` is required (string).");
        }
        if (!config.permissions[model]) {
          return toolError(`Model "${model}" is not available for this agent.`);
        }

        const rawFields = await withAuthRetry(agentId, config, (client) => client.fields(model));
        const normalised = normalizeFields(rawFields);

        const result = compactSchema(normalised, {
          fields: Array.isArray(params.fields) ? (params.fields as string[]) : undefined,
          limit: typeof params.limit === "number" ? params.limit : 40,
          verbose: params.verbose === true,
        });

        const names = config.modelNames ?? {};
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                model,
                name: names[model] ?? model,
                ...result,
              }),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    }

    // 1. odoo_list_models
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_list_models",
          label: "Odoo List Models",
          description:
            "Discover which Odoo models this agent can access. Returns a compact list of {model, name, operations}. Call this first when you don't know which model to query.",
          parameters: {
            type: "object",
            properties: {},
          },
          async execute() {
            return listModelsImpl(config);
          },
        };
      },
      { name: "odoo_list_models" }
    );

    // 2. odoo_describe_model
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_describe_model",
          label: "Odoo Describe Model",
          description:
            "Get the field definitions for one Odoo model in a compact, agent-friendly format. By default returns the ~40 most commonly-needed fields (id, name, state, foreign keys, dates, amounts). Pass `fields: ['<name>', ...]` to target specific fields, `fields: ['__all__']` to get every field (large), or `verbose: true` for full Odoo metadata. Note: `id` is Odoo's internal numeric primary key and is NOT the SKU. The human-readable internal reference / SKU is `default_code` on product-like models — when both fields are present in the response, each is annotated to keep them distinct.",
          parameters: {
            type: "object",
            properties: {
              model: {
                type: "string",
                description: "Odoo model name to describe, e.g. 'account.move'.",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filter the response to these specific field names. Special value '__all__' returns every field. Omit to receive the curated default set.",
              },
              limit: {
                type: "number",
                description: "Cap on field count when `fields` is omitted (default 40).",
              },
              verbose: {
                type: "boolean",
                description:
                  "Include readonly/required/string-label metadata, plus the full selection-option list. Off by default for compactness; verbose responses on models with large selection fields can be substantially larger.",
              },
            },
            required: ["model"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            return describeModelImpl(agentId, config, params);
          },
        };
      },
      { name: "odoo_describe_model" }
    );

    // 2b. odoo_schema (deprecated alias — kept for AGENTS.md files written by
    // pre-v0.5.4 versions, which still contain literal `odoo_schema`
    // references. Behaviour mirrors the legacy tool: no `model` → list, with
    // `model` → describe. Both branches now go through the compact path.
    // Slated for removal in v0.6.x.
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_schema",
          label: "Odoo Schema (deprecated)",
          description:
            "DEPRECATED — prefer `odoo_list_models` (no arguments) or `odoo_describe_model` (with `model`). Kept for backwards compatibility with agents created before v0.5.4. Without `model`, returns the list of available models; with `model`, returns the compact field map for that model.",
          parameters: {
            type: "object",
            properties: {
              model: {
                type: "string",
                description: "Odoo model name to describe. Omit to list available models.",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filter the response to these specific field names. Special value '__all__' returns every field. Omit to receive the curated default set.",
              },
              limit: {
                type: "number",
                description: "Cap on field count when `fields` is omitted (default 40).",
              },
              verbose: {
                type: "boolean",
                description:
                  "Include readonly/required/string-label metadata. Off by default for compactness.",
              },
            },
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const model = params.model;
            if (typeof model !== "string" || model.length === 0) {
              return listModelsImpl(config);
            }
            return describeModelImpl(agentId, config, params);
          },
        };
      },
      { name: "odoo_schema" }
    );

    // 3. odoo_read
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_read",
          label: "Odoo Read",
          description: `Query records from Odoo. Returns matching records with field selection and pagination. Always returns { records, total, limit, offset } so you know if there's more data. If a result is too large for the context, it is trimmed to fit and flagged with { truncated: true, returned } — read \`returned\` of \`total\`, then narrow \`fields\`, tighten \`filters\`, or page with \`offset\` to get the rest rather than re-issuing the same broad read. ${PRODUCT_REF_DISAMBIGUATION_HINT}`,
          parameters: {
            type: "object",
            properties: {
              model: {
                type: "string",
                description: "Odoo model name, e.g. 'sale.order'",
              },
              filters: {
                type: "array",
                items: {
                  type: "array",
                  items: {},
                  description: "A [field, operator, value] tuple, e.g. ['state', '=', 'sale']",
                },
                description:
                  'Odoo domain filter. A plain array of [field, operator, value] tuples, e.g. [["state", "=", "posted"]] — never wrap it as {"item": …}. Operators: =, !=, >, >=, <, <=, in, not in, like, ilike. Optional — omit or pass [] to match all records.',
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description: "Fields to return. Omit for default fields.",
              },
              limit: {
                type: "number",
                description: "Max records (default: 100)",
              },
              offset: {
                type: "number",
                description: "Skip N records for pagination",
              },
              order: {
                type: "string",
                description: "Sort order, e.g. 'date_order desc'",
              },
            },
            required: ["model"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }
              // Reject the {item: …} array-serialization artifact in the domain
              // or field list before querying — Odoo otherwise fails it with an
              // opaque "unhashable type: 'dict'" (see hasItemWrappedArray).
              if (hasItemWrappedArray(params.filters)) {
                throw itemWrappedError("filters");
              }
              if (hasItemWrappedArray(params.fields)) {
                throw itemWrappedError("fields");
              }

              const result = await withAuthRetry(agentId, config, async (client) => {
                const modelFields = normalizeFields(await client.fields(model));
                const effectiveFields = augmentFieldsWithCompanyId(
                  stripSyntheticFields(params.fields as string[] | undefined),
                  modelFields
                );
                const records = await client.searchRead(model, asDomain(params.filters), {
                  fields: effectiveFields,
                  limit: params.limit as number | undefined,
                  offset: params.offset as number | undefined,
                  order: params.order as string | undefined,
                });
                return wrapReadResult(config.connectionId, model, modelFields, records);
              });

              return {
                content: [{ type: "text", text: JSON.stringify(enforceReadResultBudget(result)) }],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "read",
                model: params.model as string,
              });
            }
          },
        };
      },
      { name: "odoo_read" }
    );

    // 3. odoo_count
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_count",
          label: "Odoo Count",
          description: `Count matching records without transferring data. Much faster than reading all records. ${PRODUCT_REF_DISAMBIGUATION_HINT}`,
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              filters: {
                type: "array",
                items: {
                  type: "array",
                  items: {},
                  description: "A [field, operator, value] tuple",
                },
                description: "Odoo domain filter. Optional — omit or pass [] to match all records.",
              },
            },
            required: ["model"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }
              // Reject the {item: …} array-serialization artifact in the domain
              // before querying (see hasItemWrappedArray / odoo_read).
              if (hasItemWrappedArray(params.filters)) {
                throw itemWrappedError("filters");
              }

              const count = await withAuthRetry(agentId, config, (client) =>
                client.searchCount(model, asDomain(params.filters))
              );

              return {
                content: [{ type: "text", text: JSON.stringify({ count }) }],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "count",
                model: params.model as string,
              });
            }
          },
        };
      },
      { name: "odoo_count" }
    );

    // 4. odoo_aggregate
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_aggregate",
          label: "Odoo Aggregate",
          description: `Server-side aggregation — sums, averages, counts, grouped by fields. Use this instead of reading records and calculating yourself. Fields support aggregation: 'amount_total:sum', 'amount_total:avg', 'partner_id:count_distinct'. Groupby supports date granularity: 'date_order:month', 'date_order:week', 'date_order:year'. ${PRODUCT_REF_DISAMBIGUATION_HINT}`,
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              filters: {
                type: "array",
                items: {
                  type: "array",
                  items: {},
                  description: "A [field, operator, value] tuple",
                },
                description: "Odoo domain filter. Optional — omit or pass [] to match all records.",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Fields with optional aggregation, e.g. ['partner_id', 'amount_total:sum']",
              },
              groupby: {
                type: "array",
                items: { type: "string" },
                description: "Fields to group by, e.g. ['partner_id'] or ['date_order:month']",
              },
              limit: { type: "number", description: "Max groups to return" },
              offset: {
                type: "number",
                description: "Skip N groups for pagination",
              },
              orderby: { type: "string", description: "Sort order for groups" },
            },
            required: ["model", "fields", "groupby"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }

              // Reject the {item: …} array-serialization artifact in the domain
              // before querying (see hasItemWrappedArray / odoo_read).
              if (hasItemWrappedArray(params.filters)) {
                throw itemWrappedError("filters");
              }

              const fields = prepareAggregateFields(params.fields, "fields");
              const groupby = prepareAggregateFields(params.groupby, "groupby");

              const result = await withAuthRetry(agentId, config, (client) =>
                client.readGroup(model, asDomain(params.filters), fields, groupby, {
                  limit: params.limit as number | undefined,
                  offset: params.offset as number | undefined,
                  orderby: params.orderby as string | undefined,
                })
              );

              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "aggregate",
                model: params.model as string,
              });
            }
          },
        };
      },
      { name: "odoo_aggregate" }
    );

    // 5. odoo_create
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_create",
          label: "Odoo Create",
          description:
            'Create a new record in Odoo. Returns `{id, _pinchy_ref}` — pass the `_pinchy_ref` verbatim to any tool that takes an opaque reference (e.g. `odoo_attach_file.targetRef`). For many2one fields, do not pass raw numeric IDs; use an opaque ref from odoo_read, an exact display name, or a supported lookup such as a country code. One2many and many2many fields use Odoo command tuples emitted as plain JSON arrays: a new line is invoice_line_ids: [[0, 0, {…}]] and a tag link is tax_ids: [[6, 0, [<taxId>]]] — never wrap arrays as {"item": …}. Note: in invoice/order line models (e.g. `account.move.line`, `sale.order.line`, `purchase.order.line`), `price_unit` is tax-exclusive (net); Odoo computes gross totals from `tax_ids`. Convert receipt gross amounts to net before writing. Vendor bills and vendor credit notes (account.move `in_invoice` / `in_refund`) are duplicate-guarded: a create whose `ref` already exists on file is BLOCKED and the existing bill returned so you can relay it to the user instead of double-booking. Set `allow_duplicate: true` only to deliberately re-file a bill you have confirmed should exist twice.',
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              values: {
                type: "object",
                description:
                  "Field values for the new record. Many2one text values must be exact names or supported codes, not partial/fuzzy matches.",
              },
              allow_duplicate: {
                type: "boolean",
                description:
                  "Set true ONLY to deliberately re-file a vendor bill/credit note (account.move in_invoice/in_refund) whose reference already exists in Odoo. Normally leave unset: the plugin blocks a duplicate vendor-bill create and returns the existing bill so you relay it to the user instead of double-booking (a double-payment risk).",
              },
            },
            required: ["model", "values"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "create")) {
                return permissionDenied("create", model);
              }
              // Reject the {item: …} array-serialization artifact before any
              // Odoo round-trip — forwarding it produces opaque server errors
              // the model cannot recover from (see hasItemWrappedArray).
              if (hasItemWrappedArray(params.values)) {
                throw itemWrappedError("values");
              }

              // Explicit override for a deliberate re-filing of a bill that
              // already exists (pinchy#721). Read from the raw params: it is a
              // tool-level flag, not an Odoo field, so it never enters `values`.
              const allowDuplicate = params.allow_duplicate === true;

              const outcome = await withAuthRetry(
                agentId,
                config,
                async (
                  client
                ): Promise<
                  | {
                      kind: "created";
                      id: number;
                      override: ExistingBillSnapshot | null;
                      ref: string | null;
                      moveType: string;
                    }
                  | {
                      kind: "blocked";
                      moveType: string;
                      ref: string;
                      snapshot: ExistingBillSnapshot;
                    }
                > => {
                  let values: Record<string, unknown>;
                  // The model's field schema, fetched once during many2one
                  // normalization and reused for #5 selection validation below
                  // (avoids a second client.fields round-trip on every create).
                  let modelFields: OdooField[] | null = null;
                  if (isRecord(params.values)) {
                    const cleaned = unquoteFieldKeys(params.values);
                    assertNoCrossCompanyRefs(cleaned);
                    const normalized = await normalizeMany2OneValues(
                      client,
                      config.connectionId,
                      model,
                      cleaned,
                      config.permissions
                    );
                    values = normalized.values;
                    modelFields = normalized.fields;
                    values = await ensureActivityResModelId(client, model, values);
                  } else {
                    values = params.values as Record<string, unknown>;
                  }

                  // #5: reject out-of-set selection values (e.g. move_type
                  // "in_bill", which is not a real Odoo move_type) with the valid
                  // options, instead of forwarding a bad enum to Odoo where it
                  // surfaces as an opaque server error the agent has to guess at.
                  if (modelFields) {
                    const invalidSelections = findInvalidSelectionValues(modelFields, values);
                    if (invalidSelections.length > 0) {
                      throw new Error(formatInvalidSelectionError(model, invalidSelections));
                    }
                  }

                  // #3: deterministic vendor-bill duplicate guard (pinchy#721).
                  // A vendor bill/credit note is keyed by its `ref` — the
                  // supplier's invoice number. On staging an agent created
                  // move_id 40 duplicating move_id 39, both ref 083000981540; in
                  // the eval, 13/14 models filed the duplicate anyway. Pinchy owns
                  // the tool layer, so Pinchy owns the guarantee: before creating,
                  // search for an existing bill with the same ref (+ move_type +
                  // company + partner). On a hit, BLOCK and return the existing
                  // bill so the model relays it; `allow_duplicate: true` is the
                  // explicit escape hatch for a deliberate second entry. Scope is
                  // in_invoice/in_refund only — matching Odoo's own ref-based
                  // dedup, which never ref-dedups customer invoices or entries.
                  let override: ExistingBillSnapshot | null = null;
                  const moveType = typeof values.move_type === "string" ? values.move_type : "";
                  if (
                    model === "account.move" &&
                    VENDOR_DOCUMENT_MOVE_TYPES.has(moveType) &&
                    typeof values.ref === "string" &&
                    values.ref.trim() &&
                    checkPermission(config.permissions, model, "read")
                  ) {
                    const dupDomain: OdooDomain = [
                      ["ref", "=", values.ref],
                      ["move_type", "=", moveType],
                    ];
                    // Scope by company: the same supplier invoice number can be
                    // booked legitimately by two separate companies in one Odoo
                    // instance, so a global ref match would falsely reject the
                    // second company's entry. company_id is a resolved integer
                    // here (normalizeMany2OneValues ran above).
                    if (typeof values.company_id === "number") {
                      dupDomain.push(["company_id", "=", values.company_id]);
                    }
                    if (typeof values.partner_id === "number") {
                      dupDomain.push(["partner_id", "=", values.partner_id]);
                    }
                    const existing = getSearchReadRecords(
                      await client.searchRead("account.move", dupDomain, {
                        fields: ["id", "name", "state", "amount_total", "invoice_date"],
                        limit: 1,
                      })
                    );
                    if (existing.length > 0) {
                      const snapshot = toBillSnapshot(existing[0]);
                      if (!allowDuplicate) {
                        return { kind: "blocked", moveType, ref: values.ref, snapshot };
                      }
                      // Override authorized: remember what was overridden so the
                      // deliberate double-booking is traceable in the audit trail.
                      override = snapshot;
                    }
                  }

                  const createdId = await client.create(model, values);
                  return {
                    kind: "created",
                    id: createdId,
                    override,
                    ref: typeof values.ref === "string" ? values.ref : null,
                    moveType,
                  };
                }
              );

              if (outcome.kind === "blocked") {
                // isError:true → the pinchy-audit hook + tool-use route record
                // outcome=failure with the snapshot lifted into detail.error.
                // toolError emits an error-ONLY `details: { error }`, which the
                // route deliberately does not treat as curation — so the blocked
                // create's params survive in the audit row for forensics.
                return toolError(
                  duplicateBillBlockMessage(outcome.moveType, outcome.ref, outcome.snapshot)
                );
              }

              const id = outcome.id;

              // Emit a self-ref so the LLM can chain into tools that consume
              // opaque references (most importantly odoo_attach_file). Without
              // this, the LLM only sees the raw integer id and has no way to
              // construct a valid pinchy_ref:v1:… token. Label fallback chain:
              // values.name → values.display_name → "<model>#<id>".
              const valuesObj = isRecord(params.values) ? params.values : {};
              const label =
                typeof valuesObj.name === "string"
                  ? valuesObj.name
                  : typeof valuesObj.display_name === "string"
                    ? valuesObj.display_name
                    : `${model}#${id}`;
              const selfRef = encodeRef({
                integrationType: "odoo",
                connectionId: config.connectionId,
                model,
                id,
                label,
              });

              const body: Record<string, unknown> = { id, _pinchy_ref: selfRef };
              if (outcome.override) {
                body.duplicate_override = { existing_bill: outcome.override };
                return {
                  content: [{ type: "text", text: JSON.stringify(body) }],
                  // Curated audit detail (the tool-use route lifts result.details
                  // and, because it carries non-error fields, suppresses the raw
                  // create params): the deliberate double-booking described inline
                  // — what was booked (ref + move type + new id) AND the bill it
                  // duplicated — so an auditor sees the full decision without a
                  // second lookup. The snapshot deliberately carries the existing
                  // bill's amount/date/state (auditor context, not PII) but no
                  // partner identity, so no personal identifiers reach the log.
                  details: {
                    duplicateOverride: true,
                    bookedRef: outcome.ref,
                    bookedMoveType: outcome.moveType,
                    createdId: id,
                    existingBill: outcome.override,
                  },
                };
              }

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(body),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "create",
                model: params.model as string,
              });
            }
          },
        };
      },
      { name: "odoo_create" }
    );

    // 5b. odoo_schedule_activity
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_schedule_activity",
          label: "Odoo Schedule Activity",
          description:
            'Schedule a follow-up activity (a planned to-do with a due date) on an existing Odoo record such as a CRM lead, so it surfaces in Odoo\'s activity views and shows the team which record needs attention. Pass the `_pinchy_ref` of the target record (from odoo_read or odoo_create), a short `summary`, and a `dueDate` (YYYY-MM-DD). Optionally set `note`, an `assignee` (exact user name or an opaque res.users ref; defaults to the record\'s salesperson), and an `activityType` (exact name such as "Call"; defaults to "To-Do"). This is the correct way to create activities — do NOT create `mail.activity` records directly with odoo_create.',
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                description:
                  'Opaque `_pinchy_ref` of the record to attach the activity to (from odoo_read or odoo_create). Do NOT pass raw numeric IDs or "model,id" strings.',
              },
              summary: {
                type: "string",
                description: 'Short title of the follow-up, e.g. "Call about the quote".',
              },
              dueDate: {
                type: "string",
                description: "Deadline in YYYY-MM-DD format.",
              },
              note: {
                type: "string",
                description: "Optional longer description / context for the activity.",
              },
              assignee: {
                type: "string",
                description:
                  "Optional. Exact user name or an opaque res.users ref. Defaults to the target record's salesperson, or the API user if none is set.",
              },
              activityType: {
                type: "string",
                description:
                  'Optional exact activity type name (e.g. "To-Do", "Call", "Email"). Defaults to "To-Do".',
              },
            },
            required: ["target", "summary", "dueDate"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const target = params.target;
              if (typeof target !== "string" || target.length === 0) {
                return errorResult(
                  new Error(
                    "`target` is required: pass the _pinchy_ref of the record to attach the activity to."
                  )
                );
              }
              const summary = params.summary;
              if (typeof summary !== "string" || summary.trim().length === 0) {
                return errorResult(new Error("`summary` is required."));
              }
              const dueDate = params.dueDate;
              if (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
                return errorResult(new Error("`dueDate` is required in YYYY-MM-DD format."));
              }

              const decoded = decodeTargetRef(config.connectionId, target);
              const targetModel = decoded.model;
              const targetId = decoded.id;

              if (!checkPermission(config.permissions, "mail.activity", "create")) {
                return permissionDenied("create", "mail.activity");
              }
              if (!checkPermission(config.permissions, targetModel, "read")) {
                return permissionDenied("read", targetModel);
              }

              const id = await withAuthRetry(agentId, config, async (client) => {
                const resModelId = await resolveIrModelId(client, targetModel);

                const activityTypeRequested =
                  typeof params.activityType === "string" ? params.activityType.trim() : "";
                const activityTypeId =
                  activityTypeRequested.length > 0
                    ? await resolveActivityTypeByName(client, activityTypeRequested)
                    : await resolveDefaultActivityTypeId(client);

                const assigneeRequested =
                  typeof params.assignee === "string" ? params.assignee.trim() : "";
                const userId =
                  assigneeRequested.length > 0
                    ? await resolveAssigneeUserId(client, config.connectionId, assigneeRequested)
                    : await resolveTargetSalespersonId(client, targetModel, targetId);

                const values: Record<string, unknown> = {
                  res_model_id: resModelId,
                  res_id: targetId,
                  date_deadline: dueDate,
                  summary: summary.trim(),
                };
                if (typeof params.note === "string" && params.note.length > 0) {
                  values.note = params.note;
                }
                if (activityTypeId != null) {
                  values.activity_type_id = activityTypeId;
                }
                if (userId != null) {
                  values.user_id = userId;
                }

                return client.create("mail.activity", values);
              });

              const ref = encodeRef({
                integrationType: "odoo",
                connectionId: config.connectionId,
                model: "mail.activity",
                id: id as number,
                label: summary.trim(),
              });

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ id, _pinchy_ref: ref }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "create",
                model: "mail.activity",
              });
            }
          },
        };
      },
      { name: "odoo_schedule_activity" }
    );

    // 5c. odoo_complete_activity
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_complete_activity",
          label: "Odoo Complete Activity",
          description:
            "Mark a scheduled activity as done — posts a completion note to the record's chatter and clears the activity from the to-do list so it no longer shows as pending or overdue. Pass the activity's `_pinchy_ref` (from `odoo_read` on `mail.activity`, or the response of `odoo_schedule_activity`) and an optional `feedback` note. Use this to close out follow-ups you have handled.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                description:
                  "Opaque `_pinchy_ref` of the mail.activity to complete (from `odoo_read` on `mail.activity` or the response of `odoo_schedule_activity`).",
              },
              feedback: {
                type: "string",
                description:
                  'Optional note recorded in the completion message, e.g. "Called, customer confirmed".',
              },
            },
            required: ["target"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const target = params.target;
              if (typeof target !== "string" || target.length === 0) {
                return errorResult(
                  new Error(
                    "`target` is required: pass the _pinchy_ref of the activity to complete."
                  )
                );
              }
              const decoded = decodeTargetRef(config.connectionId, target);
              if (decoded.model !== "mail.activity") {
                return errorResult(
                  new Error(
                    "`target` must be a mail.activity ref — read the activity with `odoo_read` on `mail.activity` first."
                  )
                );
              }
              if (!checkPermission(config.permissions, "mail.activity", "write")) {
                return permissionDenied("write", "mail.activity");
              }

              const kwargs: Record<string, unknown> = {};
              if (typeof params.feedback === "string" && params.feedback.trim().length > 0) {
                kwargs.feedback = params.feedback.trim();
              }

              await withAuthRetry(agentId, config, (client) =>
                client.callMethod("mail.activity", "action_feedback", [[decoded.id]], kwargs)
              );

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ completed: true, id: decoded.id }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "write",
                model: "mail.activity",
              });
            }
          },
        };
      },
      { name: "odoo_complete_activity" }
    );

    // 5d. odoo_reschedule_activity
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_reschedule_activity",
          label: "Odoo Reschedule Activity",
          description:
            "Change a scheduled activity's due date and/or assignee without closing it. Pass the activity's `_pinchy_ref` and at least one of `dueDate` (YYYY-MM-DD) or `assignee` (exact user name or an opaque res.users ref). Use this to push a follow-up to a new date or hand it to someone else.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                description:
                  "Opaque `_pinchy_ref` of the mail.activity to reschedule (from `odoo_read` on `mail.activity`).",
              },
              dueDate: {
                type: "string",
                description: "New deadline in YYYY-MM-DD format.",
              },
              assignee: {
                type: "string",
                description: "New assignee: exact user name or an opaque res.users ref.",
              },
            },
            required: ["target"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const target = params.target;
              if (typeof target !== "string" || target.length === 0) {
                return errorResult(
                  new Error(
                    "`target` is required: pass the _pinchy_ref of the activity to reschedule."
                  )
                );
              }
              const dueDateRaw = typeof params.dueDate === "string" ? params.dueDate.trim() : "";
              const assigneeRaw = typeof params.assignee === "string" ? params.assignee.trim() : "";
              if (dueDateRaw.length === 0 && assigneeRaw.length === 0) {
                return errorResult(
                  new Error(
                    "Provide at least one of `dueDate` (YYYY-MM-DD) or `assignee` to reschedule."
                  )
                );
              }
              if (dueDateRaw.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)) {
                return errorResult(new Error("`dueDate` must be in YYYY-MM-DD format."));
              }

              const decoded = decodeTargetRef(config.connectionId, target);
              if (decoded.model !== "mail.activity") {
                return errorResult(
                  new Error(
                    "`target` must be a mail.activity ref — read the activity with `odoo_read` on `mail.activity` first."
                  )
                );
              }
              if (!checkPermission(config.permissions, "mail.activity", "write")) {
                return permissionDenied("write", "mail.activity");
              }

              const success = await withAuthRetry(agentId, config, async (client) => {
                const values: Record<string, unknown> = {};
                if (dueDateRaw.length > 0) values.date_deadline = dueDateRaw;
                if (assigneeRaw.length > 0) {
                  values.user_id = await resolveAssigneeUserId(
                    client,
                    config.connectionId,
                    assigneeRaw
                  );
                }
                return client.write("mail.activity", [decoded.id], values);
              });

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ success, id: decoded.id }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "write",
                model: "mail.activity",
              });
            }
          },
        };
      },
      { name: "odoo_reschedule_activity" }
    );

    // 5e–5h. Governed record-action tools. Each invokes one allow-listed Odoo
    // button/action method via callMethod. Variant A: if Odoo returns a wizard
    // action instead of completing, we report a handoff rather than faking
    // success.
    function recordActionFactory(spec: {
      name: string;
      label: string;
      description: string;
      model: string;
      method: string;
    }) {
      return (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: spec.name,
          label: spec.label,
          description: spec.description,
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                description: `Opaque \`_pinchy_ref\` of the ${spec.model} record (from odoo_read or odoo_create).`,
              },
            },
            required: ["target"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const target = params.target;
              if (typeof target !== "string" || target.length === 0) {
                return errorResult(
                  new Error(
                    `\`target\` is required: pass the _pinchy_ref of the ${spec.model} record.`
                  )
                );
              }
              const decoded = decodeTargetRef(config.connectionId, target);
              if (decoded.model !== spec.model) {
                return errorResult(new Error(`\`target\` must be a ${spec.model} ref.`));
              }
              if (!checkPermission(config.permissions, spec.model, "write")) {
                return permissionDenied("write", spec.model);
              }

              const result = await withAuthRetry(agentId, config, (client) =>
                client.callMethod(spec.model, spec.method, [[decoded.id]], {})
              );

              const pending = describePendingWizard(result);
              if (pending) {
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        completed: false,
                        needsHuman: true,
                        pendingStep: pending,
                        message: `Odoo could not finish this automatically — it needs a human decision in the "${pending}" step (e.g. a backorder, immediate-transfer, or consumption confirmation). Ask the user to complete it in Odoo.`,
                      }),
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ completed: true, id: decoded.id }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "write",
                model: spec.model,
              });
            }
          },
        };
      };
    }

    api.registerTool(
      recordActionFactory({
        name: "odoo_confirm_order",
        label: "Odoo Confirm Sale Order",
        description:
          "Confirm a draft/sent quotation into a sales order via Odoo's `action_confirm` — the only correct way to confirm an order (it creates the deliveries and procurement). Do NOT confirm by writing `state` directly; that skips those side effects. Pass the sale.order `_pinchy_ref`.",
        model: "sale.order",
        method: "action_confirm",
      }),
      { name: "odoo_confirm_order" }
    );

    api.registerTool(
      recordActionFactory({
        name: "odoo_apply_inventory",
        label: "Odoo Apply Inventory Count",
        description:
          "Apply a counted inventory adjustment on a `stock.quant` (Odoo's `action_apply_inventory`) — run this AFTER writing `inventory_quantity` on the quant, to post the adjustment into real stock. Pass the stock.quant `_pinchy_ref`.",
        model: "stock.quant",
        method: "action_apply_inventory",
      }),
      { name: "odoo_apply_inventory" }
    );

    api.registerTool(
      recordActionFactory({
        name: "odoo_validate_picking",
        label: "Odoo Validate Picking",
        description:
          "Validate a stock transfer / picking (Odoo's `button_validate`) to post the physical move. If Odoo needs a backorder or immediate-transfer decision it will NOT auto-complete — the tool reports that so a human can finish it. Pass the stock.picking `_pinchy_ref`. Always confirm the per-line quantities with the user first.",
        model: "stock.picking",
        method: "button_validate",
      }),
      { name: "odoo_validate_picking" }
    );

    api.registerTool(
      recordActionFactory({
        name: "odoo_mark_mo_done",
        label: "Odoo Mark Manufacturing Order Done",
        description:
          "Mark a manufacturing order done (Odoo's `button_mark_done`) to record consumption and finished goods. If Odoo needs a backorder / consumption decision it will NOT auto-complete — the tool reports that for a human to finish. Pass the mrp.production `_pinchy_ref`. Confirm quantities with the user first.",
        model: "mrp.production",
        method: "button_mark_done",
      }),
      { name: "odoo_mark_mo_done" }
    );

    // 5i. odoo_set_approval (parameterized over an allow-list of approval models)
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_set_approval",
          label: "Odoo Set Approval Decision",
          description:
            'Approve or refuse an approval-style record (expense report, purchase order, leave request, or generic approval) via its blessed Odoo method — never by writing `state` directly. Pass the record\'s `_pinchy_ref`, a `decision` ("approve" or "refuse"), and an optional `reason` (recorded on refusal where supported, e.g. expense reports). Supported models: hr.expense.sheet, purchase.order, hr.leave, approval.request.',
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                description: "Opaque `_pinchy_ref` of the record to approve or refuse.",
              },
              decision: {
                type: "string",
                enum: ["approve", "refuse"],
                description: '"approve" or "refuse".',
              },
              reason: {
                type: "string",
                description:
                  "Optional reason, recorded on refusal where the model supports it (e.g. expense reports).",
              },
            },
            required: ["target", "decision"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const target = params.target;
              if (typeof target !== "string" || target.length === 0) {
                return errorResult(
                  new Error("`target` is required: pass the _pinchy_ref of the record.")
                );
              }
              const decision: "approve" | "refuse" | null =
                params.decision === "approve"
                  ? "approve"
                  : params.decision === "refuse"
                    ? "refuse"
                    : null;
              if (!decision) {
                return errorResult(new Error('`decision` must be "approve" or "refuse".'));
              }
              const decoded = decodeTargetRef(config.connectionId, target);
              const route = APPROVAL_ROUTES[decoded.model];
              if (!route) {
                return errorResult(
                  new Error(
                    `${decoded.model} is not an approvable model. Supported: ${Object.keys(
                      APPROVAL_ROUTES
                    ).join(", ")}.`
                  )
                );
              }
              if (!checkPermission(config.permissions, decoded.model, "write")) {
                return permissionDenied("write", decoded.model);
              }

              const method = route[decision];
              const reason = typeof params.reason === "string" ? params.reason.trim() : "";
              const args: unknown[] =
                decision === "refuse" && route.reasonPositional
                  ? [[decoded.id], reason || "Refused"]
                  : [[decoded.id]];

              const result = await withAuthRetry(agentId, config, (client) =>
                client.callMethod(decoded.model, method, args, {})
              );

              const pending = describePendingWizard(result);
              if (pending) {
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        completed: false,
                        needsHuman: true,
                        pendingStep: pending,
                        message: `Odoo opened a follow-up step ("${pending}") that needs a human decision — ask the user to complete it in Odoo.`,
                      }),
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      completed: true,
                      id: decoded.id,
                      decision,
                    }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error, { operation: "write" });
            }
          },
        };
      },
      { name: "odoo_set_approval" }
    );

    // 5j. odoo_reconcile. Odoo has no single "reconcile" button we could wrap,
    // and the Enterprise bank-reconciliation widget is unusable over RPC (in
    // Odoo 19 its model is gone entirely; in 16-18 every action on it is
    // private and the model has no table). So this tool reproduces what the
    // widget does, using only public methods of the free `account` module —
    // which is also why it works on Odoo Community, not just Enterprise.
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_reconcile",
          label: "Odoo Reconcile Payment",
          description:
            "Reconcile a POSTED bill or invoice against the money that settled it — either a bank transaction (`account.bank.statement.line`) or an existing payment (`account.payment`). Pass the `_pinchy_ref` of the bill/invoice as `invoice` and the `_pinchy_ref` of the bank transaction or payment as `counterpart`. This is the only correct way to reconcile: do NOT try to write `full_reconcile_id` or create `account.full.reconcile` records — Odoo maintains those itself. The tool verifies the result by re-reading the bill and reports honestly if nothing was reconciled. Reconcile only after the user has confirmed the match.",
          parameters: {
            type: "object",
            properties: {
              invoice: {
                type: "string",
                description:
                  "Opaque `_pinchy_ref` of the posted `account.move` (vendor bill or customer invoice) to settle.",
              },
              counterpart: {
                type: "string",
                description:
                  "Opaque `_pinchy_ref` of the money movement that settled it: an `account.bank.statement.line` (bank transaction) or an `account.payment`.",
              },
            },
            required: ["invoice", "counterpart"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const invoiceRef = params.invoice;
              const counterpartRef = params.counterpart;
              if (typeof invoiceRef !== "string" || invoiceRef.length === 0) {
                return errorResult(
                  new Error(
                    "`invoice` is required: pass the _pinchy_ref of the bill or invoice (account.move)."
                  )
                );
              }
              if (typeof counterpartRef !== "string" || counterpartRef.length === 0) {
                return errorResult(
                  new Error(
                    "`counterpart` is required: pass the _pinchy_ref of the bank transaction (account.bank.statement.line) or payment (account.payment)."
                  )
                );
              }

              // decodeTargetRef throws (never returns null) on a malformed or
              // foreign ref; the throw is caught below and surfaced with the
              // parameter name we pass here, so the user is told which ref was
              // wrong rather than a generic "target".
              const inv = decodeTargetRef(config.connectionId, invoiceRef, "invoice");
              if (inv.model !== "account.move") {
                return errorResult(
                  new Error(
                    "`invoice` must be an account.move ref (a vendor bill or customer invoice)."
                  )
                );
              }
              const cp = decodeTargetRef(config.connectionId, counterpartRef, "counterpart");
              if (cp.model !== "account.bank.statement.line" && cp.model !== "account.payment") {
                return errorResult(
                  new Error(
                    `\`counterpart\` must be an account.bank.statement.line (bank transaction) or account.payment ref, not ${cp.model}.`
                  )
                );
              }

              // Reconciling rewrites and matches journal items in every case.
              if (!checkPermission(config.permissions, "account.move.line", "write")) {
                return permissionDenied("write", "account.move.line");
              }
              // The bank flow additionally restates the statement line's move.
              if (
                cp.model === "account.bank.statement.line" &&
                !checkPermission(config.permissions, "account.bank.statement.line", "write")
              ) {
                return permissionDenied("write", "account.bank.statement.line");
              }

              const invoice = (
                await withAuthRetry(agentId, config, (client) =>
                  client.searchRead("account.move", [["id", "=", inv.id]], {
                    fields: [
                      "name",
                      "state",
                      "payment_state",
                      "amount_residual",
                      "company_id",
                      "partner_id",
                    ],
                    limit: 1,
                  })
                )
              ).records[0];
              if (!invoice) {
                return errorResult(new Error(`account.move ${inv.id} was not found in Odoo.`));
              }
              const invoiceName = typeof invoice.name === "string" ? invoice.name : `#${inv.id}`;

              // Odoo 19 no longer refuses to reconcile a draft entry — it just
              // silently does nothing. Catch it here or ship a false success.
              if (invoice.state !== "posted") {
                return errorResult(
                  new Error(
                    `${invoiceName} is in state "${String(invoice.state)}", not "posted". Odoo accepts a reconcile call on a draft entry but silently does nothing, so post it first (after the user confirms), then reconcile.`
                  )
                );
              }

              const invoiceLines = (
                await withAuthRetry(agentId, config, (client) =>
                  client.searchRead(
                    "account.move.line",
                    [
                      ["move_id", "=", inv.id],
                      ["account_type", "in", SETTLEMENT_ACCOUNT_TYPES],
                      ["reconciled", "=", false],
                    ],
                    {
                      fields: ["id", "account_id", "account_type", "debit", "credit"],
                    }
                  )
                )
              ).records;
              if (invoiceLines.length === 0) {
                return errorResult(
                  new Error(
                    `${invoiceName} has no open receivable/payable line — there is nothing left to reconcile (it may already be paid).`
                  )
                );
              }
              if (invoiceLines.length > 1) {
                return errorResult(
                  new Error(
                    `${invoiceName} has ${invoiceLines.length} open receivable/payable lines, so the counterpart is ambiguous. Reconcile it in Odoo.`
                  )
                );
              }
              const invoiceLine = invoiceLines[0];
              const settlementAccountId = relationId(invoiceLine.account_id);
              if (settlementAccountId === null) {
                return errorResult(
                  new Error(`Could not read the settlement account of ${invoiceName}.`)
                );
              }
              const invoiceCompanyId = relationId(invoice.company_id);
              const residualBefore = invoice.amount_residual;

              /**
               * Re-read the bill and report only what Odoo actually did. On
               * failure the caller gets an error, never a success claim.
               */
              const confirm = async (
                extra: Record<string, unknown>,
                rollback?: () => Promise<void>
              ) => {
                const after = (
                  await withAuthRetry(agentId, config, (client) =>
                    client.searchRead("account.move", [["id", "=", inv.id]], {
                      fields: ["payment_state", "amount_residual"],
                      limit: 1,
                    })
                  )
                ).records[0];
                if (!didReconcile(residualBefore, after?.amount_residual)) {
                  if (rollback) await rollback();
                  return toolError(
                    `Odoo accepted the reconcile call but ${invoiceName} did not reconcile: its open balance is still ${String(after?.amount_residual ?? residualBefore)}. Odoo reports no error in this case, so this is not a transient failure — the entries were not matched. Check in Odoo that both sides are posted and on the same account.`
                  );
                }
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        reconciled: true,
                        invoice: { id: inv.id, name: invoiceName },
                        paymentState: after?.payment_state,
                        amountResidual: after?.amount_residual,
                        ...extra,
                      }),
                    },
                  ],
                };
              };

              // ---- Counterpart is an existing payment -------------------
              if (cp.model === "account.payment") {
                const payment = (
                  await withAuthRetry(agentId, config, (client) =>
                    client.searchRead("account.payment", [["id", "=", cp.id]], {
                      fields: ["move_id", "state", "company_id"],
                      limit: 1,
                    })
                  )
                ).records[0];
                if (!payment) {
                  return errorResult(new Error(`account.payment ${cp.id} was not found in Odoo.`));
                }
                // A canceled or rejected payment has no live journal entry to
                // match against; reconcile() would silently no-op, so refuse it
                // up front with a message the agent can act on.
                if (payment.state === "canceled" || payment.state === "rejected") {
                  return errorResult(
                    new Error(
                      `This payment is in state "${String(payment.state)}", so there is nothing to reconcile against. Use a payment that is in process or paid.`
                    )
                  );
                }
                const paymentCompanyId = relationId(payment.company_id);
                if (
                  invoiceCompanyId !== null &&
                  paymentCompanyId !== null &&
                  invoiceCompanyId !== paymentCompanyId
                ) {
                  return errorResult(
                    new Error(
                      `Cross-company match rejected: ${invoiceName} belongs to ${relationLabel(invoice.company_id) ?? invoiceCompanyId} but the payment belongs to ${relationLabel(payment.company_id) ?? paymentCompanyId}.`
                    )
                  );
                }
                // Odoo 19 payments may exist without a journal entry.
                const paymentMoveId = relationId(payment.move_id);
                if (paymentMoveId === null) {
                  return errorResult(
                    new Error(
                      "This payment has no journal entry yet, so there is nothing to reconcile against."
                    )
                  );
                }
                const paymentLine = (
                  await withAuthRetry(agentId, config, (client) =>
                    client.searchRead(
                      "account.move.line",
                      [
                        ["move_id", "=", paymentMoveId],
                        ["account_id", "=", settlementAccountId],
                        ["reconciled", "=", false],
                      ],
                      { fields: ["id"] }
                    )
                  )
                ).records[0];
                if (!paymentLine) {
                  return errorResult(
                    new Error(
                      `This payment has no matching open line on ${relationLabel(invoiceLine.account_id) ?? "the settlement account"} — it does not post to the same account as ${invoiceName}, so Odoo cannot reconcile the two.`
                    )
                  );
                }
                // js_assign_outstanding_line adds the invoice's own line for
                // us and reconciles both. It takes a scalar line id.
                await withAuthRetry(agentId, config, (client) =>
                  client.callMethod(
                    "account.move",
                    "js_assign_outstanding_line",
                    [[inv.id], paymentLine.id],
                    {}
                  )
                );
                return await confirm({ payment: { id: cp.id } });
              }

              // ---- Counterpart is a bank transaction --------------------
              const stLine = (
                await withAuthRetry(agentId, config, (client) =>
                  client.searchRead("account.bank.statement.line", [["id", "=", cp.id]], {
                    fields: ["payment_ref", "move_id", "journal_id", "is_reconciled", "company_id"],
                    limit: 1,
                  })
                )
              ).records[0];
              if (!stLine) {
                return errorResult(
                  new Error(`account.bank.statement.line ${cp.id} was not found in Odoo.`)
                );
              }
              if (stLine.is_reconciled === true) {
                return errorResult(
                  new Error(
                    "This bank transaction is already reconciled. Undo the existing match in Odoo first if it is wrong."
                  )
                );
              }
              const stCompanyId = relationId(stLine.company_id);
              if (
                invoiceCompanyId !== null &&
                stCompanyId !== null &&
                invoiceCompanyId !== stCompanyId
              ) {
                return errorResult(
                  new Error(
                    `Cross-company match rejected: ${invoiceName} belongs to ${relationLabel(invoice.company_id) ?? invoiceCompanyId} but the bank transaction belongs to ${relationLabel(stLine.company_id) ?? stCompanyId}.`
                  )
                );
              }
              const stMoveId = relationId(stLine.move_id);
              const journalId = relationId(stLine.journal_id);
              if (stMoveId === null || journalId === null) {
                return errorResult(
                  new Error("Could not read the bank transaction's journal entry or journal.")
                );
              }
              const journal = (
                await withAuthRetry(agentId, config, (client) =>
                  client.searchRead("account.journal", [["id", "=", journalId]], {
                    fields: ["default_account_id", "suspense_account_id"],
                    limit: 1,
                  })
                )
              ).records[0];
              if (!journal) {
                return errorResult(new Error(`account.journal ${journalId} was not found.`));
              }
              const bankAccountId = relationId(journal.default_account_id);
              const suspenseAccountId = relationId(journal.suspense_account_id);

              const stMoveLines = (
                await withAuthRetry(agentId, config, (client) =>
                  client.searchRead("account.move.line", [["move_id", "=", stMoveId]], {
                    fields: [
                      "id",
                      "account_id",
                      "debit",
                      "credit",
                      "amount_currency",
                      "partner_id",
                      "name",
                    ],
                  })
                )
              ).records;
              const liquidityLines = stMoveLines.filter(
                (l) => relationId(l.account_id) === bankAccountId
              );
              const suspenseLines = stMoveLines.filter(
                (l) => relationId(l.account_id) === suspenseAccountId
              );
              // `_synchronize_from_moves` enforces exactly one liquidity line
              // and at most one suspense line; a shape we don't recognise means
              // this transaction is already partly matched.
              if (liquidityLines.length !== 1) {
                return errorResult(
                  new Error(
                    `This bank transaction has ${liquidityLines.length} bank lines; Odoo requires exactly one. Reconcile it in Odoo.`
                  )
                );
              }
              if (suspenseLines.length !== 1) {
                return errorResult(
                  new Error(
                    "This bank transaction has no suspense line to replace — it is probably already matched to something else. Reset it in Odoo first."
                  )
                );
              }
              // The rewrite below clears every line ([5,0,0]) and recreates only
              // the liquidity + counterpart pair. A move carrying any additional
              // line (e.g. a split bank fee on its own account) would have that
              // line silently dropped, so refuse anything that isn't the plain
              // two-line liquidity/suspense shape and let a human handle it.
              if (stMoveLines.length !== 2) {
                return errorResult(
                  new Error(
                    `This bank transaction's journal entry has ${stMoveLines.length} lines, not the expected two (one bank line, one suspense line). It carries an extra line this tool would drop on rewrite — reconcile it in Odoo.`
                  )
                );
              }
              const liquidity = liquidityLines[0];
              const suspense = suspenseLines[0];

              // Step 1: restate the counterpart from the suspense account onto
              // the bill's payable/receivable account, preserving the
              // liquidity line and the original signs. This is exactly what
              // the bank-reconciliation widget does, and what core's own
              // `action_undo_reconciliation` does in reverse. Odoo refuses the
              // write on a posted move without these context flags.
              await withAuthRetry(agentId, config, (client) =>
                client.callMethod(
                  "account.bank.statement.line",
                  "write",
                  [
                    [cp.id],
                    {
                      line_ids: [
                        [5, 0, 0],
                        [
                          0,
                          0,
                          {
                            account_id: bankAccountId,
                            debit: liquidity.debit,
                            credit: liquidity.credit,
                            amount_currency: liquidity.amount_currency,
                            partner_id: relationId(liquidity.partner_id),
                            name: liquidity.name,
                          },
                        ],
                        [
                          0,
                          0,
                          {
                            account_id: settlementAccountId,
                            debit: suspense.debit,
                            credit: suspense.credit,
                            amount_currency: suspense.amount_currency,
                            partner_id:
                              relationId(invoice.partner_id) ?? relationId(suspense.partner_id),
                            name: suspense.name,
                          },
                        ],
                      ],
                    },
                  ],
                  { context: { force_delete: true, skip_readonly_check: true } }
                )
              );

              const newCounterpart = (
                await withAuthRetry(agentId, config, (client) =>
                  client.searchRead(
                    "account.move.line",
                    [
                      ["move_id", "=", stMoveId],
                      ["account_id", "=", settlementAccountId],
                    ],
                    { fields: ["id"] }
                  )
                )
              ).records[0];
              if (!newCounterpart) {
                return errorResult(
                  new Error(
                    "Odoo did not create the counterpart line on the settlement account; the bank transaction was left unchanged."
                  )
                );
              }

              // Step 2: same-account reconcile.
              await withAuthRetry(agentId, config, (client) =>
                client.callMethod(
                  "account.move.line",
                  "reconcile",
                  [[newCounterpart.id, invoiceLine.id]],
                  {}
                )
              );

              return await confirm(
                { bankTransaction: { id: cp.id, ref: stLine.payment_ref } },
                // Never leave the statement line restated-but-unmatched: put
                // its suspense counterpart back so the books look exactly as
                // they did before, and a human can retry in Odoo.
                async () => {
                  await withAuthRetry(agentId, config, (client) =>
                    client.callMethod(
                      "account.bank.statement.line",
                      "action_undo_reconciliation",
                      [[cp.id]],
                      {}
                    )
                  );
                }
              );
            } catch (error) {
              return errorResult(error, { operation: "write" });
            }
          },
        };
      },
      { name: "odoo_reconcile" }
    );

    // 6. odoo_write
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_write",
          label: "Odoo Write",
          description:
            'Update an existing record in Odoo. For many2one fields, do not pass raw numeric IDs; use an opaque ref from odoo_read, an exact display name, or a supported lookup such as a country code. One2many and many2many fields use Odoo command tuples emitted as plain JSON arrays: a new line is invoice_line_ids: [[0, 0, {…}]] and a tag link is tax_ids: [[6, 0, [<taxId>]]] — never wrap arrays as {"item": …}. Note: in invoice/order line models (e.g. `account.move.line`, `sale.order.line`, `purchase.order.line`), `price_unit` is tax-exclusive (net); Odoo computes gross totals from `tax_ids`. Convert receipt gross amounts to net before writing.',
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              ids: {
                type: "array",
                items: { type: "number" },
                description: "IDs of records to update",
              },
              values: {
                type: "object",
                description:
                  "Field values to update. Many2one text values must be exact names or supported codes, not partial/fuzzy matches.",
              },
            },
            required: ["model", "ids", "values"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "write")) {
                return permissionDenied("write", model);
              }
              // Reject the {item: …} array-serialization artifact before any
              // Odoo round-trip — `values` carries the same one2many/many2many
              // command tuples as odoo_create, so it hits the identical opaque
              // "unhashable type: 'dict'" if forwarded (see hasItemWrappedArray).
              if (hasItemWrappedArray(params.values)) {
                throw itemWrappedError("values");
              }

              const success = await withAuthRetry(agentId, config, async (client) => {
                let values: Record<string, unknown>;
                if (isRecord(params.values)) {
                  const cleaned = unquoteFieldKeys(params.values);
                  assertNoCrossCompanyRefs(cleaned);
                  values = (
                    await normalizeMany2OneValues(
                      client,
                      config.connectionId,
                      model,
                      cleaned,
                      config.permissions
                    )
                  ).values;
                  values = await ensureActivityResModelId(client, model, values);
                } else {
                  values = params.values as Record<string, unknown>;
                }
                return client.write(model, params.ids as number[], values);
              });

              return {
                content: [{ type: "text", text: JSON.stringify({ success }) }],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "write",
                model: params.model as string,
              });
            }
          },
        };
      },
      { name: "odoo_write" }
    );

    // 7. odoo_delete
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_delete",
          label: "Odoo Delete",
          description: "Delete records from Odoo.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              ids: {
                type: "array",
                items: { type: "number" },
                description: "IDs of records to delete",
              },
            },
            required: ["model", "ids"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "delete")) {
                return permissionDenied("delete", model);
              }

              const success = await withAuthRetry(agentId, config, (client) =>
                client.unlink(model, params.ids as number[])
              );

              return {
                content: [{ type: "text", text: JSON.stringify({ success }) }],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "delete",
                model: params.model as string,
              });
            }
          },
        };
      },
      { name: "odoo_delete" }
    );

    // 8. odoo_attach_file
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_attach_file",
          label: "Odoo Attach File",
          description:
            "Attach an uploaded file to an existing Odoo record. Pass the opaque ref of the target record and a plain filename (no path components, no leading dot, max 25 MB) of a file in the agent's uploads directory. Returns the encrypted ref of the new ir.attachment record.",
          parameters: {
            type: "object",
            properties: {
              targetRef: {
                type: "string",
                description:
                  'Opaque reference to the Odoo record to attach the file to. Use the `_pinchy_ref` field returned by `odoo_create` (for a record you just created) or `odoo_read` (for an existing record). The value is an encrypted token starting with `pinchy_ref:v1:` — do NOT construct strings like `"<model>,<id>"` or pass raw numeric IDs; the plugin will reject them.',
              },
              filename: {
                type: "string",
                description:
                  'Filename of an existing upload in the agent\'s uploads directory — either a plain filename, or a full path (e.g. from a "[media attached: …]" hint); only the basename is used. Must not start with "." after reducing to its basename.',
              },
            },
            required: ["targetRef", "filename"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            // Tolerant input: agents often pass the full "[media attached: /root/.openclaw/
            // media/inbound/x.jpg]" path from the message hint. Only the basename matters —
            // mirrored Telegram media lands in uploads/ under the same basename.
            const rawFilename = String(params.filename ?? "");
            const filename = basename(rawFilename.replace(/\\/g, "/"));
            try {
              // Filename validation runs first — independent of targetRef
              // decoding or permission checks — because it defends against
              // prompt-injection-driven file exfiltration. A compromised
              // agent could otherwise pass `../../etc/passwd` and have the
              // plugin attach arbitrary container files to an Odoo record.
              // basename() above already strips every directory component
              // (including ".." segments), so reads stay confined to this
              // agent's uploads/ dir; isSafeFilename still rejects dotfiles
              // and empty names.
              if (!isSafeFilename(filename)) {
                return toolError(
                  `Invalid filename: "${filename}". Must be a plain file name without path components (no "/", no "\\", no "..", no leading ".").`
                );
              }

              const targetRef = params.targetRef as string;
              // Per-connection isolation: a ref minted for a DIFFERENT
              // connection decodes validly under this deployment's single ref
              // key, so reject it before acting — same gate every other
              // ref-consuming Odoo tool applies (decodeTargetRef).
              const decoded = decodeTargetRef(config.connectionId, targetRef, "targetRef");

              if (!checkPermission(config.permissions, "ir.attachment", "create")) {
                return permissionDenied("create", "ir.attachment");
              }
              if (!checkPermission(config.permissions, decoded.model, "write")) {
                return permissionDenied("write", decoded.model);
              }

              const filePath = `${WORKSPACE_ROOT}/${agentId}/uploads/${filename}`;

              let fileSize: number;
              try {
                const fileStat = await stat(filePath);
                fileSize = fileStat.size;
              } catch (err) {
                const code =
                  err && typeof err === "object" && "code" in err
                    ? String((err as { code: unknown }).code)
                    : "";
                if (code === "ENOENT") {
                  return toolError(
                    `File not found: ${filename}. Chat uploads and Telegram media land in the uploads directory automatically (Telegram media keeps the basename shown in "[media attached: …]"). If it is missing, tell the user honestly and ask the user to re-send the file — never guess or invent filenames.`
                  );
                }
                throw err;
              }

              if (fileSize > MAX_ATTACHMENT_BYTES) {
                const sizeMb = (fileSize / 1024 / 1024).toFixed(1);
                const maxMb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0);
                return toolError(
                  `File too large: ${filename} is ${sizeMb} MB, max allowed is ${maxMb} MB.`
                );
              }

              const fileBuffer = await readFile(filePath);
              const mimetype = mimeForFilename(filename);
              const datas = fileBuffer.toString("base64");

              const newId = await withAuthRetry(agentId, config, (client) =>
                client.create("ir.attachment", {
                  res_model: decoded.model,
                  res_id: decoded.id,
                  name: filename,
                  datas,
                  mimetype,
                })
              );

              const ref = encodeRef({
                integrationType: "odoo",
                connectionId: config.connectionId,
                model: "ir.attachment",
                id: newId as number,
                label: filename,
              });

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ ref, name: filename, mimetype }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error, {
                operation: "attach",
                model: "ir.attachment",
              });
            }
          },
        };
      },
      { name: "odoo_attach_file" }
    );
  },
};

export default plugin;
