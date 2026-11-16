import { getOpenClawClient } from "@/server/openclaw-client";
import { forgetSecretsWrite } from "@/lib/openclaw-secrets";
import {
  configWriteInFlight,
  getPendingConfigPushCount,
  trackConfigWrite,
} from "@/lib/openclaw-config/push-state";

/**
 * OpenClaw's purpose-built "re-resolve the secrets you already hold" RPC
 * (`operator.admin` scope, and deliberately NOT a control-plane write — so it
 * costs none of the ~3-per-45s `config.apply` budget).
 */
const NOT_CONNECTED = /^Not connected to OpenClaw Gateway/;
const SECRETS_RELOAD_METHOD = "secrets.reload";

/**
 * How long a reload waits for the config writes ahead of it before it is sent
 * anyway — the same bound a push gives the write in flight (write.ts,
 * CONFIG_WRITE_MAX_WAIT_MS), so a gateway that never answers cannot strand a
 * key rotation.
 */
const RELOAD_MAX_WAIT_MS = 15_000;

/** How often a reload looks again while a push is between its wait and its write. */
const PENDING_PUSH_POLL_MS = 250;

interface ReloadQueueState {
  /** A reload is waiting for its turn; later requests ride on it. */
  waiting: boolean;
}

// On globalThis for the same reason as push-state: route bundles and the
// custom server each load their own copy of this module, and the queue has to
// be one per process.
const QUEUE_KEY = Symbol.for("pinchy.openclawConfig.secretsReloadQueue");

function queue(): ReloadQueueState {
  const g = globalThis as unknown as Record<symbol, ReloadQueueState | undefined>;
  return (g[QUEUE_KEY] ??= { waiting: false });
}

/** Test-only: forget a reload left waiting by a previous test. */
export function _resetSecretsReloadQueue(): void {
  queue().waiting = false;
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * No config write in flight and no push between its wait and its write. A
 * pending push counts because it reads config.get after its own wait and
 * before its config.apply; a reload sent into that gap would run alongside
 * the apply.
 */
function configWritesQuiet(): boolean {
  return !configWriteInFlight() && getPendingConfigPushCount() === 0;
}

/**
 * Tells the running OpenClaw to drop the secret values it resolved at process
 * start and re-read them from `/openclaw-secrets/secrets.json`.
 *
 * Why this exists at all (#943): rotating the API key of an ALREADY-configured
 * provider changes the secrets file and nothing else. `openclaw.json` holds a
 * SecretRef, not the value, so the emitted config stays byte-identical, every
 * no-op guard on the way to `config.apply` correctly fires, and OpenClaw keeps
 * serving the old — now revoked — credential until someone restarts the
 * container. Every agent answers HTTP 401 in the meantime.
 *
 * Why not simply force the `config.apply` through instead: the provider key is
 * a SecretRef (`models.providers.<p>.apiKey`) in a file that did not change,
 * and `secrets.reload` is the RPC OpenClaw provides for exactly this. It
 * re-prepares the WHOLE runtime snapshot (config refs and auth stores),
 * restarts the channels whose secrets moved, and
 * rolls back on failure. Forcing the apply would also spend a rate-limit slot
 * the no-op guard exists to protect.
 *
 * One config write at a time: OpenClaw 2026.9 restarts the gateway when the
 * secrets snapshot changes under a hot reload that is replacing plugin
 * services — the reload fails as stale, and the teardown of the half-replaced
 * services is booked as "plugin service replacement teardown failed before
 * config commit: runtime secrets changed while config hot reload was deferred;
 * restarting gateway" (server-reload-managed, scheduleRecoveryRestart;
 * staging, 2026-11-16: three reloads beside the apply for six new agents). So
 * a reload waits for the config write in flight and for any push that has
 * started but not yet sent its write, then claims the slot itself
 * (trackConfigWrite) in the same synchronous turn it found the writes quiet —
 * a regenerate asks for the reload and starts its push in one turn, and the
 * push checks for a write in flight in that turn too. The next push waits for
 * the reload. Requests made while one reload waits ride on it — it reads the
 * file as it is when it is sent; a request made while one is in flight
 * queues one more, because that reload may have read the file before the
 * write that asked for this one.
 *
 * Fire-and-forget, like `pushConfigInBackground`: interactive save flows
 * must not block on an OpenClaw round trip. A failure here is loud but benign —
 * the new value is already on disk, so any later OpenClaw start reads it.
 * There is no retry on a timer: the only realistic reason the WS is down
 * inside the compose network is that OpenClaw is restarting, and a restarting
 * OpenClaw resolves the fresh file on its way up. A reload that did not land
 * forgets the write record (forgetSecretsWrite), so the next regenerate asks
 * again instead of judging the file as already delivered.
 */
export function reloadSecretsInBackground(): void {
  const q = queue();
  if (q.waiting) return;
  if (configWritesQuiet()) {
    sendReload();
    return;
  }
  q.waiting = true;
  void (async () => {
    const deadline = Date.now() + RELOAD_MAX_WAIT_MS;
    try {
      for (;;) {
        const write = configWriteInFlight();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          console.warn(
            write
              ? `[openclaw-config] ${SECRETS_RELOAD_METHOD}: a config write is still unanswered ` +
                  `after ${String(RELOAD_MAX_WAIT_MS)}ms; sending the reload beside it`
              : `[openclaw-config] ${SECRETS_RELOAD_METHOD}: a config push has not sent its ` +
                  `write after ${String(RELOAD_MAX_WAIT_MS)}ms; sending the reload anyway`
          );
          break;
        }
        const timer = delay(write ? remaining : Math.min(PENDING_PUSH_POLL_MS, remaining));
        try {
          await (write ? Promise.race([write, timer.promise]) : timer.promise);
        } finally {
          timer.cancel();
        }
        if (configWritesQuiet()) break;
      }
    } finally {
      q.waiting = false;
    }
    // No await between the last check and the claim in sendReload.
    sendReload();
  })();
}

