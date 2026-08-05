import * as fs from "fs";
import * as path from "path";

export type AuthProfilesProvider =
  "anthropic" | "openai" | "gemini" | "ollama-local" | "ollama-cloud";

export type WriteAgentAuthProfilesParams = {
  /** Filesystem root that will be mounted as /root/.openclaw inside OpenClaw container */
  configRoot: string;
  agentId: string;
  /**
   * Providers configured for this agent. Empty array → remove auth-profiles.json
   * (if present) so OpenClaw does not enter strict auth mode for this agent.
   * OpenClaw's hasAnyAuthProfileStoreSource() returns TRUE whenever the file
   * exists — even an empty profiles object enables strict mode.
   */
  providers: AuthProfilesProvider[];
};

/**
 * `agents/<id>/agent` is NOT exclusively ours. OpenClaw derives each agent's
 * models.json in the same directory and, when it gets there first, creates it
 * root-owned at mode 0700 — locking Pinchy (uid 999) out of the auth-profiles
 * write. start-openclaw.sh's `fix_config_permissions` tick chowns it back to
 * uid 999 within ~50 ms, but a write landing inside that window still gets
 * EACCES, and that EACCES used to take the whole config regenerate down with it
 * (#934).
 *
 * 5 attempts × 100 ms is the same budget `readExistingConfig` uses against the
 * same tick — deliberately, since the tick's 50 ms cadence was chosen to fit
 * inside it. If the attempts are exhausted, the directory is not merely
 * mid-repair: it is genuinely not ours, and the caller has to hear about it.
 */
const EACCES_ATTEMPTS = 5;
const EACCES_RETRY_DELAY_MS = 100;

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

async function withPermissionRetry<T>(fn: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= EACCES_ATTEMPTS || !isPermissionError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, EACCES_RETRY_DELAY_MS));
    }
  }
}

export async function writeAgentAuthProfiles(params: WriteAgentAuthProfilesParams): Promise<void> {
  const dir = path.join(params.configRoot, "agents", params.agentId, "agent");
  const target = path.join(dir, "auth-profiles.json");

  if (params.providers.length === 0) {
    // No profiles → remove the file so OpenClaw doesn't enter strict auth mode.
    //
    // Only ENOENT means "nothing to remove". A blanket catch here used to also
    // swallow the EACCES this whole file exists to surface — and that is the
    // common case, not an edge one: unlink inside a root-owned 0700 directory
    // returns EACCES, and an empty provider list is the state EVERY agent is in
    // before a provider is configured (Smithers is created before the wizard's
    // provider step, which is precisely when OpenClaw wins the race for
    // agents/<id>/agent). So the very moment the directory broke, the agent was
    // reported as clean: nothing reached `authProfileFailures`, no warning
    // toast, no `configRegenerated: false` — invisible until someone saved a
    // provider key.
    try {
      await withPermissionRetry(() => fs.unlinkSync(target));
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
    }
    return;
  }

  await withPermissionRetry(() => fs.mkdirSync(dir, { recursive: true }));

  const profiles: Record<string, unknown> = {};
  for (const provider of params.providers) {
    profiles[`${provider}-default`] = {
      type: "api_key" as const,
      provider,
      keyRef: { kind: "secret" as const, path: `providers.${provider}.apiKey` },
    };
  }

  const tmp = `${target}.tmp-${process.pid}`;
  await withPermissionRetry(() =>
    fs.writeFileSync(tmp, JSON.stringify({ profiles }, null, 2) + "\n", { mode: 0o600 })
  );
  // The rename gets the same retry as the write. It is a directory operation
  // like the two above, so it fails on the same EACCES for the same reason, and
  // the write having just succeeded does not carry over: the tick that repairs
  // ownership is a repair, and OpenClaw asserting 0700 on the directory again
  // between the two calls is the window this whole file is built around.
  //
  // On a failure the temp file is removed. Without that, every attempt leaves
  // an `auth-profiles.json.tmp-<pid>` beside the real file, in a directory
  // OpenClaw reads — and the throw below (correctly) surfaces to
  // `authProfileFailures`, so the caller never gets a chance to clean up. The
  // unlink is best-effort by construction: whatever denied the rename usually
  // denies this too, and an error here must not replace the real one.
  try {
    await withPermissionRetry(() => fs.renameSync(tmp, target));
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to add — the rename's error is the one worth reporting.
    }
    throw err;
  }
}
