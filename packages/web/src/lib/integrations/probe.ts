import { OdooClient } from "odoo-node";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";

/**
 * Verify that credentials work for the given integration type.
 *
 * On success may return `freshCredentials` — values resolved during the probe
 * that the caller should persist (e.g. Odoo's `uid` after a `login` change).
 */
export type ProbeResult =
  | { success: true; freshCredentials?: Record<string, unknown> }
  | { success: false; reason: string };

export async function probeIntegrationCredentials(
  type: string,
  credentials: Record<string, unknown>
): Promise<ProbeResult> {
  if (type === "odoo") {
    const parsed = odooCredentialsSchema.safeParse(credentials);
    if (!parsed.success) return { success: false, reason: "Invalid credentials format" };

    // Re-authenticate so we (a) verify the login/apiKey actually work and
    // (b) refresh the stored uid in case the login changed. Without this
    // step, a wrong login or apiKey would surface as the opaque "Could not
    // access any Odoo models" error from the model probe below — because
    // the probe runs with a stale uid against the new key.
    let uid: number;
    try {
      uid = await OdooClient.authenticate({
        url: parsed.data.url,
        db: parsed.data.db,
        login: parsed.data.login,
        apiKey: parsed.data.apiKey,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        reason: `Authentication failed. Please verify your login and API key. (${detail})`,
      };
    }

    const result = await fetchOdooSchema({ ...parsed.data, uid });
    if (!result.success) return { success: false, reason: result.error };
    return { success: true, freshCredentials: { uid } };
  }

  if (type === "web-search") {
    const apiKey = credentials.apiKey;
    if (typeof apiKey !== "string" || !apiKey) {
      return { success: false, reason: "apiKey is required" };
    }
    return probeBraveApiKey(apiKey);
  }

  return { success: false, reason: `Cannot probe credentials for unknown type: ${type}` };
}
