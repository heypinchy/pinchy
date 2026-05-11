import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { assertNoPlaintextSecrets } from "@/lib/openclaw-plaintext-scanner";
import { getOpenClawClient } from "@/server/openclaw-client";
import {
  supplementPayloadWithOcConfig,
  supplementPayloadWithFileFields,
  configsAreEquivalentUpToOpenClawMetadata,
} from "./normalize";
import { CONFIG_PATH } from "./paths";

/** Atomic write: tmp file + rename to prevent OpenClaw reading a truncated config */
export function writeConfigAtomic(content: string) {
  const dir = dirname(CONFIG_PATH);
  // existsSync returns false for both "doesn't exist" and "stat failed because
  // of permissions on the parent". On the production image the directory is a
  // mounted volume and always exists; only attempt mkdir when the parent is
  // actually missing, and treat EACCES/EEXIST as "directory is there, proceed".
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EACCES") throw err;
    }
  }
  // Defense-in-depth: never let a plaintext secret land in openclaw.json.
  assertNoPlaintextSecrets(JSON.parse(content));
  const tmpPath = CONFIG_PATH + ".tmp";
  // Mode 0o666: Pinchy and OpenClaw both need read/write access. OpenClaw
  // rewrites the file as root:0600 on every internal SIGUSR1 restart and
  // relies on start-openclaw.sh's tight chmod-loop to restore 666 within
  // ~200 ms, which races the Docker smoke test's permissions check. Pinchy
  // writes are within OUR control — emit 666 directly so we don't add to
  // the chmod-loop's burden. (Production: shared volume mode 666 is fine
  // because the volume itself is namespaced inside Docker; not exposed.)
  writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o666 });
  renameSync(tmpPath, CONFIG_PATH);
}

export function readExistingConfig(): Record<string, unknown> {
  // Retry briefly on EACCES. OpenClaw rewrites openclaw.json as root:0600 on
  // every internal SIGUSR1 restart; start-openclaw.sh's 3s chmod loop opens
  // it back up to 0666, but Pinchy (uid 999) can hit a small window where
  // the file is unreadable. Without retry, readFileSync throws → catch
  // returns {} → targeted writes (updateTelegramChannelConfig etc.) would
  // produce a config WITHOUT the gateway block, and OpenClaw's next start
  // refuses with "Gateway start blocked: existing config is missing
  // gateway.mode". 5 × 100ms covers two chmod-loop ticks worst case.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EACCES") {
        // ENOENT (file not yet written) is a normal cold-start case; other
        // errors (parse failures, etc.) are bugs we can't paper over here.
        return {};
      }
      if (attempt === 4) {
        console.warn(
          "[openclaw-config] readExistingConfig: persistent EACCES on",
          CONFIG_PATH,
          "— returning empty (callers must guard against partial writes)"
        );
        return {};
      }
      // Synchronous busy-wait. Async would change all caller signatures.
      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }
    }
  }
  return {};
}

// Monotonically-increasing counter that lets each pushConfigInBackground call
// cancel any pending retries from an older call. Because regenerateOpenClawConfig
// can be triggered concurrently (e.g. setup → connectBot → warmup agent create →
// actual agent create all in quick succession with a slow CI event loop), the
// retry window of an early call can extend into a later one's territory.
//
// Cancellation scope: the counter is checked between awaits in the retry loop
// and again right before client.config.apply(). It does NOT cancel an in-flight
// apply() RPC — once that call starts, it runs to completion. The newer call's
// payload simply overwrites through its own config.apply or writeConfigAtomic.
let _pushGeneration = 0;

/** Exposed only for unit-testing the cancellation path; do not call in app code. */
export function _resetPushGeneration() {
  _pushGeneration = 0;
}

// OC's explicit recovery hint when the file-watcher reloaded openclaw.json
// between our config.get and config.apply: the hash we sent is no longer
// the latest. Refetch the hash and retry IMMEDIATELY — going through the
// generic 100/250/500ms backoff stacks the retry window into the next
// pushConfigInBackground call's territory and the apply never lands
// (#193, agent-create-no-restart.spec.ts CI flake).
const STALE_HASH_ERROR_FRAGMENT = "config changed since last load";
const MAX_STALE_HASH_RETRIES = 3;

// OC 5.3 rate-limits config.apply (~3 calls per 45 s window). Consuming
// backoff slots on each rejection just delays the eventual file-write
// fallback by up to 3.85 s for no benefit — fall through to inotify
// immediately instead.
const RATE_LIMIT_ERROR_FRAGMENT = "rate limit exceeded";

