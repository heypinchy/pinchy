export type Permissions = Record<string, string[]>;

export function checkPermission(
  permissions: Permissions,
  model: string,
  operation: string,
): boolean {
  return permissions[model]?.includes(operation) ?? false;
}

export function getPermittedOperations(
  permissions: Permissions,
  model: string,
): string[] {
  return permissions[model] ?? [];
}
