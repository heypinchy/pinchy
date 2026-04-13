export type Permissions = Record<string, string[]>;

export function checkPermission(
  permissions: Permissions,
  entity: string,
  operation: string,
): boolean {
  return permissions[entity]?.includes(operation) ?? false;
}

export function getPermittedEntities(
  permissions: Permissions,
  operation: string,
): string[] {
  return Object.entries(permissions)
    .filter(([, ops]) => ops.includes(operation))
    .map(([entity]) => entity);
}
