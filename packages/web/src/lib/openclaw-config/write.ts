import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { assertNoPlaintextSecrets } from "@/lib/openclaw-plaintext-scanner";
import { getOpenClawClient } from "@/server/openclaw-client";
import { supplementPayloadWithOcConfig, supplementPayloadWithFileFields } from "./normalize";
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
  writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o644 });
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
// apply() RPC — once that call starts, it runs to completion. That is fine
// because writeConfigAtomic ran synchronously before pushConfigInBackground, so
// the file is the canonical source: a newer call's payload simply overwrites.
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

export function pushConfigInBackground(newContent: string): void {
  const generation = ++_pushGeneration;

  void (async () => {
    let client;
    try {
      client = getOpenClawClient();
    } catch {
      // No client — file write + inotify is the only path here.
      return;
    }

    // Brief retry across transient WS disconnects. Beyond ~3.5 s the WS is
    // probably down due to the cold-start cascade, and inotify will catch
    // up; no point keeping a background coroutine alive longer.
    const backoffsMs = [100, 250, 500, 1000, 2000];
    let staleHashAttempts = 0;
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
        // → SIGUSR1 restart cascade. inotify picks up the file write instead.
        if (current.config) {
          const parsed = JSON.parse(supplemented) as Record<string, unknown>;
          if (!("meta" in parsed)) {
            return;
          }
        }

        await client.config.apply(supplemented, current.hash, {
          note: "pinchy: regenerateOpenClawConfig",
        });
        // Note: there is no generation guard here. An in-flight apply() from a
        // stale call cannot be cancelled at this point — but the file write
        // (writeConfigAtomic) ran synchronously before pushConfigInBackground,
        // so it is the canonical state. A newer call's payload will overwrite.
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

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

        if (i === backoffsMs.length - 1) {
          console.warn(
            "[openclaw-config] background config.apply failed; relying on inotify:",
            message
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, backoffsMs[i]));
      }
    }
  })();
}
