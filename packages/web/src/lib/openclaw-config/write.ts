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
  // the file is unreadable.
  //
  // Two outcomes after this loop:
  //   - ENOENT or parse error: returns {} (file genuinely missing or invalid
  //     — callers treat as cold-start).
  //   - Persistent EACCES: THROWS so callers can distinguish "file doesn't
  //     exist" from "file exists but unreadable". Returning {} here would
  //     conflate the two and let `regenerateOpenClawConfig` proceed with
  //     empty `existing`, stripping every OC-enriched field (meta,
  //     gateway.controlUi.*, non-pinchy plugins.entries, channels.telegram
  //     OC fields) and emitting a thin payload that triggers the inotify
  //     cascade documented in #314. Targeted writes already throw on
  //     empty `existing.gateway.mode`; this just surfaces the same race
  //     loudly one layer up. 5 × 100ms covers two chmod-loop ticks worst case.
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
          "— propagating to caller (must skip-and-retry the regenerate)"
        );
        throw err;
      }
      // Synchronous busy-wait. Async would change all caller signatures.
      const start = Date.now();
      while (Date.now() - start < 100) {
        // spin
      }
    }
  }
  // Unreachable — every branch of the loop either returns or throws.
  throw new Error("[openclaw-config] readExistingConfig: unreachable");
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

// OC 5.3 rate-limits config.apply (~3 calls per 45 s window). The error
// carries an explicit "retry after Ns" hint. A rate-limited apply ALWAYS
// carries a genuine diff (the no-op guard above already returns for
// semantically-equivalent configs), so dropping it silently loses real
// changes — most visibly a freshly-created agent that then never enters OC's
// runtime, so chat dispatch fails with `unknown agent id` indefinitely (the
// Odoo/email/web dispatch-probe flake; CI run 26837712634). Instead we wait
// out the advertised window and RETRY the same clean WS config.apply path —
// no file write, so no inotify drift. Only after a bounded retry budget do we
// fall back to a file write (accepting the drift) so the change is never lost.
const RATE_LIMIT_ERROR_FRAGMENT = "rate limit exceeded";
// Buffer added past OC's advertised reset so the window is actually clear when
// we retry (clock skew + the apply's own processing time).
const RATE_LIMIT_BUFFER_MS = 1_000;
// Used when the error has no parseable "retry after Ns" (defensive — every
// observed OC 5.3 rate-limit message includes it).
const RATE_LIMIT_FALLBACK_WAIT_MS = 10_000;
// Cap a single wait so a malformed/huge "retry after" can't park the coroutine
// for minutes. OC's window is ~45 s; 50 s covers it with headroom.
const RATE_LIMIT_MAX_WAIT_MS = 50_000;
// At most this many window-waits before the file-write fallback. Two covers
// the realistic worst case (our apply lands in a maxed window, waits it out,
// and a second batch of regens maxed the next one too) without parking the
// coroutine across more than ~100 s.
const MAX_RATE_LIMIT_RETRIES = 2;

