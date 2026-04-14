/**
 * Pipedrive schema sync — probes known entities via the Pipedrive REST API,
 * fetches field metadata for entities that support it, handles 403 (plan restriction).
 *
 * Analogous to odoo-sync.ts. Uses plain fetch() (not the SDK) for probing.
 */

export interface EntityCategory {
  id: string;
  label: string;
  entities: Array<{ entity: string; name: string; fieldsEndpoint: string | null }>;
}

export const ENTITY_CATEGORIES: EntityCategory[] = [
  {
    id: "crm",
    label: "CRM",
    entities: [
      { entity: "deals", name: "Deals", fieldsEndpoint: "dealFields" },
      { entity: "persons", name: "Persons", fieldsEndpoint: "personFields" },
      { entity: "organizations", name: "Organizations", fieldsEndpoint: "organizationFields" },
      { entity: "leads", name: "Leads", fieldsEndpoint: "leadFields" },
      { entity: "activities", name: "Activities", fieldsEndpoint: "activityFields" },
    ],
  },
  {
    id: "products",
    label: "Products",
    entities: [{ entity: "products", name: "Products", fieldsEndpoint: "productFields" }],
  },
  {
    id: "pipeline",
    label: "Pipeline",
    entities: [
      { entity: "pipelines", name: "Pipelines", fieldsEndpoint: null },
      { entity: "stages", name: "Stages", fieldsEndpoint: null },
    ],
  },
  {
    id: "communication",
    label: "Communication",
    entities: [
      { entity: "notes", name: "Notes", fieldsEndpoint: "noteFields" },
      { entity: "files", name: "Files", fieldsEndpoint: null },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    entities: [
      { entity: "projects", name: "Projects", fieldsEndpoint: null },
      { entity: "tasks", name: "Tasks", fieldsEndpoint: null },
    ],
  },
  {
    id: "reporting",
    label: "Reporting",
    entities: [{ entity: "goals", name: "Goals", fieldsEndpoint: null }],
  },
];

/**
 * Given synced schema data, return the labels of categories that have at least one accessible entity.
 * Used by the integration card to show a summary.
 */
export function getAccessibleCategoryLabels(
  data: { entities?: Array<{ entity: string }> } | null
): string[] {
  if (!data?.entities) return [];
  const entityNames = new Set(data.entities.map((e) => e.entity));
  return ENTITY_CATEGORIES.filter((cat) => cat.entities.some((e) => entityNames.has(e.entity))).map(
    (cat) => cat.label
  );
}

/** Flat list of all known entities (derived from categories). */
const ALL_KNOWN_ENTITIES = ENTITY_CATEGORIES.flatMap((cat) =>
  cat.entities.map((e) => ({ ...e, category: cat.id }))
);

export interface CategorySummary {
  id: string;
  label: string;
  accessible: boolean;
  accessibleEntities: string[];
  totalEntities: number;
}

export interface PipedriveSyncResult {
  success: true;
  entities: number;
  lastSyncAt: string;
  categories: CategorySummary[];
  data: {
    entities: Array<{
      entity: string;
      name: string;
      category: string;
      fields?: Array<{
        key: string;
        name: string;
        type: string;
        required: boolean;
        options?: Array<{ id: number; label: string }>;
      }>;
      operations: { read: boolean; create: boolean; update: boolean; delete: boolean };
    }>;
    lastSyncAt: string;
  };
}

export interface PipedriveSyncError {
  success: false;
  error: string;
}

const MAX_CONCURRENCY = 5;
const MAX_RETRIES = 2;

import { getPipedriveBaseUrl } from "./pipedrive-api";

function getPipedriveV1Url(): string {
  return `${getPipedriveBaseUrl()}/v1`;
}

/** Static operations per entity — Pipedrive doesn't expose per-user access rights. */
const ENTITY_OPERATIONS: Record<
  string,
  { read: boolean; create: boolean; update: boolean; delete: boolean }
> = {
  deals: { read: true, create: true, update: true, delete: true },
  persons: { read: true, create: true, update: true, delete: true },
  organizations: { read: true, create: true, update: true, delete: true },
  leads: { read: true, create: true, update: true, delete: true },
  activities: { read: true, create: true, update: true, delete: true },
  products: { read: true, create: true, update: true, delete: true },
  pipelines: { read: true, create: true, update: true, delete: true },
  stages: { read: true, create: true, update: true, delete: true },
  notes: { read: true, create: true, update: true, delete: true },
  files: { read: true, create: true, update: false, delete: true },
  projects: { read: true, create: true, update: true, delete: true },
  tasks: { read: true, create: true, update: true, delete: true },
  goals: { read: true, create: true, update: true, delete: true },
};

/** Run async tasks with limited concurrency. */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

type ProbeResult = {
  entity: string;
  name: string;
  category: string;
  fieldsEndpoint: string | null;
  accessible: boolean;
  fields?: Array<{
    key: string;
    name: string;
    type: string;
    required: boolean;
    options?: Array<{ id: number; label: string }>;
  }>;
};

/**
 * Fetch schema from a Pipedrive instance by probing known entities via the REST API.
 * Entities returning 403 (plan restriction) are silently skipped.
 * Retries transient errors (network errors) up to MAX_RETRIES times, but NOT 403s.
 * Limits concurrency to MAX_CONCURRENCY.
 * Does NOT save anything — returns the data for the caller to handle.
 */
export async function fetchPipedriveSchema(
  apiToken: string
): Promise<PipedriveSyncResult | PipedriveSyncError> {
  const headers = { "x-api-token": apiToken };

  const tasks = ALL_KNOWN_ENTITIES.map(({ entity, name, category, fieldsEndpoint }) => {
    return async (): Promise<ProbeResult> => {
      // Phase 1: Probe entity accessibility
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const probeUrl = `${getPipedriveV1Url()}/${entity}?limit=1`;
          const response = await fetch(probeUrl, { headers });

          if (response.status === 403) {
            // Plan-restricted — don't retry
            return { entity, name, category, fieldsEndpoint, accessible: false };
          }

          if (!response.ok) {
            // 4xx (except 429) → skip immediately, no retry
            if (response.status !== 429 && response.status >= 400 && response.status < 500) {
              return { entity, name, category, fieldsEndpoint, accessible: false };
            }
            // 429 (rate limit) and 5xx → treat as transient, retry
            if (attempt === MAX_RETRIES) {
              return { entity, name, category, fieldsEndpoint, accessible: false };
            }
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }

          // Phase 2: Fetch fields if endpoint exists
          let fields: ProbeResult["fields"];
          if (fieldsEndpoint) {
            try {
              const fieldsUrl = `${getPipedriveV1Url()}/${fieldsEndpoint}`;
              const fieldsResponse = await fetch(fieldsUrl, { headers });
              if (fieldsResponse.ok) {
                const fieldsData = await fieldsResponse.json();
                if (fieldsData.success && Array.isArray(fieldsData.data)) {
                  fields = fieldsData.data.map(
                    (d: {
                      key: string;
                      name: string;
                      field_type: string;
                      mandatory_flag?: boolean;
                      options?: Array<{ id: number; label: string }>;
                    }) => ({
                      key: d.key,
                      name: d.name,
                      type: d.field_type,
                      required: d.mandatory_flag ?? false,
                      options: d.options,
                    })
                  );
                }
              }
            } catch {
              // Fields fetch failed — entity is still accessible, just without field metadata
            }
          }

          return { entity, name, category, fieldsEndpoint, accessible: true, fields };
        } catch {
          // Network error — retry
          if (attempt === MAX_RETRIES) {
            return { entity, name, category, fieldsEndpoint, accessible: false };
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      return { entity, name, category, fieldsEndpoint, accessible: false };
    };
  });

  const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

  const accessibleEntities = results.filter((r) => r.accessible);

  if (accessibleEntities.length === 0) {
    return {
      success: false,
      error:
        "Could not access any Pipedrive entities. Please ensure the API token has " +
        "the necessary permissions and your plan includes the features you want to use.",
    };
  }

  // Build category summary
  const categories: CategorySummary[] = ENTITY_CATEGORIES.map((cat) => {
    const catResults = results.filter((r) => r.category === cat.id);
    const accessible = catResults.filter((r) => r.accessible);
    return {
      id: cat.id,
      label: cat.label,
      accessible: accessible.length > 0,
      accessibleEntities: accessible.map((r) => r.name),
      totalEntities: cat.entities.length,
    };
  });

  const entities = accessibleEntities.map(({ entity, name, category, fields }) => ({
    entity,
    name,
    category,
    ...(fields ? { fields } : {}),
    operations: ENTITY_OPERATIONS[entity] ?? {
      read: true,
      create: false,
      update: false,
      delete: false,
    },
  }));
  const lastSyncAt = new Date().toISOString();
  const data = { entities, lastSyncAt };

  return {
    success: true,
    entities: entities.length,
    lastSyncAt,
    categories,
    data,
  };
}
