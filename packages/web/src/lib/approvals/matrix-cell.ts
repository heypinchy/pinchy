import { odooToolsForOperation, type ODOO_OPERATION_TOOLS } from "@/lib/tool-registry";
import { resolveConfirmation, type ConfirmMap } from "@/lib/approvals/policy";

export type AccessState = "off" | "ask" | "allow";
type Operation = keyof typeof ODOO_OPERATION_TOOLS;

/**
 * What one cell of the Odoo permission matrix shows.
 *
 * An untouched cell displays what it INHERITS from the tool level rather than
 * a blank, because the blank would be a lie about what happens: the gate
 * resolves inheritance whether or not the grid shows it, and an admin who has
 * gated `odoo_delete` should see the delete column reading "ask" on every model
 * without having ticked each one.
 *
 * A column speaks for several tools — `write` covers `odoo_write` and every
 * record action — so it reads "ask" when ANY of them would ask. Showing
 * "allow" while one of the tools still pauses would be the looser of the two
 * claims, and the wrong one to make on a security control.
 */
export function cellStateFor(
  confirm: ConfirmMap,
  model: string,
  operation: Operation,
  granted: boolean
): AccessState {
  if (!granted) return "off";
  const cfg = { "pinchy-approvals": { confirm } };
  const asks = odooToolsForOperation(operation).some(
    (tool) => resolveConfirmation(cfg, tool, [model]) === "confirm"
  );
  return asks ? "ask" : "allow";
}

/**
 * The confirmation map after an admin sets a cell.
 *
 * Both non-off states write an EXPLICIT key rather than clearing one. "Allow"
 * has to mean allow even when the tool level says ask — that exception is the
 * entire point of the per-model control ("ask before deleting an invoice, just
 * do it for a note"), and a cleared key would resolve straight back to ask.
 *
 * Turning a cell off leaves its keys behind on purpose. The permission is what
 * stops the call; the confirmation setting is a preference that should still be
 * there if the operation is granted again, rather than something the admin has
 * to rediscover.
 */
export function applyCellState(
  confirm: ConfirmMap,
  model: string,
  operation: Operation,
  next: AccessState
): ConfirmMap {
  if (next === "off") return confirm;
  const value = next === "ask" ? "confirm" : "allow";
  const updated = { ...confirm };
  for (const tool of odooToolsForOperation(operation)) updated[`${tool}:${model}`] = value;
  return updated;
}
