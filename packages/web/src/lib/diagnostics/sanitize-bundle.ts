import { redactPatterns } from "@/lib/audit-sanitize";

export function sanitizeBundle<T>(input: T): T {
  return sanitizeValue(input) as T;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactPatterns(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeValue(v)])
    );
  }
  return value;
}
