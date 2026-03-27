/**
 * Generate a UUID that works in both Secure and Insecure Contexts.
 *
 * crypto.randomUUID() is only available in Secure Contexts (HTTPS or localhost).
 * On plain HTTP with an IP address, we fall back to crypto.getRandomValues().
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16)
    );
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
