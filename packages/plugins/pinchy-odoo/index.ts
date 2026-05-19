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

function formatSuggestions(records: OdooRecord[]): string {
  const labels = [
    ...new Set(records.map(recordLabel).filter((label) => label.length > 0)),
  ].slice(0, 5);
  return labels.length > 0 ? ` Suggestions: ${labels.join(", ")}.` : "";
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
    throw new Error(
      `Could not resolve ${field.name}: multiple ${label} records match "${input}".`,
    );
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
      : await client.searchRead(
          field.relation,
          [["name", "ilike", lookup.name ?? ""]],
          {
            fields: ["id", "name", "display_name"],
            limit: 20,
          },
        );

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
      const label =
        typeof record.display_name === "string"
          ? record.display_name
          : typeof record.name === "string"
            ? record.name
            : `${model}#${record.id}`;
      wrapped._pinchy_ref = encodeRef({
        integrationType: "odoo",
        connectionId,
        model,
        id: record.id,
        label,
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
        return fn(fresh);
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
                  const records = await client.searchRead(
                    model,
                    params.filters as unknown[],
                    {
                      fields: params.fields as string[] | undefined,
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
                  const values = isRecord(params.values)
                    ? await normalizeMany2OneValues(
                        client,
                        config.connectionId,
                        model,
                        unquoteFieldKeys(params.values),
                      )
                    : (params.values as Record<string, unknown>);
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
                  const values = isRecord(params.values)
                    ? await normalizeMany2OneValues(
                        client,
                        config.connectionId,
                        model,
                        unquoteFieldKeys(params.values),
                      )
                    : (params.values as Record<string, unknown>);
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
