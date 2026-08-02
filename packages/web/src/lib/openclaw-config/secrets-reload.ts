import { getOpenClawClient } from "@/server/openclaw-client";

/**
 * OpenClaw's purpose-built "re-resolve the secrets you already hold" RPC
 * (`operator.admin` scope, and deliberately NOT a control-plane write — so it
 * costs none of the ~3-per-45s `config.apply` budget).
 */
const SECRETS_RELOAD_METHOD = "secrets.reload";

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
 * Why not simply force the `config.apply` through instead: it would not fix it.
 * OpenClaw commits a config write with `includeAuthStoreRefs: false` and carries
 * the previously-resolved auth-profile stores over verbatim — and Pinchy's
 * per-agent `auth-profiles.json` is exactly where an agent's provider key is
 * resolved from. `secrets.reload` re-prepares the WHOLE runtime snapshot
 * (config refs and auth stores), restarts the channels whose secrets moved, and
 * rolls back on failure. Forcing the apply would also spend a rate-limit slot
 * the no-op guard exists to protect.
 *
 * Fire-and-forget, like `pushConfigInBackground`: interactive save flows
 * must not block on an OpenClaw round trip. A failure here is loud but benign —
 * the new value is already on disk, so any later OpenClaw start reads it.
 * There is deliberately no retry: the only realistic reason the WS is down
 * inside the compose network is that OpenClaw is restarting, and a restarting
 * OpenClaw resolves the fresh file on its way up.
 */
export function reloadSecretsInBackground(): void {
  void (async () => {
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
      return;
    }
    // Deliberately NOT gated on `client.hasMethod`: the advertised-method list
    // is empty until the hello-ok handshake lands, so "this gateway is too old"
    // and "we just reconnected" look identical through it (see
    // createAgentReadinessGate for the same trap). Unobservable is not "no" —
    // and a gateway that really lacks the method answers with an error we
    // report exactly like any other refusal, so the check would buy nothing
    // and could silently skip a rotation on a gateway that supports it.
    try {
      // openclaw-node RESOLVES on an error response rather than rejecting, so
      // the `ok` flag has to be read: awaiting alone would report a refused
      // reload as a successful one, which is the class of lie #943 is about.
      const response = await client.request(SECRETS_RELOAD_METHOD);
      if (!response.ok) {
        console.warn(
          `[openclaw-config] ${SECRETS_RELOAD_METHOD} was refused by the gateway ` +
            `(${response.error?.message ?? "no reason given"}) — restart OpenClaw to apply the ` +
            "new credentials."
        );
        return;
      }
      console.log(
        `[openclaw-config] ${SECRETS_RELOAD_METHOD}: OpenClaw re-resolved its secrets from disk`
      );
    } catch (err) {
      console.warn(
        `[openclaw-config] ${SECRETS_RELOAD_METHOD} failed — restart OpenClaw to apply the new ` +
          "credentials:",
        err instanceof Error ? err.message : String(err)
      );
    }
  })();
}
