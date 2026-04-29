export interface OdooConnection {
  id: string;
  name: string;
  type: string;
  cannotDecrypt?: boolean;
  data: {
    models: Array<{
      model: string;
      name: string;
      access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
    }>;
    lastSyncAt: string;
  } | null;
}

/**
 * Auto-select a connection when exactly one Odoo connection exists.
 * Returns the connection id or null if manual selection is needed.
 */
export function autoSelectConnection(connections: OdooConnection[]): string | null {
  if (connections.length === 1) {
    return connections[0].id;
  }
  return null;
}