// Pinchy's WS client throws this when config.get()/apply() runs while OC is
// mid-restart (a successful config.apply triggered SIGUSR1, OC is relaunching
// in-process, the WS is dropped). Default backoff (~3.85 s) is shorter than
// any plausible restart and ends in writeConfigAtomic — that disk write races
// OC's startup-time `ensureGatewayStartupAuth → replaceConfigFile`, which
// asserts the file's hash hasn't changed since the start of restart, and OC
// fails startup with `ConfigMutationConflictError: config changed since last
// load` (Telegram E2E `agent-create-no-restart.spec.ts` cascade — the spec's
// own header explicitly names this failure mode). Extending the retry budget
// here lets the WS reconnect so the next iteration's config.apply lands
// cleanly — both the in-process SIGUSR1 case (~5–15 s) and the integration-
// test `docker compose restart openclaw` case (~10 s) finish well inside the
// 30 s budget. After the budget exhausts the file-write fallback runs as
// before; by that point any normal restart has completed and the write is
// safe (OC is genuinely down, not racing its own startup).
const WS_DISCONNECTED_ERROR_FRAGMENT = "Not connected to OpenClaw Gateway";
const NOT_CONNECTED_MAX_WAIT_MS = 30_000;
const NOT_CONNECTED_RETRY_DELAY_MS = 2_000;

