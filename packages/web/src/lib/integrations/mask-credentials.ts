import { maskCredentials } from "./odoo-schema";
import { maskPipedriveCredentials } from "./pipedrive-schema";

/**
 * Returns masked credentials based on connection type.
 * - Odoo: returns { url, db, login } (strips apiKey and uid)
 * - Pipedrive: returns { companyDomain, companyName, userName } (strips apiToken)
 * - Web Search: returns { configured: true } (hides the API key entirely)
 */
export function maskConnectionCredentials(
  type: string,
  encryptedCredentials: string,
  decrypt: (ciphertext: string) => string
): Record<string, string | boolean | number> {
  if (type === "web-search") {
    return { configured: true };
  }
  if (type === "pipedrive") {
    return maskPipedriveCredentials(encryptedCredentials, decrypt);
  }
  // Default: Odoo-style masking
  return maskCredentials(encryptedCredentials, decrypt);
}
