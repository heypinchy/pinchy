export type Permissions = Record<string, string[]>;

/**
 * Legacy alias: pre-Pinchy-#328 agent template creation could persist a
 * standalone (model="email", operation="search") OR (model="email",
 * operation="list") permission row with NO accompanying "read" row
 * (per-tool operations — list/read/search/draft — were written straight
 * from tool IDs before the write path was normalized to semantic
 * operations). build.ts passes DB rows through into the plugin config's
 * `permissions` object as-is, so a stale, not-yet-regenerated config can
 * still carry `{ email: ["search"] }` or `{ email: ["list"] }` today. Treat
 * a granted "search" or "list" operation as satisfying a "read" check so
 * email_list/email_read/email_search/email_get_attachment keep working for
 * those agents. This is intentionally narrow: it only widens what counts as
 * "read" — it must NOT make "search" or "list" satisfy "draft" or "send".
 */
function hasLegacyReadAlias(permissions: Permissions, model: string, operation: string) {
  return (
    operation === "read" &&
    ((permissions[model]?.includes("search") ?? false) ||
      (permissions[model]?.includes("list") ?? false))
  );
}

export function checkPermission(
  permissions: Permissions,
  model: string,
  operation: string
): boolean {
  return (
    (permissions[model]?.includes(operation) ?? false) ||
    hasLegacyReadAlias(permissions, model, operation)
  );
}

export function getPermittedOperations(permissions: Permissions, model: string): string[] {
  return permissions[model] ?? [];
}
