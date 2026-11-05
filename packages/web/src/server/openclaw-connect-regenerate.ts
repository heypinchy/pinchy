import {
  fileOnlyDeliveryPending,
  getPendingConfigPushCount,
  undeliveredConfigChange,
} from "@/lib/openclaw-config/push-state";

/**
 * The regenerate a connection to OpenClaw owes, run from server.ts's
 * `connected` handler (which fires on the first connect and on every reconnect).
 *
 * The first connect pushes the full config via config.apply. This seeds OC's
 * currentCompareConfig with the complete Pinchy payload so subsequent
 * config.apply calls show only field-level diffs — not a massive diff against
 * the baked-in startup config that triggers gateway/discovery/update/canvasHost
 * restart rules (openclaw#75534, PR #279).
 *
 * A reconnect regenerates only when a push gave up on a change while OpenClaw
 * was unreachable (noteUndeliveredConfigChange in push-state.ts): a file write
 * refused under OpenClaw's read-side line, or a provider deletion that could
 * not reach it. Nothing else resends that change — a Telegram bot removed for
 * everyone would otherwise resume polling the moment OpenClaw came back. The
 * regenerate rebuilds everything from the database, and the debt is settled
 * once its config reaches OpenClaw — pushed, or found already in openclaw.json
 * (noteFullRegenerateDelivered).
 *
 * It also regenerates when a push could reach OpenClaw only by writing
 * openclaw.json (noteFileOnlyDelivery): OpenClaw may have been running but not
 * yet connected, and a running OpenClaw does not reliably reload that file. The
 * regenerate pushes it, because build.ts does not take the file for the
 * runtime until a config.apply has landed. Not while a push is still in
 * flight: that one retries over the new connection and settles it when its
 * apply lands, and a second apply could restart OpenClaw into another
 * reconnect. Should it end without an apply, the next regenerate delivers the
 * change (see noteFileOnlyDelivery).
 *
 * Every other reconnect runs none, to prevent a cascade: if a push triggers an
 * OC restart (large diff on fresh install), the reconnect after it must not
 * fire it again. A debt cannot loop either: a regenerate whose config reaches
 * OpenClaw settles it before the restart that config may cause.
 */
export function regenerateOnConnect(
  { firstConnect }: { firstConnect: boolean },
  regenerate: () => Promise<void>
): void {
  if (!firstConnect) {
    if (undeliveredConfigChange()) {
      console.log(
        "[server] OpenClaw reconnected with a config change Pinchy could not deliver while it was unreachable; regenerating"
      );
    } else if (fileOnlyDeliveryPending() && getPendingConfigPushCount() === 0) {
      console.log(
        "[server] OpenClaw reconnected after a config change reached only openclaw.json; regenerating to push it to the runtime"
      );
    } else {
      return;
    }
  }
  regenerate().catch((err: unknown) => {
    console.warn("[server] on-connected regenerateOpenClawConfig failed:", err);
  });
}
