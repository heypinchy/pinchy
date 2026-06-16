import { readFile, stat } from "./io";
import { basename, extname } from "path";
import { OdooClient } from "odoo-node";
import { checkPermission, type Permissions } from "./permissions";
import { decodeRef, encodeRef } from "./integration-ref";

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
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

function mimeForFilename(filename: string): string {
  return (
    MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream"
  );
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
    opts?: { name?: string },
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
    signal?: AbortSignal,
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

interface AgentOdooConfig {
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
  agentId: string,
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
function assertCredentialsShape(
  creds: unknown,
): asserts creds is OdooCredentials {
  if (!creds || typeof creds !== "object") {
    throw new Error(
      `pinchy-odoo: credentials must be an object, got ${typeof creds}`,
    );
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
      throw new Error(
        `pinchy-odoo: credentials.${name} must be a ${type}, got ${actual}${hint}`,
      );
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
  connectionId: string,
): Promise<OdooCredentials> {
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`,
    { headers: { Authorization: `Bearer ${gatewayToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Odoo credentials for connection ${connectionId}: ` +
        `HTTP ${response.status} ${response.statusText}`,
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
      key.length >= 2 && key.startsWith('"') && key.endsWith('"')
        ? key.slice(1, -1)
        : key;
    out[stripped] = unquoteFieldKeysDeep(val);
  }
  return out;
}

function unquoteFieldKeys(
  values: Record<string, unknown>,
): Record<string, unknown> {
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

const COMMON_INDEX = new Map(COMMON_FIELDS.map((f, i) => [f, i]));

export function sortFieldsByPriority(fields: OdooField[]): OdooField[] {
  return [...fields].sort((a, b) => {
    const ia = COMMON_INDEX.get(a.name) ?? Infinity;
    const ib = COMMON_INDEX.get(b.name) ?? Infinity;
    if (ia !== ib) return ia - ib;
    return a.name.localeCompare(b.name);
  });
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
const ID_DISAMBIGUATION_NOTE =
  "Odoo's internal numeric primary key. NOT the SKU.";
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
  opts: CompactSchemaOptions,
): CompactSchemaResult {
  const sorted = sortFieldsByPriority(allFields);

  // Empty `fields: []` is treated the same as omitted — the agent didn't ask
  // for anything specific, so fall through to the default-truncate path.
  const hasFieldsFilter = Array.isArray(opts.fields) && opts.fields.length > 0;
  const wantsAll =
    hasFieldsFilter &&
    opts.fields!.length === 1 &&
    opts.fields![0] === "__all__";

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
  const annotateIdVsCode =
    allFieldNames.has("id") && allFieldNames.has("default_code");

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
        ...(f.type === "many2one" ||
        f.type === "one2many" ||
        f.type === "many2many"
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

  const truncated =
    !hasFieldsFilter && !wantsAll && sorted.length > selected.length;
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
export function augmentFieldsWithCompanyId(
  requested: string[] | undefined,
  modelFields: OdooField[],
): string[] | undefined {
  if (!requested || requested.length === 0) return requested;
  const hasCompany = modelFields.some(
    (f) => f.name === "company_id" && f.type === "many2one",
  );
  if (!hasCompany) return requested;
  if (requested.includes("company_id")) return requested;
  return [...requested, "company_id"];
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
          relation:
            typeof field.relation === "string" ? field.relation : undefined,
          selection: Array.isArray(field.selection)
            ? (field.selection as Array<[string, string]>)
            : undefined,
          readonly:
            typeof field.readonly === "boolean" ? field.readonly : undefined,
          required:
            typeof field.required === "boolean" ? field.required : undefined,
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
        relation:
          typeof field.relation === "string" ? field.relation : undefined,
        selection: Array.isArray(field.selection)
          ? (field.selection as Array<[string, string]>)
          : undefined,
        readonly:
          typeof field.readonly === "boolean" ? field.readonly : undefined,
        required:
          typeof field.required === "boolean" ? field.required : undefined,
      },
    ];
  });
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
  return [
    ...new Set(records.map(recordId).filter((id): id is number => id !== null)),
  ];
}

function recordLabel(record: OdooRecord): string {
  return (
    recordText(record, "display_name") ??
    recordText(record, "name") ??
    String(record.id ?? "")
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
  const labels = [
    ...new Set(records.map(recordLabel).filter((label) => label.length > 0)),
  ].slice(0, MAX_DISPLAYED_LABELS);
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
  matches: OdooRecord[],
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
      `across companies (${list}). This is a multi-company collision — add a ` +
      `\`company_id\` filter to your odoo_read first (e.g. ` +
      `[["company_id", "=", <company _pinchy_ref>]]), then pass the exact ` +
      `\`_pinchy_ref\` of the right record.`
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
      (displayName !== null &&
        normalizeLookupText(displayName).startsWith(requested))
    );
  });
  return startsWith.length > 0 ? startsWith : records;
}

function parseLookup(field: OdooField, value: unknown): RelationLookup | null {
  if (typeof value === "string") {
    const input = value.trim();
    if (input === "") return { name: "" };
    const countryCode =
      field.relation === "res.country" ? countryCodeForInput(input) : null;
    return countryCode ? { code: countryCode } : { name: input };
  }

  if (!isRecord(value) || !isRecord(value.lookup)) return null;
  const lookup = value.lookup;
  return {
    name: typeof lookup.name === "string" ? lookup.name.trim() : undefined,
    code:
      typeof lookup.code === "string"
        ? lookup.code.trim().toUpperCase()
        : undefined,
  };
}

function resolveReferenceFromRecords(
  field: OdooField,
  lookup: RelationLookup,
  records: OdooRecord[],
): number {
  const label = field.string ?? field.name;
  const input = lookup.code ?? lookup.name ?? "";

  if (field.relation === "res.country" && lookup.code) {
    const codeMatches = records.filter(
      (record) => recordText(record, "code")?.toUpperCase() === lookup.code,
    );
    const ids = uniqueIds(codeMatches);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) {
      throw new Error(
        `Could not resolve ${field.name}: multiple countries match code "${lookup.code}".`,
      );
    }
  }

  if (!lookup.name) {
    throw new Error(
      `Could not resolve ${field.name} from "${input}".${formatSuggestions(records)} Provide an exact ${label} name or ref.`,
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
      rankedSuggestions(input, records),
    )} Provide an exact ${label} name or ref.`,
  );
}

function refToId(
  connectionId: string,
  field: OdooField,
  value: Record<string, unknown>,
): number | null {
  if (typeof value.ref !== "string") return null;
  const ref = decodeRef(value.ref);
  if (ref.integrationType !== "odoo") {
    throw new Error(`Invalid ref for ${field.name}: expected odoo.`);
  }
  if (ref.connectionId !== connectionId) {
    throw new Error(
      `Invalid ref for ${field.name}: connection does not match.`,
    );
  }
  if (ref.model !== field.relation) {
    throw new Error(
      `Invalid ref for ${field.name}: expected ${field.relation}, got ${ref.model}.`,
    );
  }
  return ref.id;
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
 * Scope: only top-level fields of `values` are inspected. Nested 2many/o2m
 * command tuples (e.g. `invoice_line_ids: [[0, 0, { account_id: ... }]]`)
 * are not walked — that broader check would require following Odoo's
 * Command structure, which is out of scope for this guard. Odoo's
 * server-side `company_id` constraint remains the ultimate authority.
 */
export function assertNoCrossCompanyRefs(
  values: Record<string, unknown>,
): void {
  const intended = readRefCompanyTag(values.company_id);
  if (intended === null) return;
  const intendedLabel = intended.label ?? `id=${intended.id}`;

  for (const [field, value] of Object.entries(values)) {
    if (field === "company_id") continue;
    const sibling = readRefCompanyTag(value);
    if (sibling === null) continue;
    if (sibling.id !== intended.id) {
      const otherLabel = sibling.label ?? `id=${sibling.id}`;
      throw new Error(
        `Cross-company write rejected: values.company_id points to "${intendedLabel}" ` +
          `but values.${field} points to a record in "${otherLabel}". ` +
          `Re-resolve ${field} in the right company first.`,
      );
    }
  }
}

/**
 * Decode the company tag (id + label) from a `{ ref }` shape in one pass.
 * Returns null when the value is not a tagged ref, when decoding fails, or
 * when the payload lacks a `companyId` tag (legacy / untagged refs). The
 * label may still be null even when the id is present, mirroring the
 * encoder's tolerance of partial tags on the read side.
 */
function readRefCompanyTag(
  value: unknown,
): { id: number; label: string | null } | null {
  if (!isRecord(value) || typeof value.ref !== "string") return null;
  try {
    const payload = decodeRef(value.ref);
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
 */
async function searchRelationByName(
  client: OdooClient,
  field: OdooField,
  lookup: RelationLookup,
): Promise<unknown> {
  const relation = field.relation as string;
  const relationFields = normalizeFields(await client.fields(relation));
  const lookupFields = augmentFieldsWithCompanyId(
    ["id", "name", "display_name"],
    relationFields,
  ) ?? ["id", "name", "display_name"];
  return client.searchRead(relation, [["name", "ilike", lookup.name ?? ""]], {
    fields: lookupFields,
    limit: 20,
  });
}

async function resolveRelationValue(
  client: OdooClient,
  connectionId: string,
  field: OdooField,
  value: unknown,
): Promise<unknown> {
  if (value == null || value === false) return value;
  if (typeof value === "number") {
    throw new Error(
      `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`,
    );
  }
  if (Array.isArray(value) && typeof value[0] === "number") {
    throw new Error(
      `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`,
    );
  }
  if (isRecord(value)) {
    const refId = refToId(connectionId, field, value);
    if (refId !== null) return refId;
    if (typeof value.id === "number") {
      throw new Error(
        `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`,
      );
    }
  }

  const lookup = parseLookup(field, value);
  if (!lookup) return value;
  if (lookup.name === "") return false;
  if (lookup.name && /^\d+$/.test(lookup.name)) {
    throw new Error(
      `Raw numeric IDs are not accepted for ${field.name}. Use an opaque ref or lookup.`,
    );
  }
  if (!field.relation) return value;

  const result =
    field.relation === "res.country"
      ? await client.searchRead(field.relation, [], {
          fields: ["id", "name", "display_name", "code"],
          limit: 1000,
        })
      : await searchRelationByName(client, field, lookup);

  return resolveReferenceFromRecords(
    field,
    lookup,
    getSearchReadRecords(result),
  );
}

async function normalizeMany2OneValues(
  client: OdooClient,
  connectionId: string,
  model: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fields = normalizeFields(await client.fields(model));
  if (fields.length === 0) return values;

  const normalized = { ...values };
  for (const field of fields) {
    if (field.type !== "many2one" || !(field.name in normalized)) continue;
    normalized[field.name] = await resolveRelationValue(
      client,
      connectionId,
      field,
      normalized[field.name],
    );
  }
  return normalized;
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
async function resolveIrModelId(
  client: OdooClient,
  technicalModel: string,
): Promise<number> {
  const result = await client.searchRead(
    "ir.model",
    [["model", "=", technicalModel]],
    { fields: ["id"], limit: 1 },
  );
  const record = getSearchReadRecords(result)[0];
  const id = record ? recordId(record) : null;
  if (id === null) {
    throw new Error(
      `Could not resolve the Odoo model "${technicalModel}" — no ir.model row found.`,
    );
  }
  return id;
}

/**
 * Resolve the default "To-Do" activity type id via its xmlid. Returns null
 * (rather than throwing) when ir.model.data is unreadable or the xmlid is
 * absent, so the caller can fall back to Odoo's own default activity type.
 */
async function resolveDefaultActivityTypeId(
  client: OdooClient,
): Promise<number | null> {
  try {
    const result = await client.searchRead(
      "ir.model.data",
      [
        ["module", "=", TODO_ACTIVITY_XMLID.module],
        ["name", "=", TODO_ACTIVITY_XMLID.name],
      ],
      { fields: ["res_id"], limit: 1 },
    );
    const record = getSearchReadRecords(result)[0];
    return record && typeof record.res_id === "number" ? record.res_id : null;
  } catch {
    return null;
  }
}

/** Resolve an activity type id from its exact (untranslated) name. */
async function resolveActivityTypeByName(
  client: OdooClient,
  name: string,
): Promise<number> {
  const result = await client.searchRead(
    "mail.activity.type",
    [["name", "=", name]],
    { fields: ["id"], limit: 1 },
  );
  const record = getSearchReadRecords(result)[0];
  const id = record ? recordId(record) : null;
  if (id === null) {
    throw new Error(
      `Could not resolve activity type "${name}". Use an exact activity type name (e.g. "To-Do", "Call", "Email").`,
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
  assignee: string,
): Promise<number> {
  if (assignee.startsWith("pinchy_ref:")) {
    const ref = decodeRef(assignee);
    if (
      ref.integrationType !== "odoo" ||
      ref.connectionId !== connectionId ||
      ref.model !== "res.users"
    ) {
      throw new Error("`assignee` ref must point to a res.users record.");
    }
    return ref.id;
  }
  const result = await client.searchRead(
    "res.users",
    [["name", "=", assignee]],
    {
      fields: ["id"],
      limit: 2,
    },
  );
  const ids = uniqueIds(getSearchReadRecords(result));
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw new Error(
      `Could not resolve assignee "${assignee}" — no matching user.`,
    );
  }
  throw new Error(
    `Could not resolve assignee "${assignee}" — multiple users match; pass an opaque res.users ref instead.`,
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
  targetId: number,
): Promise<number | null> {
  try {
    const result = await client.searchRead(
      targetModel,
      [["id", "=", targetId]],
      { fields: ["user_id"], limit: 1 },
    );
    const record = getSearchReadRecords(result)[0];
    const userId = record?.user_id;
    return Array.isArray(userId) && typeof userId[0] === "number"
      ? userId[0]
      : null;
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
  values: Record<string, unknown>,
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
  if (
    typeof value[0] !== "number" ||
    !Number.isInteger(value[0]) ||
    value[0] <= 0
  ) {
    return null;
  }
  if (extractCompanyLabel(value) === null) return null;
  return value[0];
}

function wrapMany2OneValue(
  connectionId: string,
  field: OdooField,
  value: unknown,
): unknown {
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

function wrapReadResult(
  connectionId: string,
  model: string,
  fields: OdooField[],
  result: unknown,
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
        ...(companyId !== null && companyLabel !== null
          ? { companyId, companyLabel }
          : {}),
      });
    }

    for (const [name, value] of Object.entries(wrapped)) {
      const field = byName.get(name);
      if (field) {
        wrapped[name] = wrapMany2OneValue(connectionId, field, value);
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

async function reportAuthFailure(
  apiBaseUrl: string,
  connectionId: string,
  gatewayToken: string,
  reason: string,
): Promise<void> {
  try {
    await fetch(
      `${apiBaseUrl}/api/internal/integrations/${connectionId}/report-auth-failure`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayToken}`,
          "Content-Type": "application/json",
          "X-Plugin-Id": "pinchy-odoo",
        },
        body: JSON.stringify({ reason: reason.slice(0, 500) }),
      },
    );
  } catch {
    // best-effort — never mask the original tool error
  }
}

