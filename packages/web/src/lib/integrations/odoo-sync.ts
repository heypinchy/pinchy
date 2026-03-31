import { OdooClient } from "odoo-node";

const RELEVANT_PREFIXES = [
  "sale.",
  "purchase.",
  "stock.",
  "product.",
  "res.partner",
  "res.company",
  "account.",
  "crm.",
  "mail.",
  "hr.",
  "helpdesk.",
  "note.",
];

export interface OdooSyncResult {
  success: true;
  models: number;
  lastSyncAt: string;
  data: { models: Array<{ model: string; name: string; fields: unknown[] }>; lastSyncAt: string };
}

export interface OdooSyncError {
  success: false;
  error: string;
}

/**
 * Fetch schema (models + fields) from an Odoo instance.
 * Does NOT save anything — returns the data for the caller to handle.
 */
export async function fetchOdooSchema(credentials: {
  url: string;
  db: string;
  uid: number;
  apiKey: string;
}): Promise<OdooSyncResult | OdooSyncError> {
  const client = new OdooClient({
    url: credentials.url,
    db: credentials.db,
    uid: credentials.uid,
    apiKey: credentials.apiKey,
  });

  let allModels;
  try {
    allModels = await client.models();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("ir.model") || msg.includes("Access")) {
      return {
        success: false,
        error:
          "The Odoo user does not have permission to read model definitions (ir.model). " +
          "Please grant the user 'Settings / Access Rights' permissions in Odoo.",
      };
    }
    return { success: false, error: msg };
  }

  const relevantModels = allModels.filter((m) =>
    RELEVANT_PREFIXES.some((prefix) => m.model.startsWith(prefix))
  );

  const models = await Promise.all(
    relevantModels.map(async (m) => {
      try {
        const fields = await client.fields(m.model);
        return { model: m.model, name: m.name, fields };
      } catch {
        return { model: m.model, name: m.name, fields: [] };
      }
    })
  );

  const lastSyncAt = new Date().toISOString();
  const data = { models, lastSyncAt };

  return { success: true, models: models.length, lastSyncAt, data };
}
