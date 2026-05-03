import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { assertNoPlaintextSecrets } from "@/lib/openclaw-plaintext-scanner";
import { getOpenClawClient } from "@/server/openclaw-client";
import { CONFIG_PATH } from "./paths";
import {
  redactUnchangedEnvForApply,
  supplementPayloadWithFileFields,
  supplementPayloadWithOcConfig,
} from "./normalize";

/** Atomic write: tmp file + rename to prevent OpenClaw reading a truncated config */
export function writeConfigAtomic(content: string) {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
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
// retry window of an early call can extend into a later one's territory. Without
// this guard, a stale payload that includes `env.ANTHROPIC_API_KEY` (from the
// initial setup where the key was first seen) can arrive at OpenClaw alongside
// a fresh payload that has only `agents.list` changed — the stale env diff
// triggers a full restart that kills the hot-reload the test is asserting on.
let _pushGeneration = 0;

/** Exposed only for unit-testing the cancellation path; do not call in app code. */
export function _resetPushGeneration() {
  _pushGeneration = 0;
}

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

    // Bail early if a newer push has already superseded this call.
    if (generation !== _pushGeneration) return;

    // Brief retry across transient WS disconnects. Beyond ~3.5 s the WS is
    // probably down due to the cold-start cascade, and inotify will catch
    // up; no point keeping a background coroutine alive longer.
    const backoffsMs = [100, 250, 500, 1000, 2000];
    for (let i = 0; i < backoffsMs.length; i++) {
      // Check before each attempt — a newer pushConfigInBackground call
      // may have started while we were sleeping.
      if (generation !== _pushGeneration) return;
      try {
        const current = (await client.config.get()) as {
          hash: string;
          config?: Record<string, unknown>;
        };
        if (generation !== _pushGeneration) return; // check after each await
        // Re-supplement on every attempt (including retries after a restart).
        // Between payload computation and now, OpenClaw may have auto-enabled
        // plugins (e.g. anthropic, telegram) and written their entries back to
        // openclaw.json. Without supplementing, config.apply sees those fields
        // removed and triggers another full restart — cascade loop.
        //
        // Prefer the in-memory OC config (from config.get) over reading the
        // file: the in-memory state is authoritative and has no file-write
        // race conditions. Fall back to file supplement when config is absent.
        // Supplement first, then env-redact (order matters: supplement adds
        // OC-managed values, redact replaces env keys with the sentinel for
        // openclaw#75534).
        const supplemented = current.config
          ? supplementPayloadWithOcConfig(newContent, current.config)
          : supplementPayloadWithFileFields(newContent);
        // Workaround for openclaw#75534: replace unchanged env values with
        // OpenClaw's REDACTED sentinel before sending. Without this, every
        // config.apply payload trips OpenClaw's resolved-vs-template diff for
        // env.* paths and triggers a full gateway restart even when only a
        // hot-reloadable path (agents.list, bindings) actually changed.
        // Removable when openclaw#75534 lands; tracked in #215.
        const payload = redactUnchangedEnvForApply(supplemented);
        await client.config.apply(payload, current.hash, {
          note: "pinchy: regenerateOpenClawConfig",
        });
        return;
      } catch (err) {
        if (i === backoffsMs.length - 1) {
          const message = err instanceof Error ? err.message : String(err);
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
