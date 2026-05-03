import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { assertNoPlaintextSecrets } from "@/lib/openclaw-plaintext-scanner";
import { CONFIG_PATH } from "./paths";

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

export function pushConfigInBackground(newContent: string): void {
  void (async () => {
    let client;
    try {
      const { getOpenClawClient } = await import("@/server/openclaw-client");
      client = getOpenClawClient();
    } catch {
      // No client — file write + inotify is the only path here.
      return;
    }

    // Brief retry across transient WS disconnects. Beyond ~3.5 s the WS is
    // probably down due to the cold-start cascade, and inotify will catch
    // up; no point keeping a background coroutine alive longer.
    const backoffsMs = [100, 250, 500, 1000, 2000];
    for (let i = 0; i < backoffsMs.length; i++) {
      try {
        const current = (await client.config.get()) as { hash: string };
        await client.config.apply(newContent, current.hash, {
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
