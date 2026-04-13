export type Permissions = Record<string, string[]>;

export function checkPermission(
  permissions: Permissions,
  model: string,
  operation: string,
): boolean {
  return permissions[model]?.includes(operation) ?? false;
}

export function getPermittedModels(
  permissions: Permissions,
  operation: string,
): string[] {
  return Object.entries(permissions)
    .filter(([, ops]) => ops.includes(operation))
    .map(([model]) => model);
}