export function pushConfigInBackground(newContent: string): void {
  const generation = ++_pushGeneration;

  void (async () => {
    let client;
    try {
      client = getOpenClawClient();
    } catch {
      client = undefined;
    }
    if (!client) {
      // No WS client — write directly to file so inotify picks up the change.
      // This path runs synchronously (no await before writeConfigAtomic), so the
      // file is on disk before regenerateOpenClawConfig() returns to its caller.
      writeConfigAtomic(newContent);
      return;
    }

    // Security check: assertNoPlaintextSecrets is called inside writeConfigAtomic
    // for the no-client path above. For the WS path we skip the direct file write
    // to eliminate the inotify race with config.apply (openclaw#75534): writing
    // the file before config.apply triggers the chokidar watcher, which updates
    // currentCompareConfig to the raw Pinchy payload. config.apply then writes a
    // slightly different file (OC's merge transforms it), so the reload handler
    // detects a diff including gateway/discovery/update/canvasHost and triggers a
    // gateway restart — causing ConfigMutationConflictError when ensureGatewayStartupAuth
    // tries to write with a stale initialSnapshotRead hash.
    // Without the prior file write, currentCompareConfig stays as startup_source;
    // config.apply's output only differs in agents/plugins/secrets — no restart.
    assertNoPlaintextSecrets(JSON.parse(newContent));

    // Brief retry across transient WS disconnects. Beyond ~3.5 s the WS is
    // probably down due to the cold-start cascade, and inotify will catch
    // up; no point keeping a background coroutine alive longer.
    // EXCEPTION: for "Not connected" specifically we extend the wait via
    // notConnectedWaitMs below, since 3.5 s is shorter than any normal OC
    // restart and the resulting writeConfigAtomic races OC's startup auth.
    const backoffsMs = [100, 250, 500, 1000, 2000];
    let staleHashAttempts = 0;
    let notConnectedWaitMs = 0;
    // Holds the OC-supplemented payload from the most recent successful
    // config.get(). Used when inotify file-write is the fallback so we
    // write content WITH meta and OC-managed fields — raw `newContent`
    // (no meta) triggers OC's missing-meta-before-write anomaly which can
    // prevent plugins (e.g. pinchy-docs) from loading correctly.
    let lastSupplemented: string | undefined;
    for (let i = 0; i < backoffsMs.length; i++) {
      // Check before each attempt — a newer pushConfigInBackground call
      // may have started while we were sleeping.
      if (generation !== _pushGeneration) return;
      try {
        const current = (await client.config.get()) as {
          hash: string;
          config?: Record<string, unknown>;
        };

        // Newer call started while we were awaiting config.get()
        if (generation !== _pushGeneration) return;

        // Supplement OC-managed fields (meta, non-pinchy plugins, controlUi,
        // channels.telegram OC-specific fields, models.providers baseUrl).
        // Prefer the live in-memory config (avoids file-write races after restart).
        let supplemented = current.config
          ? supplementPayloadWithOcConfig(newContent, current.config)
          : supplementPayloadWithFileFields(newContent);

        // Meta-fallback: OC's in-memory config may lack meta immediately after a
        // SIGUSR1 restart (before OC stamps it). The previous file still has meta;
        // read it as a fallback so config.apply doesn't trigger a cascade restart.
        if (current.config) {
          const parsed = JSON.parse(supplemented) as Record<string, unknown>;
          if (!("meta" in parsed)) {
            supplemented = supplementPayloadWithFileFields(supplemented);
          }
        }

        // Meta-guard: if OC is running (current.config defined) but neither the
        // in-memory config nor the file could supply meta, skip config.apply.
        // A meta-less payload triggers OC's "missing-meta-before-write" anomaly
        // → SIGUSR1 restart cascade. Fall back to inotify via file write.
        if (current.config) {
          const parsed = JSON.parse(supplemented) as Record<string, unknown>;
          if (!("meta" in parsed)) {
            writeConfigAtomic(newContent);
            return;
          }
        }

        // No-op guard: skip config.apply entirely if the supplemented payload
        // is semantically equivalent to OC's current in-memory config. OC 5.3
        // rate-limits config.apply at ~3 calls per 45 s window
        // (control-plane-write-rate-limited); a no-op apply still consumes
        // a slot. With `regenerateOpenClawConfig()` now running unconditionally
        // on boot AND on every settings/agent mutation, back-to-back regens
        // can pile 4+ applies into the rate-limit window — the bootInits
        // alignment + setup-wizard + connectBot + warmup chain in the Telegram
        // E2E setup is exactly that shape. The early-return guard in build.ts
        // (`configsAreEquivalentUpToOpenClawMetadata` against the file) catches
        // file-vs-payload no-ops, but it can't see the SUPPLEMENTED payload —
        // which is what config.apply actually sends, and which might be
        // identical to OC's runtime even when raw newContent isn't. Compare
        // here to skip the wasted slot.
        if (current.config) {
          const supplementedConfig = JSON.parse(supplemented) as Record<string, unknown>;
          if (
            configsAreEquivalentUpToOpenClawMetadata(
              JSON.stringify(current.config, null, 2),
              JSON.stringify(supplementedConfig, null, 2)
            )
          ) {
            return;
          }
        }

        lastSupplemented = supplemented;
        await client.config.apply(supplemented, current.hash, {
          note: "pinchy: regenerateOpenClawConfig",
        });
        // config.apply's inner writeConfigFile persists the config to disk.
        // A newer call's payload will overwrite via its own config.apply or
        // writeConfigAtomic fallback.
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Rate-limit bypass: OC 5.3 rejects apply calls over the budget.
        // OC already has the correct config in memory from the last successful
        // config.apply — no file write needed. Writing to disk (even with meta)
        // triggers an inotify hot-reload that causes OC to add built-in plugin
        // entries (e.g. memory-core) and reorder keys, producing spurious drift
        // in the config file. The next config.apply (after the 45 s window
        // resets) will deliver any pending changes.
        if (message.includes(RATE_LIMIT_ERROR_FRAGMENT)) {
          return;
        }

        // Stale-hash bypass: OC explicitly tells us "re-run config.get and
        // retry". Don't sleep on backoff — a fresh get+apply on the next
        // iteration is the entire fix. Cap the budget so a genuinely-stuck
        // gateway doesn't hot-loop; inotify is the safety net.
        if (
          message.includes(STALE_HASH_ERROR_FRAGMENT) &&
          staleHashAttempts < MAX_STALE_HASH_RETRIES
        ) {
          staleHashAttempts++;
          i--; // don't consume a backoff slot for OC's recovery hint
          continue;
        }

        // WS-disconnected extended wait: see WS_DISCONNECTED_ERROR_FRAGMENT
        // commentary above. Sleep 2 s without consuming a backoff slot, up to
        // 30 s total, so the WS reconnect during OC's restart lands the next
        // config.apply via WS instead of via writeConfigAtomic-into-restart.
        if (
          message.includes(WS_DISCONNECTED_ERROR_FRAGMENT) &&
          notConnectedWaitMs < NOT_CONNECTED_MAX_WAIT_MS
        ) {
          notConnectedWaitMs += NOT_CONNECTED_RETRY_DELAY_MS;
          i--; // don't consume a backoff slot
          await new Promise((resolve) => setTimeout(resolve, NOT_CONNECTED_RETRY_DELAY_MS));
          continue;
        }

        if (i === backoffsMs.length - 1) {
          console.warn(
            "[openclaw-config] background config.apply failed; writing to file for inotify:",
            message
          );
          // All retries exhausted — fall back to file write so inotify picks up
          // the change. Same meta-preservation logic as the rate-limit path above.
          writeConfigAtomic(lastSupplemented ?? supplementPayloadWithFileFields(newContent));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, backoffsMs[i]));
      }
    }
  })();
}
