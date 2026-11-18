/**
 * Lists in an audit detail are capped: past this many entries they collapse to
 * `{ count }`. A detail over 2048 bytes is replaced wholesale by a truncation
 * summary (truncateDetail in lib/audit.ts), which would drop the ids and names
 * next to the list too — the part an analyst filters on.
 */
export const MAX_LIST_ITEMS_IN_AUDIT = 20;

/** `items` as-is up to {@link MAX_LIST_ITEMS_IN_AUDIT}, otherwise `{ count }`. */
export function summarizeListForAudit<T>(items: T[]): T[] | { count: number } {
  return items.length > MAX_LIST_ITEMS_IN_AUDIT ? { count: items.length } : items;
}
