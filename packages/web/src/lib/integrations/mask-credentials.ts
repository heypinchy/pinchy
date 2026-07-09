import { maskCredentials } from "./odoo-schema";

/**
 * Returns masked credentials based on connection type.
 * - Odoo: returns { url, db, login } (strips apiKey and uid)
 * - Web Search: returns { configured: true } (hides the API key entirely)
 * - IMAP: returns { imapHost, imapPort, smtpHost, smtpPort, username, security, senderName }
 *   (strips the password entirely; ports are coerced to strings to match the
 *   Record<string, string | boolean> return type; senderName defaults to "" when absent)
 */
export function maskConnectionCredentials(
  type: string,
  encryptedCredentials: string,
  decrypt: (ciphertext: string) => string
): Record<string, string | boolean> {
  if (type === "web-search") {
    return { configured: true };
  }
  if (type === "imap") {
    const parsed = JSON.parse(decrypt(encryptedCredentials));
    return {
      imapHost: String(parsed.imapHost ?? ""),
      imapPort: String(parsed.imapPort ?? ""),
      smtpHost: String(parsed.smtpHost ?? ""),
      smtpPort: String(parsed.smtpPort ?? ""),
      username: String(parsed.username ?? ""),
      security: String(parsed.security ?? ""),
      // Not a secret — the edit dialog needs it to prefill the From-header
      // display name field.
      senderName: String(parsed.senderName ?? ""),
    };
  }
  // Default: Odoo-style masking
  return maskCredentials(encryptedCredentials, decrypt);
}