function permissionDenied(
  operation: string,
  model: string,
): { content: ContentBlock[]; isError: true } {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Permission denied: ${operation} on ${model} is not allowed for this agent.`,
      },
    ],
  };
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
  context?: { operation?: string; model?: string },
): { content: ContentBlock[]; isError: true } {
  if (isOdooAccessError(error) && context?.model) {
    const op = context.operation ?? "access";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Odoo denied permission to ${op} on ${context.model}. The Odoo user's permissions may have changed since the last sync. An admin can re-sync the connection in Settings > Integrations to update available permissions.`,
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
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
      config: AgentOdooConfig,
    ): Promise<OdooClient> {
      const hit = cache.get(agentId);
      if (hit && hit.expiresAt > Date.now()) return hit.client;
      const creds = await fetchCredentials(
        apiBaseUrl,
        gatewayToken,
        config.connectionId,
      );
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
      fn: (client: OdooClient) => Promise<T>,
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
          const retryMsg =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          await reportAuthFailure(
            apiBaseUrl,
            config.connectionId,
            gatewayToken,
            retryMsg,
          );
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
        const models = Object.entries(config.permissions).map(
          ([model, ops]) => ({
            model,
            name: names[model] ?? model,
            operations: ops,
          }),
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ models }) },
          ],
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
      params: Record<string, unknown>,
    ) {
      try {
        const model = params.model;
        if (typeof model !== "string" || model.length === 0) {
          return {
            isError: true as const,
            content: [
              { type: "text" as const, text: "`model` is required (string)." },
            ],
          };
        }
        if (!config.permissions[model]) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: `Model "${model}" is not available for this agent.`,
              },
            ],
          };
        }

        const rawFields = await withAuthRetry(agentId, config, (client) =>
          client.fields(model),
        );
        const normalised = normalizeFields(rawFields);

        const result = compactSchema(normalised, {
          fields: Array.isArray(params.fields)
            ? (params.fields as string[])
            : undefined,
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
      { name: "odoo_list_models" },
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
                description:
                  "Odoo model name to describe, e.g. 'account.move'.",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filter the response to these specific field names. Special value '__all__' returns every field. Omit to receive the curated default set.",
              },
              limit: {
                type: "number",
                description:
                  "Cap on field count when `fields` is omitted (default 40).",
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
      { name: "odoo_describe_model" },
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
                description:
                  "Odoo model name to describe. Omit to list available models.",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Filter the response to these specific field names. Special value '__all__' returns every field. Omit to receive the curated default set.",
              },
              limit: {
                type: "number",
                description:
                  "Cap on field count when `fields` is omitted (default 40).",
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
      { name: "odoo_schema" },
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
          description: `Query records from Odoo. Returns matching records with field selection and pagination. Always returns { records, total, limit, offset } so you know if there's more data. ${PRODUCT_REF_DISAMBIGUATION_HINT}`,
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
                  description:
                    "A [field, operator, value] tuple, e.g. ['state', '=', 'sale']",
                },
                description:
                  "Odoo domain filter. Array of [field, operator, value] tuples. Operators: =, !=, >, >=, <, <=, in, not in, like, ilike. Use [] for no filter.",
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
            required: ["model", "filters"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }

              const result = await withAuthRetry(
                agentId,
                config,
                async (client) => {
                  const modelFields = normalizeFields(
                    await client.fields(model),
                  );
                  const effectiveFields = augmentFieldsWithCompanyId(
                    params.fields as string[] | undefined,
                    modelFields,
                  );
                  const records = await client.searchRead(
                    model,
                    params.filters as unknown[],
                    {
                      fields: effectiveFields,
                      limit: params.limit as number | undefined,
                      offset: params.offset as number | undefined,
                      order: params.order as string | undefined,
                    },
                  );
                  return wrapReadResult(
                    config.connectionId,
                    model,
                    modelFields,
                    records,
                  );
                },
              );

              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
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
      { name: "odoo_read" },
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
                description: "Odoo domain filter. Use [] for no filter.",
              },
            },
            required: ["model", "filters"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }

              const count = await withAuthRetry(agentId, config, (client) =>
                client.searchCount(model, params.filters as unknown[]),
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
      { name: "odoo_count" },
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
                description: "Odoo domain filter. Use [] for no filter.",
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
                description:
                  "Fields to group by, e.g. ['partner_id'] or ['date_order:month']",
              },
              limit: { type: "number", description: "Max groups to return" },
              offset: {
                type: "number",
                description: "Skip N groups for pagination",
              },
              orderby: { type: "string", description: "Sort order for groups" },
            },
            required: ["model", "filters", "fields", "groupby"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }

              const result = await withAuthRetry(agentId, config, (client) =>
                client.readGroup(
                  model,
                  params.filters as unknown[],
                  params.fields as string[],
                  params.groupby as string[],
                  {
                    limit: params.limit as number | undefined,
                    offset: params.offset as number | undefined,
                    orderby: params.orderby as string | undefined,
                  },
                ),
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
      { name: "odoo_aggregate" },
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
            "Create a new record in Odoo. Returns `{id, _pinchy_ref}` — pass the `_pinchy_ref` verbatim to any tool that takes an opaque reference (e.g. `odoo_attach_file.targetRef`). For many2one fields, do not pass raw numeric IDs; use an opaque ref from odoo_read, an exact display name, or a supported lookup such as a country code. Note: in invoice/order line models (e.g. `account.move.line`, `sale.order.line`, `purchase.order.line`), `price_unit` is tax-exclusive (net); Odoo computes gross totals from `tax_ids`. Convert receipt gross amounts to net before writing.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              values: {
                type: "object",
                description:
                  "Field values for the new record. Many2one text values must be exact names or supported codes, not partial/fuzzy matches.",
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

              const id = await withAuthRetry(
                agentId,
                config,
                async (client) => {
                  let values: Record<string, unknown>;
                  if (isRecord(params.values)) {
                    const cleaned = unquoteFieldKeys(params.values);
                    assertNoCrossCompanyRefs(cleaned);
                    values = await normalizeMany2OneValues(
                      client,
                      config.connectionId,
                      model,
                      cleaned,
                    );
                    values = await ensureActivityResModelId(
                      client,
                      model,
                      values,
                    );
                  } else {
                    values = params.values as Record<string, unknown>;
                  }
                  return client.create(model, values);
                },
              );

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

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ id, _pinchy_ref: selfRef }),
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
      { name: "odoo_create" },
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
                description:
                  'Short title of the follow-up, e.g. "Call about the quote".',
              },
              dueDate: {
                type: "string",
                description: "Deadline in YYYY-MM-DD format.",
              },
              note: {
                type: "string",
                description:
                  "Optional longer description / context for the activity.",
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
                    "`target` is required: pass the _pinchy_ref of the record to attach the activity to.",
                  ),
                );
              }
              const summary = params.summary;
              if (typeof summary !== "string" || summary.trim().length === 0) {
                return errorResult(new Error("`summary` is required."));
              }
              const dueDate = params.dueDate;
              if (
                typeof dueDate !== "string" ||
                !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
              ) {
                return errorResult(
                  new Error("`dueDate` is required in YYYY-MM-DD format."),
                );
              }

              const decoded = decodeRef(target);
              if (
                decoded.integrationType !== "odoo" ||
                decoded.connectionId !== config.connectionId
              ) {
                return errorResult(
                  new Error(
                    "`target` ref does not belong to this Odoo connection.",
                  ),
                );
              }
              const targetModel = decoded.model;
              const targetId = decoded.id;

              if (
                !checkPermission(config.permissions, "mail.activity", "create")
              ) {
                return permissionDenied("create", "mail.activity");
              }
              if (!checkPermission(config.permissions, targetModel, "read")) {
                return permissionDenied("read", targetModel);
              }

              const id = await withAuthRetry(
                agentId,
                config,
                async (client) => {
                  const resModelId = await resolveIrModelId(
                    client,
                    targetModel,
                  );

                  const activityTypeRequested =
                    typeof params.activityType === "string"
                      ? params.activityType.trim()
                      : "";
                  const activityTypeId =
                    activityTypeRequested.length > 0
                      ? await resolveActivityTypeByName(
                          client,
                          activityTypeRequested,
                        )
                      : await resolveDefaultActivityTypeId(client);

                  const assigneeRequested =
                    typeof params.assignee === "string"
                      ? params.assignee.trim()
                      : "";
                  const userId =
                    assigneeRequested.length > 0
                      ? await resolveAssigneeUserId(
                          client,
                          config.connectionId,
                          assigneeRequested,
                        )
                      : await resolveTargetSalespersonId(
                          client,
                          targetModel,
                          targetId,
                        );

                  const values: Record<string, unknown> = {
                    res_model_id: resModelId,
                    res_id: targetId,
                    date_deadline: dueDate,
                    summary: summary.trim(),
                  };
                  if (
                    typeof params.note === "string" &&
                    params.note.length > 0
                  ) {
                    values.note = params.note;
                  }
                  if (activityTypeId != null) {
                    values.activity_type_id = activityTypeId;
                  }
                  if (userId != null) {
                    values.user_id = userId;
                  }

                  return client.create("mail.activity", values);
                },
              );

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
      { name: "odoo_schedule_activity" },
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
                    "`target` is required: pass the _pinchy_ref of the activity to complete.",
                  ),
                );
              }
              const decoded = decodeRef(target);
              if (
                decoded.integrationType !== "odoo" ||
                decoded.connectionId !== config.connectionId
              ) {
                return errorResult(
                  new Error(
                    "`target` ref does not belong to this Odoo connection.",
                  ),
                );
              }
              if (decoded.model !== "mail.activity") {
                return errorResult(
                  new Error(
                    "`target` must be a mail.activity ref — read the activity with `odoo_read` on `mail.activity` first.",
                  ),
                );
              }
              if (
                !checkPermission(config.permissions, "mail.activity", "write")
              ) {
                return permissionDenied("write", "mail.activity");
              }

              const kwargs: Record<string, unknown> = {};
              if (
                typeof params.feedback === "string" &&
                params.feedback.trim().length > 0
              ) {
                kwargs.feedback = params.feedback.trim();
              }

              await withAuthRetry(agentId, config, (client) =>
                client.callMethod(
                  "mail.activity",
                  "action_feedback",
                  [[decoded.id]],
                  kwargs,
                ),
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
      { name: "odoo_complete_activity" },
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
                description:
                  "New assignee: exact user name or an opaque res.users ref.",
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
                    "`target` is required: pass the _pinchy_ref of the activity to reschedule.",
                  ),
                );
              }
              const dueDateRaw =
                typeof params.dueDate === "string" ? params.dueDate.trim() : "";
              const assigneeRaw =
                typeof params.assignee === "string"
                  ? params.assignee.trim()
                  : "";
              if (dueDateRaw.length === 0 && assigneeRaw.length === 0) {
                return errorResult(
                  new Error(
                    "Provide at least one of `dueDate` (YYYY-MM-DD) or `assignee` to reschedule.",
                  ),
                );
              }
              if (
                dueDateRaw.length > 0 &&
                !/^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)
              ) {
                return errorResult(
                  new Error("`dueDate` must be in YYYY-MM-DD format."),
                );
              }

              const decoded = decodeRef(target);
              if (
                decoded.integrationType !== "odoo" ||
                decoded.connectionId !== config.connectionId
              ) {
                return errorResult(
                  new Error(
                    "`target` ref does not belong to this Odoo connection.",
                  ),
                );
              }
              if (decoded.model !== "mail.activity") {
                return errorResult(
                  new Error(
                    "`target` must be a mail.activity ref — read the activity with `odoo_read` on `mail.activity` first.",
                  ),
                );
              }
              if (
                !checkPermission(config.permissions, "mail.activity", "write")
              ) {
                return permissionDenied("write", "mail.activity");
              }

              const success = await withAuthRetry(
                agentId,
                config,
                async (client) => {
                  const values: Record<string, unknown> = {};
                  if (dueDateRaw.length > 0) values.date_deadline = dueDateRaw;
                  if (assigneeRaw.length > 0) {
                    values.user_id = await resolveAssigneeUserId(
                      client,
                      config.connectionId,
                      assigneeRaw,
                    );
                  }
                  return client.write("mail.activity", [decoded.id], values);
                },
              );

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
      { name: "odoo_reschedule_activity" },
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
            "Update an existing record in Odoo. For many2one fields, do not pass raw numeric IDs; use an opaque ref from odoo_read, an exact display name, or a supported lookup such as a country code. Note: in invoice/order line models (e.g. `account.move.line`, `sale.order.line`, `purchase.order.line`), `price_unit` is tax-exclusive (net); Odoo computes gross totals from `tax_ids`. Convert receipt gross amounts to net before writing.",
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

              const success = await withAuthRetry(
                agentId,
                config,
                async (client) => {
                  let values: Record<string, unknown>;
                  if (isRecord(params.values)) {
                    const cleaned = unquoteFieldKeys(params.values);
                    assertNoCrossCompanyRefs(cleaned);
                    values = await normalizeMany2OneValues(
                      client,
                      config.connectionId,
                      model,
                      cleaned,
                    );
                    values = await ensureActivityResModelId(
                      client,
                      model,
                      values,
                    );
                  } else {
                    values = params.values as Record<string, unknown>;
                  }
                  return client.write(model, params.ids as number[], values);
                },
              );

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
      { name: "odoo_write" },
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
                client.unlink(model, params.ids as number[]),
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
      { name: "odoo_delete" },
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
                  "Plain filename of an existing upload in the agent's workspace uploads directory. Must not contain path separators ('/', '\\') or '..' and must not start with '.'",
              },
            },
            required: ["targetRef", "filename"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const filename = params.filename as string;
            try {
              // Filename validation runs first — independent of targetRef
              // decoding or permission checks — because it defends against
              // prompt-injection-driven file exfiltration. A compromised
              // agent could otherwise pass `../../etc/passwd` and have the
              // plugin attach arbitrary container files to an Odoo record.
              if (!isSafeFilename(filename)) {
                return {
                  isError: true as const,
                  content: [
                    {
                      type: "text",
                      text: `Invalid filename: "${filename}". Must be a plain file name without path components (no "/", no "\\", no "..", no leading ".").`,
                    },
                  ],
                };
              }

              const targetRef = params.targetRef as string;
              const decoded = decodeRef(targetRef);

              if (
                !checkPermission(config.permissions, "ir.attachment", "create")
              ) {
                return permissionDenied("create", "ir.attachment");
              }
              if (
                !checkPermission(config.permissions, decoded.model, "write")
              ) {
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
                  return {
                    isError: true as const,
                    content: [
                      {
                        type: "text",
                        text: `File not found: ${filename}. Make sure the file was uploaded before calling odoo_attach_file.`,
                      },
                    ],
                  };
                }
                throw err;
              }

              if (fileSize > MAX_ATTACHMENT_BYTES) {
                const sizeMb = (fileSize / 1024 / 1024).toFixed(1);
                const maxMb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0);
                return {
                  isError: true as const,
                  content: [
                    {
                      type: "text",
                      text: `File too large: ${filename} is ${sizeMb} MB, max allowed is ${maxMb} MB.`,
                    },
                  ],
                };
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
                }),
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
      { name: "odoo_attach_file" },
    );
  },
};

export default plugin;