/** Parse OC's "retry after Ns" hint into milliseconds, or null if absent. */
function parseRetryAfterMs(message: string): number | null {
  const match = /retry after (\d+)\s*s/i.exec(message);
  return match ? Number(match[1]) * 1000 : null;
}

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
// cleanly — the in-process SIGUSR1 case (~5–15 s) and the integration-test
// `docker compose restart openclaw` case (~10 s) finish quickly, but the
// FIRST-INSTALL secrets-bootstrap restart (config/start-openclaw.sh pkills and
// respawns the gateway, ~40 s) does NOT fit the old 30 s budget — that's the
// window the dispatch-probe agent-create config storm lands in
// (heypinchy/pinchy#464). With openclaw-node >= 0.12.1 rejecting in-flight
// requests immediately on close (instead of stalling to the 30 s request
// timeout), this wait is ACTIVE: it re-attempts config.get every ~2 s and lands
// the apply the instant OC is back, so a 60 s budget covers the ~40 s secrets
// restart with margin while staying bounded. After the budget exhausts the
// file-write fallback runs as before; by then any normal restart has completed
// and the write is safe (OC is genuinely down, not racing its own startup).
const WS_DISCONNECTED_ERROR_FRAGMENT = "Not connected to OpenClaw Gateway";
const NOT_CONNECTED_MAX_WAIT_MS = 60_000;
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
      console.log(
        `[openclaw-config] push gen=${String(generation)}: no WS client → file write (inotify; reload may lag)`
      );
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
    let rateLimitAttempts = 0;
    // Holds the OC-supplemented payload from the most recent successful
    // config.get(). Used when inotify file-write is the fallback so we
    // write content WITH meta and OC-managed fields — raw `newContent`
    // (no meta) triggers OC's missing-meta-before-write anomaly which can
    // prevent plugins (e.g. pinchy-docs) from loading correctly.
    let lastSupplemented: string | undefined;
    for (let i = 0; i < backoffsMs.length; i++) {
      // Check before each attempt — a newer pushConfigInBackground call
      // may have started while we were sleeping.
      if (generation !== _pushGeneration) {
        console.log(
          `[openclaw-config] push gen=${String(generation)}: superseded by newer push (gen=${String(_pushGeneration)}) before attempt ${String(i)}`
        );
        return;
      }
      try {
        const current = (await client.config.get()) as {
          hash: string;
          config?: Record<string, unknown>;
        };

        // Newer call started while we were awaiting config.get()
        if (generation !== _pushGeneration) {
          console.log(
            `[openclaw-config] push gen=${String(generation)}: superseded by newer push (gen=${String(_pushGeneration)}) during config.get`
          );
          return;
        }

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
            console.log(
              `[openclaw-config] push gen=${String(generation)}: OC config and file both lack meta → file write (cascade guard; inotify reload)`
            );
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
            console.log(
              `[openclaw-config] push gen=${String(generation)}: no-op skip (supplemented payload ≡ OC runtime)`
            );
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
        console.log(
          `[openclaw-config] push gen=${String(generation)}: applied via WS config.apply (in-process, synchronous runtime refresh)${rateLimitAttempts > 0 ? ` after ${String(rateLimitAttempts)} rate-limit wait(s)` : ""}`
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Rate-limit handling: OC 5.3 rejects apply calls over the budget with
        // an explicit "retry after Ns" hint. Because the no-op guard above
        // already returned for equivalent configs, a rate-limited apply always
        // carries a genuine pending change. Wait out the advertised window and
        // retry the SAME clean WS path — no file write, so no inotify drift
        // (the original reason for skipping the disk write). Only after the
        // bounded retry budget do we fall back to a file write so the change is
        // never permanently lost (a late, slightly-drifted config beats a
        // dropped agent that dispatch then rejects with `unknown agent id`).
        if (message.includes(RATE_LIMIT_ERROR_FRAGMENT)) {
          if (rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
            rateLimitAttempts++;
            const waitMs = Math.min(
              (parseRetryAfterMs(message) ?? RATE_LIMIT_FALLBACK_WAIT_MS) + RATE_LIMIT_BUFFER_MS,
              RATE_LIMIT_MAX_WAIT_MS
            );
            console.warn(
              `[openclaw-config] config.apply rate-limited; retrying via WS in ${String(waitMs)}ms (attempt ${String(rateLimitAttempts)}/${String(MAX_RATE_LIMIT_RETRIES)}):`,
              message
            );
            i--; // OC's reset hint, not a transient failure — don't burn a backoff slot
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          // Budget exhausted across multiple windows — disk-write fallback so
          // OC's file-watcher reloads the change. Accept the inotify drift;
          // losing the change entirely is worse.
          console.warn(
            `[openclaw-config] push gen=${String(generation)}: config.apply rate-limited past retry budget; writing file for inotify fallback (reload may lag):`,
            message
          );
          writeConfigAtomic(lastSupplemented ?? supplementPayloadWithFileFields(newContent));
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
            `[openclaw-config] push gen=${String(generation)}: background config.apply failed; writing to file for inotify (reload may lag):`,
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
