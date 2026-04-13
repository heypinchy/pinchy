import { maskCredentials } from "./odoo-schema";

/**
 * Returns masked credentials based on connection type.
 * - Odoo: returns { url, db, login } (strips apiKey and uid)
 * - Web Search: returns { configured: true } (hides the API key entirely)
 */
export function maskConnectionCredentials(
  type: string,
  encryptedCredentials: string,
  decrypt: (ciphertext: string) => string
): Record<string, string | boolean> {
  if (type === "web-search") {
    return { configured: true };
  }
  // Default: Odoo-style masking
  return maskCredentials(encryptedCredentials, decrypt);
}
