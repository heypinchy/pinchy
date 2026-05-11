import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";

export async function probeIntegrationCredentials(
  type: string,
  credentials: Record<string, unknown>
): Promise<{ success: true } | { success: false; reason: string }> {
  if (type === "odoo") {
    const parsed = odooCredentialsSchema.safeParse(credentials);
    if (!parsed.success) return { success: false, reason: "Invalid credentials format" };
    const result = await fetchOdooSchema(parsed.data);
    if (!result.success) return { success: false, reason: result.error };
    return { success: true };
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