/**
 * Send the reload and, unless a write is still in flight (the wait was capped),
 * claim the write slot with it — synchronously, so a push started later in
 * this turn waits for it. Over a live write the reload goes out untracked:
 * taking the slot would hide that write from every later push.
 */
function sendReload(): void {
  let client;
  try {
    client = getOpenClawClient();
  } catch {
    client = undefined;
  }
  if (!client) {
    // Deliberately worded for BOTH cases this branch really sees. The common
    // one is a cold start: `/openclaw-secrets` is a tmpfs, so every container
    // restart writes the bundle afresh while the WS is still coming up — and
    // there "agents are stuck on the old key" would simply be untrue. The
    // other is a rotation while OpenClaw is down, where the wait is real.
    console.warn(
      "[openclaw-config] secrets changed but no WS client is connected. The values are on " +
        "disk and OpenClaw resolves them when it starts; a gateway that is already running " +
        "keeps the credentials it resolved at ITS start until then."
    );
    forgetSecretsWrite();
    return;
  }
  // Deliberately NOT gated on `client.hasMethod`: the advertised-method list
  // is empty until the hello-ok handshake lands, so "this gateway is too old"
  // and "we just reconnected" look identical through it (see
  // createAgentReadinessGate for the same trap). Unobservable is not "no" —
  // and a gateway that really lacks the method answers with an error we
  // report exactly like any other refusal, so the check would buy nothing
  // and could silently skip a rotation on a gateway that supports it.
  let request: ReturnType<typeof client.request>;
  try {
    request = client.request(SECRETS_RELOAD_METHOD);
  } catch (err) {
    request = Promise.reject(err);
  }
  const reply = configWriteInFlight() ? request : trackConfigWrite(request);
  void (async () => {
    try {
      // openclaw-node rejects the request when OpenClaw answers ok:false,
      // carrying the gateway's message; a dropped socket rejects with
      // "Not connected to OpenClaw Gateway". Only the first is a refusal.
      await reply;
      console.log(
        `[openclaw-config] ${SECRETS_RELOAD_METHOD}: OpenClaw re-resolved its secrets from disk`
      );
    } catch (err) {
      forgetSecretsWrite();
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_CONNECTED.test(message)) {
        console.warn(
          `[openclaw-config] ${SECRETS_RELOAD_METHOD} failed — restart OpenClaw to apply the new ` +
            "credentials:",
          message
        );
        return;
      }
      // OpenClaw answers every failed reload alike ("secrets.reload failed"),
      // one a concurrent config change superseded included — and that
      // change's own reload resolves the new credentials. Only its log says
      // which, so the warning points there instead of calling for a restart.
      console.warn(
        `[openclaw-config] ${SECRETS_RELOAD_METHOD} was refused by the gateway ` +
          `(${message || "no reason given"}). OpenClaw's log names the cause: ` +
          "if a config change superseded the reload, that change's reload applies the new " +
          "credentials; otherwise restart OpenClaw to apply them."
      );
    }
  })();
}
