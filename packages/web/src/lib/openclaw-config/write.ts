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
import { parseSizeDropRejection, planShrinkPush, utf8Bytes } from "./size-drop";
import { unresolvedSecretRefs } from "./keyless-bridge";
import { clearLastGoodBound, guardFileWrite, UnderReadSideLineError } from "./last-good-bound";
import {
  trackConfigPushStarted,
  trackConfigPushSettled,
  nextConfigPushGeneration,
  getCurrentConfigPushGeneration,
  scheduleShrinkResume,
  nextRegenerateSequence,
  writtenSecretsShape,
  noteUndeliveredConfigChange,
  noteFullRegenerateDelivered,
  fullRegenerateDeliveredSince,
  noteFileOnlyDelivery,
  scheduleFileOnlyFollowUp,
  cancelFileOnlyFollowUp,
  fileOnlyDeliveryPending,
  settleFileOnlyDelivery,
} from "./push-state";

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
  // Judged against what is already on disk — see readSecretBaseline.
  assertNoPlaintextSecrets(JSON.parse(content), readSecretBaseline);
  // Never under half of what OpenClaw may still hold as last-known-good: its
  // next start would restore `.bak` over the file (last-good-bound.ts).
  // Throws UnderReadSideLineError, leaving the file as it is.
  guardFileWrite(readCurrentContent(), content);
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

/** openclaw.json as it is now, or undefined when it is missing or stays unreadable. */
function readCurrentContent(): string | undefined {
  try {
    return readConfigContent();
  } catch {
    return undefined;
  }
}

/**
 * The config currently on disk, as the baseline the plaintext-secret guard
 * judges a write against. Best-effort: a missing, unreadable or corrupt file
 * yields nothing to inherit, so the guard scans the whole payload — the strict
 * reading, and the right one for a cold start.
 *
 * Why a baseline at all: Pinchy's targeted writers (`seedRestartClass-
 * OverridesIfMissing`, `seedGatewayTokenIfMissing`, `sanitizeOpenClawConfig`,
 * `updateTelegramChannelConfig`) spread the whole on-disk config through so
 * OpenClaw-enriched fields survive. On an install that already carries a
 * plaintext provider key — the legacy top-level `env` block written by a
 * pre-SecretRef Pinchy, or a `models.providers.*.apiKey` left un-healed
 * because regenerate itself is failing (#878) — the absolute scan rejected
 * every one of those writes forever. That never removed the secret; it only
 * meant the write's actual payload was silently dropped, which is how #884
 * left the restart-class overrides unseeded on every boot of the apsa box.
 *
 * Passed to the guard as a thunk, so a clean payload — nearly every write —
 * pays neither this read nor the comparison.
 */
function readSecretBaseline(): Record<string, unknown> | undefined {
  // Reuses readExistingConfig for its EACCES retry (OC's 0600 restart-write
  // race). A persistent EACCES throws there; here it just means "no baseline".
  try {
    return readExistingConfig();
  } catch {
    return undefined;
  }
}

export function readExistingConfig(): Record<string, unknown> {
  // Two outcomes besides a parsed config:
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
  //     loudly one layer up.
  const content = readConfigContent();
  if (content === undefined) return {};
  try {
    return JSON.parse(content);
  } catch {
    // A parse failure is a bug we can't paper over here.
    return {};
  }
}

/**
 * openclaw.json as it is on disk, or undefined when there is none.
 *
 * Retries briefly on EACCES. OpenClaw rewrites openclaw.json as root:0600 on
 * every internal SIGUSR1 restart; start-openclaw.sh's chmod loop opens it back
 * up to 0666, but Pinchy (uid 999) can hit a small window where the file is
 * unreadable. 5 × 100ms covers two chmod-loop ticks worst case. A persistent
 * EACCES THROWS: an unreadable file is not a missing one, and a caller that
 * took it for one would judge its write against nothing. Any other read error
 * counts as "no file", as it always has (ENOENT on a cold start).
 */
export function readConfigContent(): string | undefined {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return readFileSync(CONFIG_PATH, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EACCES") return undefined;
      if (attempt === 4) {
        console.warn(
          "[openclaw-config] persistent EACCES on",
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
  throw new Error("[openclaw-config] readConfigContent: unreachable");
}

// Monotonically-increasing counter that lets each pushConfigInBackground call
// cancel any pending retries from an older call. Because regenerateOpenClawConfig
// can be triggered concurrently (e.g. setup → connectBot → warmup agent create →
// actual agent create all in quick succession with a slow CI event loop), the
// retry window of an early call can extend into a later one's territory.
//
// The counter itself lives in `push-state.ts`, on globalThis: this module is
// loaded TWICE in one Pinchy process (custom server via tsx + Next's route
// bundles), and a module-level counter would give each instance a private
// sequence that the other's pushes never touch.
//
// Cancellation scope: the counter is checked between awaits in the retry loop,
// right before client.config.apply(), and once more when an attempt fails, so a
// superseded coroutine never applies NOR file-writes its stale payload. It does
// NOT cancel an in-flight apply() RPC — once that call starts, it runs to
// completion; only its aftermath is abandoned.

/**
 * Test-only: cancel every push coroutine that is currently in flight, by
 * moving the token past whatever generation they captured. Do not call in app
 * code.
 *
 * It BUMPS; it must never reset. The counter's only guarantee is monotonicity:
 * a generation minted once is never minted again, so a parked coroutine's
 * captured number can never compare equal to a later push's. This helper set
 * it back to 0 instead, which recycles live tokens — a per-test hook that
 * resets and then lets the test mint gen 1 again hands a coroutine parked at
 * gen 1 in the PREVIOUS test a matching number. It sails through the supersede
 * check and applies the previous test's payload against the current test's
 * mocks, which is how `openclaw-config.test.ts`'s "rate-limit conservation"
 * test saw a config.apply it never made. The reset inverted the hook's stated
 * purpose: it was the only way a stale coroutine could get past the guard at
 * all. Guarded by "a push parked since an earlier test can never reach
 * config.apply" in that file.
 *
 * Which is also why `push-state.ts` exports no reset for the generation, only
 * `nextConfigPushGeneration()`: now that the counter is process-wide, a reset
 * would recycle tokens held by coroutines in the OTHER module instance too.
 */
export function _supersedePendingPushes() {
  nextConfigPushGeneration();
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

// OpenClaw's config writer refuses any write under half of the current
// openclaw.json (`size-drop:OLD->NEW`), and config.apply exposes no way to lift
// that. A shrink regenerateOpenClawConfig has already judged deliberate — a
// deleted provider, e.g. a 40-model OpenAI-compatible one (see size-drop.ts) —
// is delivered in steps that each stay above OpenClaw's threshold: the first
// refusal calibrates Pinchy's byte count against OpenClaw's, then every step
// re-adds just enough of the deleted providers' content OpenClaw still has to
// clear floor(OLD * 0.5). A provider the target keeps is never stepped: its
// shrink — a failed or partial discovery read — is judged in full. Each accepted step is an
// ordinary OpenClaw-owned write, so OpenClaw promotes it to last-known-good
// like any other and its own clobber detection stays fully in force.
//
// A refused shrink is NEVER forced in through a file write. That bypasses
// OpenClaw's guard, and OpenClaw's read path undoes it anyway: the next start
// (or any unpinned config load) sees the file under half of last-known-good and
// restores `.bak` (`size-drop-vs-last-good`). When no step can explain the
// shrink — it is not a provider deletion: the stale-payload shape of #314, or a
// kept provider's catalogue collapsing — the push is dropped loudly; the next regenerate starts from current state.
//
// The shrink is known in one of two ways. regenerateOpenClawConfig says so up
// front (`expectsProviderShrink`) when its own guard discounted a deleted
// provider and the payload is still under half the file (UTF-8 bytes, with
// headroom: expectsSizeDropRefusal) — which matters because OpenClaw checks its
// control-plane rate limit BEFORE its size check: a push that is rate-limited,
// or cannot reach OpenClaw, never hears the refusal, and its fallback used to
// write the shrunken file past OpenClaw's guard. Otherwise the first size-drop
// refusal tells us. Either way no file is written for the rest of the push —
// not by the fallback, and not by the no-client path at boot either.
//
// A delivery that stops short of its target leaves OpenClaw on the old config
// or on an intermediate step that still carries the deleted provider as a
// stub. That happens when the push is superseded before it finishes — a
// partial writer (updateTelegramChannelConfig) reads the on-disk file, changes
// one block and pushes that — when it is dropped for a transient reason (rate
// limit, retries exhausted, OpenClaw unreachable), or when it is dropped after
// OpenClaw accepted at least one step. All of these hand off to one follow-up
// full regenerate (`resumeStrandedShrink`, debounced process-wide in
// push-state.ts), which steps on from wherever OpenClaw stands; a full
// regenerate that STARTED after the stranded one and reaches OpenClaw in the
// meantime cancels it (one that started before read the provider rows before
// the delete, and cancels nothing). If the follow-up is stranded as well, the
// regenerate OpenClaw's next connect runs takes over (noteUndeliveredConfig-
// Change in push-state.ts). A drop because
// the shrink is not a provider deletion (or a calibration that keeps missing)
// queues nothing before a step has landed: OpenClaw is unchanged, and the same
// regenerate would only be refused again.
//
// Halving per step, 8 steps cover a 256x shrink; 3 refusals bound a
// calibration that keeps missing (it should never need a second). The step
// budget is checked before a step is applied, never after.
const MAX_SHRINK_STEPS = 8;
const MAX_SIZE_DROP_REFUSALS = 3;

/**
 * Options for {@link pushConfigInBackground}.
 *
 * `onChangeApplied` fires exactly once, on the terminal path where the new
 * config actually reached OpenClaw's runtime or the on-disk file — i.e. a
 * successful `config.apply`, or any `writeConfigAtomic` fallback (no client,
 * rate-limit budget exhausted, retries exhausted). It deliberately does NOT
 * fire when the push is a semantic no-op (skipped because the supplemented
 * payload already equals OC's runtime) or when a newer push superseded this
 * one. Callers use it to drive side effects that must only happen when a real
 * change lands — e.g. `restartState.notifyRestart()` for the Telegram channel
 * writer, which must not strand the UI overlay on a no-op (#476 Gap 1). The
 * previous file-content dedup in the caller could not see this: `config.apply`
 * persists an OC-enriched file that never byte-matches the caller's payload, so
 * a repeated identical call no longer deduped and fired notifyRestart on a
 * genuine no-op.
 */
export interface PushConfigOptions {
  onChangeApplied?: () => void;
  /**
   * The payload is a full regenerate — the whole target config — rather than a
   * partial writer's edit of the on-disk file. When one reaches OpenClaw it
   * cancels a queued follow-up for a stranded shrink (see MAX_SHRINK_STEPS),
   * provided it started after the regenerate that stranded (`regenerateSeq`).
   */
  fullRegenerate?: boolean;
  /**
   * The regenerate's start sequence (`nextRegenerateSequence()`, claimed
   * before it read any state). Orders full regenerates by what they can have
   * seen rather than by when they were pushed. Defaults to a fresh sequence
   * claimed when the push starts.
   */
  regenerateSeq?: number;
  /**
   * The payload deletes a provider and is under half of the current file, so
   * OpenClaw will refuse it as a size drop. Set by regenerateOpenClawConfig
   * from its own guard. Turns the file-write fallback off from the first
   * attempt, before any refusal (see MAX_SHRINK_STEPS).
   */
  expectsProviderShrink?: boolean;
  /**
   * The payload finishes a provider handover, whatever its size: it deletes a
   * provider, or gives a re-keyed one its new entry (keyless-bridge.ts). A
   * newer push that supersedes it — before or during its apply — then hands
   * off to `resumeStrandedShrink` even when OpenClaw would have taken the
   * change in one write: a targeted writer's copy of the file still lists the
   * provider as a key-less stub, and nothing else would finish the handover
   * before the next config change.
   */
  handsOverProvider?: boolean;
  /**
   * Runs (once, debounced) when this push's provider handover stops short of
   * its target: superseded, dropped for a transient reason, or dropped after a
   * step landed (see MAX_SHRINK_STEPS). build.ts passes a
   * follow-up regenerate here — and passes none from that follow-up, so it
   * cannot recurse.
   */
  resumeStrandedShrink?: () => void;
}

/**
 * How OpenClaw 2026.7.1's config.apply words a refusal of the config itself —
 * the refusals known to be permanent, read from its dist:
 * - "invalid config": schema issues (`summarizeConfigValidationIssues` →
 *   "invalid config: …"), an unresolvable SecretRef ("invalid config: active
 *   SecretRef resolution failed …"), the bare fallback, and — by the same
 *   substring — "invalid config.apply params: …";
 * - "Config write rejected": `replaceConfigFile` refusing the write (e.g.
 *   `gateway-mode-removed`), which also leaves an openclaw.json.rejected.<ts>
 *   file behind on every attempt;
 * - "is not valid as real data": `restoreRedactedValues` meeting a redaction
 *   sentinel with no original value.
 * The same payload would be refused again, so such a fallback queues no
 * follow-up. Anything else — a timeout, a stale hash past its retries, a
 * disconnect, a rate limit, a refusal not listed here — is retried by the
 * follow-up at up to every 10 min on purpose: a wasted regenerate costs less
 * than a stranded agent.
 */
const CONFIG_REFUSED_ERROR_FRAGMENTS = [
  "invalid config",
  "Config write rejected",
  "is not valid as real data",
];

/**
 * The follow-up regenerate a file-only delivery schedules (push-state.ts).
 * Imported lazily: build.ts imports this module.
 */
function regenerateForFileOnlyDelivery(): void {
  import("./build")
    .then((build) => build.regenerateOpenClawConfig())
    .catch((err: unknown) => {
      console.error(
        "[openclaw-config] follow-up regenerate for a file-only delivery failed:",
        err instanceof Error ? err.message : String(err)
      );
    });
}

export function pushConfigInBackground(newContent: string, options: PushConfigOptions = {}): void {
  const { onChangeApplied, resumeStrandedShrink } = options;
  const generation = nextConfigPushGeneration();
  const regenerateSeq = options.regenerateSeq ?? nextRegenerateSequence();

  // Make the in-flight push observable (health endpoint `configPushesPending`,
  // consumed by the E2E stability gates): a rate-limited apply can park this
  // coroutine 33–53 s, during which the change is NOT in OC's runtime while
  // everything else looks healthy. `.finally` below settles on EVERY terminal
  // exit — applied, no-op skip, superseded, or file-write fallback.
  trackConfigPushStarted(generation);

  void (async () => {
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
    // Shrink-in-steps state (see MAX_SHRINK_STEPS). `shrink` is set by the first
    // size-drop refusal: OpenClaw's baseline for the NEXT write, and OpenClaw's
    // byte count minus Pinchy's for the same payload.
    let shrink: { ocBaselineBytes: number; offset: number } | undefined;
    let shrinkSteps = 0;
    let sizeDropRefusals = 0;
    let lastOcConfig: Record<string, unknown> | undefined;
    let lastSent: string | undefined;
    let lastSizeDrop = "";
    const shrinkKnown = () => options.expectsProviderShrink === true || shrink !== undefined;
    // Hand a shrink that stopped short of its target to one follow-up full
    // regenerate (see MAX_SHRINK_STEPS) — and, should that one be stranded
    // too, to the regenerate OpenClaw's next connect runs
    // (noteUndeliveredConfigChange). The follow-up passes no follow-up of its
    // own, so for it the connect is the only one.
    //
    // Nothing is handed off once a full regenerate that started after this
    // push has reached OpenClaw — a push parked in a rate-limit wait can
    // notice it was superseded long after that one landed. That regenerate
    // read the state this push carried, so nothing is owed: a debt recorded
    // now would outlive the delivery it is about (the follow-up finds its
    // target in place and pushes nothing), and every later reconnect would
    // regenerate.
    const resumeShrink = (why: string) => {
      if (fullRegenerateDeliveredSince(regenerateSeq)) return;
      noteUndeliveredConfigChange(regenerateSeq);
      if (!resumeStrandedShrink) return;
      console.warn(
        `[openclaw-config] push gen=${String(generation)}: provider deletion stopped after ${String(shrinkSteps)} step(s) (${why}); queueing a follow-up regenerate to finish it`
      );
      scheduleShrinkResume(resumeStrandedShrink, regenerateSeq);
    };
    // `transient`: the drop says nothing about the payload (rate limit,
    // retries, OpenClaw unreachable) — the deletion still has to land, so a
    // follow-up is queued even if no step did. Otherwise only once a step
    // landed: OpenClaw then sits on a stub nothing else would finish.
    const dropShrink = (why: string, { transient }: { transient: boolean }) => {
      const what = lastSizeDrop
        ? `OpenClaw refused this config as a size drop (${lastSizeDrop})`
        : `this config deletes a provider and is under half of openclaw.json`;
      console.error(
        `[openclaw-config] push gen=${String(generation)}: ${what} and ${why}. ` +
          `NOT writing openclaw.json directly — that would bypass OpenClaw's clobber guard, and OpenClaw restores .bak over it on its next start. ` +
          `Only a deleted provider is delivered in steps; anything else is the #311/#314 stale-payload shape.`
      );
      if (transient || shrinkSteps > 0) resumeShrink(why);
    };
    // Superseded before a provider handover finished — a shrink, or any other
    // push that deletes a provider or re-keys one (`handsOverProvider`).
    // Queued even when a full regenerate supersedes: that one cancels the
    // follow-up only once it has reached OpenClaw, and a partial writer can
    // still supersede it first.
    const onSuperseded = () => {
      if (shrinkKnown() || options.handsOverProvider === true) {
        resumeShrink("superseded before it finished");
      }
    };
    // The target reached OpenClaw (applied, written, or already in place). A
    // full regenerate that started after a stranded one makes that one's
    // queued follow-up moot (cancelShrinkResume checks the start order), and
    // likewise pays a change owed to OpenClaw's next connect (settleUndelivered-
    // ConfigChange), and keeps an older push that gives up later from owing it
    // again (noteFullRegenerateDelivered) — but only while this is the newest
    // push. A newer one that started while this one's apply was in flight is
    // superseding it all the same: it may carry other content — a targeted
    // writer's copy of the file from before this push landed, a deleted
    // provider's stub included — and lands on top, exactly as if it had
    // started before this apply.
    const targetReached = () => {
      if (generation !== getCurrentConfigPushGeneration()) {
        onSuperseded();
        return;
      }
      if (!options.fullRegenerate) return;
      noteFullRegenerateDelivered(regenerateSeq);
    };
    // config.apply landed the target in OpenClaw's RUNTIME, not just in
    // openclaw.json. As the newest push, that settles a file-only delivery
    // (noteFileOnlyDelivery): an older push's fallback is superseded by this
    // one, which carries the same change. Only an apply: the no-op guard
    // below compares against config.get, which reads the file.
    const runtimeReached = () => {
      if (generation === getCurrentConfigPushGeneration()) settleFileOnlyDelivery();
      targetReached();
    };
    // A payload that names a key secrets.json no longer holds — captured
    // before a regenerate took the key out (a targeted writer's copy of the
    // pre-bridge file, an older regenerate's payload) — is one OpenClaw refuses
    // over config.apply, and could neither start on nor accept a copy of as its
    // file. Judged against the bundle Pinchy last wrote, never by reading
    // secrets.json (recordWrittenSecrets in push-state.ts); before Pinchy wrote one, nothing is
    // refused. The regenerate that removed the key delivers its own config.
    const namesRemovedKey = (content: string): boolean => {
      const shape = writtenSecretsShape();
      let dangling: string[] = [];
      try {
        dangling = shape ? unresolvedSecretRefs(JSON.parse(content), shape) : [];
      } catch {
        // Unparseable: writeConfigAtomic's own parse rejects it.
      }
      if (dangling.length === 0) return false;
      console.error(
        `[openclaw-config] push gen=${String(generation)}: NOT writing openclaw.json — the payload names ${dangling.join(", ")}, which secrets.json no longer holds. ` +
          `OpenClaw could neither start on that file nor accept a copy of it; the regenerate that removed the key delivers the current config.`
      );
      return true;
    };
    // writeConfigAtomic refuses a file under half of what OpenClaw may still
    // hold as last-known-good (last-good-bound.ts): its next start would
    // restore `.bak` over it. The file stays as it is, and config.apply
    // delivers the change once OpenClaw is up: every push that gets here —
    // a targeted writer's too, which queues no follow-up — records that
    // OpenClaw's next connect owes a full regenerate (noteUndelivered-
    // ConfigChange), which rebuilds the change from the database. A
    // regenerate's push also queues its follow-up, for an OpenClaw that is up
    // but refused this push's applies (rate limit, retries) and so has no
    // reconnect coming.
    const writeFile = (content: string): boolean => {
      try {
        writeConfigAtomic(content);
        return true;
      } catch (err) {
        if (!(err instanceof UnderReadSideLineError)) throw err;
        console.error(`[openclaw-config] push gen=${String(generation)}: ${err.message}`);
        noteUndeliveredConfigChange(regenerateSeq);
        if (resumeStrandedShrink) scheduleShrinkResume(resumeStrandedShrink, regenerateSeq);
        return false;
      }
    };
    // A file-write fallback for a shrink would land the target past OpenClaw's
    // guard (see MAX_SHRINK_STEPS) — refuse it instead.
    // `transient`: the apply failed for a reason that passes — anything but
    // OpenClaw refusing the config itself (CONFIG_REFUSED_ERROR_FRAGMENTS). A
    // transient fallback queues a follow-up; a refusal leaves the file
    // unconfirmed and ends any running follow-up chain, because a retry would
    // be refused the same way.
    const writeFallback = (content: string, { transient }: { transient: boolean }): boolean => {
      if (shrinkKnown()) {
        dropShrink("could not be delivered over config.apply", { transient: true });
        return false;
      }
      if (namesRemovedKey(content)) return false;
      if (!writeFile(content)) return false;
      noteFileOnlyDelivery();
      // Every fallback but a refusal gets one: a disconnect is delivered on the
      // reconnect too, but a rate limit or a timeout while OpenClaw stays
      // connected has nothing else coming.
      if (transient) scheduleFileOnlyFollowUp(regenerateForFileOnlyDelivery);
      else cancelFileOnlyFollowUp();
      return true;
    };
    let client;
    try {
      client = getOpenClawClient();
    } catch {
      client = undefined;
    }
    if (!client) {
      // No WS client (boot: bootInits regenerates before the client exists) —
      // write directly to file so inotify picks up the change. This path runs
      // synchronously (no await before writeConfigAtomic), so the file is on
      // disk before regenerateOpenClawConfig() returns to its caller.
      //
      // Not for a provider-deletion shrink: that write bypasses OpenClaw's
      // guard like any other fallback, and OpenClaw's startup read restores
      // last-known-good / `.bak` over a file under half of it. The file stays
      // what regenerate left there — the key-less bridge (keyless-bridge.ts),
      // which OpenClaw starts on — and the regenerate on first connect
      // delivers the deletion in steps. Nor for any other payload under half
      // of what OpenClaw may still hold as last-known-good, which is not
      // necessarily the file on disk (writeFile, above).
      if (shrinkKnown()) {
        dropShrink("Pinchy has no OpenClaw client yet", { transient: true });
        return;
      }
      if (namesRemovedKey(newContent)) return;
      console.log(
        `[openclaw-config] push gen=${String(generation)}: no WS client → file write (inotify; reload may lag)`
      );
      if (!writeFile(newContent)) return;
      targetReached();
      onChangeApplied?.();
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
    // Same on-disk baseline as writeConfigAtomic: `newContent` can be a
    // targeted writer's payload, which carries the whole existing config
    // through. Throwing here would reject the change in a background
    // coroutine — an unhandled rejection, and the channel update lost with
    // it (#884).
    assertNoPlaintextSecrets(JSON.parse(newContent), readSecretBaseline);

    for (let i = 0; i < backoffsMs.length; i++) {
      // Check before each attempt — a newer pushConfigInBackground call
      // may have started while we were sleeping.
      if (generation !== getCurrentConfigPushGeneration()) {
        console.log(
          `[openclaw-config] push gen=${String(generation)}: superseded by newer push (gen=${String(getCurrentConfigPushGeneration())}) before attempt ${String(i)}`
        );
        onSuperseded();
        return;
      }
      try {
        const current = (await client.config.get()) as {
          hash: string;
          config?: Record<string, unknown>;
          parsed?: Record<string, unknown> | null;
        };
        // A shrink step re-adds provider content from OpenClaw's FILE as
        // authored (`parsed`), never from the runtime `config`: that one is
        // materialized (every model gains cost/contextWindow/… defaults), and
        // the file is what OpenClaw's size-drop baseline measures.
        lastOcConfig = current.parsed ?? current.config;

        // Newer call started while we were awaiting config.get()
        if (generation !== getCurrentConfigPushGeneration()) {
          console.log(
            `[openclaw-config] push gen=${String(generation)}: superseded by newer push (gen=${String(getCurrentConfigPushGeneration())}) during config.get`
          );
          onSuperseded();
          return;
        }

        // Supplement OC-managed fields (meta, non-pinchy plugins, controlUi,
        // channels.telegram OC-specific fields, models.providers baseUrl).
        // Prefer the live in-memory config (avoids file-write races after restart).
        let supplemented = current.config
          ? supplementPayloadWithOcConfig(newContent, current.config)
          : supplementPayloadWithFileFields(newContent);

        // Meta-fallback: OC's in-memory config may lack meta immediately after a
        // SIGUSR1 restart (before OC stamps it). The previous file may still have
        // meta; fold it in so the applied config keeps OC's metadata intact.
        if (current.config) {
          const parsed = JSON.parse(supplemented) as Record<string, unknown>;
          if (!("meta" in parsed)) {
            supplemented = supplementPayloadWithFileFields(supplemented);
          }
        }

        // NOTE: there is deliberately NO meta-guard here any more. The old guard
        // returned early to a `writeConfigAtomic` file write whenever the payload
        // lacked `meta`, to dodge OpenClaw 4.27's "missing-meta-before-write"
        // restart-cascade anomaly. That anomaly is GONE in the pinned OC
        // 2026.5.28 — verified empirically: a meta-less `config.apply` that adds
        // an agent is accepted and HOT-RELOADED (`reload applied (agents.list)`,
        // no restart), and the agent lands in OC's runtime. Worse, the guard was
        // actively harmful: during the first-install secrets-bootstrap restart
        // window OC's config (and the fresh-install file seed) both lack meta, so
        // the guard fired on every agent-create push and shunted it onto the
        // file-write path — whose atomic-rename OC's post-restart watcher does
        // NOT reliably reload, leaving the freshly-created agent absent from
        // runtime and dispatch stuck on `unknown agent id` (#464). Letting the
        // meta-less payload go through `config.apply` applies it in-process,
        // reliably, with no file-watcher dependency.

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
        //
        // Not while a file-only delivery is pending (noteFileOnlyDelivery):
        // `current.config` is what config.get reads — openclaw.json, the very
        // file a push just wrote and the running OpenClaw may never have
        // loaded. It names the change already, so the guard would skip the
        // one apply that can deliver it.
        //
        // What that apply costs, read from the pinned OpenClaw 2026.7.1 dist
        // (gateway/server-methods/config.ts → config-*.js): the handler takes
        // `changedPaths = diffConfigPaths(<file snapshot>, payload)` and
        // decides a restart with resolveConfigRestartRequirement on exactly
        // those paths. A payload equal to the file has none, so
        // buildGatewayReloadPlan([]) is a no-op plan and no SIGUSR1 restart is
        // scheduled. (What is sent is the supplemented payload: a field the
        // supplementing adds or changes is a changed path, judged by OpenClaw's
        // restart rules like any other.) The write then reaches OpenClaw's reload watcher, which
        // compares against its runtime and applies what the runtime lacks —
        // the undelivered change itself, under its own reload rules (CI run
        // 41906476538's late apply: `hot reload applied (hooks, plugins,
        // models)`, no restart). The handler also responds before it queues
        // any follow-up, so a landed apply is seen and settles the delivery.
        if (current.config && !fileOnlyDeliveryPending()) {
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
            targetReached();
            return;
          }
        }

        lastSupplemented = supplemented;
        let payload = supplemented;
        let isShrinkStep = false;
        if (shrink) {
          const plan = planShrinkPush({ target: supplemented, ocConfig: lastOcConfig, ...shrink });
          if (!plan) {
            dropShrink("the shrink is not a provider deletion", { transient: false });
            return;
          }
          if (plan.isStep && shrinkSteps >= MAX_SHRINK_STEPS) {
            dropShrink(`${String(MAX_SHRINK_STEPS)} steps did not reach the target`, {
              transient: false,
            });
            return;
          }
          payload = plan.payload;
          isShrinkStep = plan.isStep;
        }
        lastSent = payload;
        await client.config.apply(payload, current.hash, {
          note: "pinchy: regenerateOpenClawConfig",
        });
        // OpenClaw is running and promotes its own write to last-known-good.
        clearLastGoodBound();
        if (isShrinkStep && shrink) {
          shrinkSteps++;
          shrink.ocBaselineBytes = utf8Bytes(payload) + shrink.offset;
          // Progress, not a failure: a step that landed must not count against
          // the budgets meant for an apply that keeps failing. OpenClaw's
          // rate limit (~3 applies per window) is smaller than a 10x shrink.
          rateLimitAttempts = 0;
          console.log(
            `[openclaw-config] push gen=${String(generation)}: provider-deletion step ${String(shrinkSteps)} applied (~${String(shrink.ocBaselineBytes)} bytes)`
          );
          i--;
          continue;
        }
        // config.apply's inner writeConfigFile persists the config to disk.
        // A newer call's payload will overwrite via its own config.apply or
        // writeConfigAtomic fallback.
        console.log(
          `[openclaw-config] push gen=${String(generation)}: applied via WS config.apply (in-process, synchronous runtime refresh)${rateLimitAttempts > 0 ? ` after ${String(rateLimitAttempts)} rate-limit wait(s)` : ""}`
        );
        runtimeReached();
        onChangeApplied?.();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // A newer push can have started while this attempt's RPC was in
        // flight. Both terminal branches below end in writeConfigAtomic, and a
        // superseded coroutine writing its stale payload is exactly the
        // stale-payload-lands-anyway race the counter exists to prevent (#193)
        // — it would overwrite on disk what the newer push just applied to
        // OC's runtime. From here the newer push owns both.
        //
        // Checked once at the top of the catch rather than in front of each
        // fallback: the retry branches below only ever `continue` into the
        // loop-top check anyway, so returning here just skips a sleep they
        // would spend on a decision already made. `onChangeApplied` stays
        // unfired, same as at the other two supersede checks — a push that
        // delivered nothing must not report a landed change.
        if (generation !== getCurrentConfigPushGeneration()) {
          console.log(
            `[openclaw-config] push gen=${String(generation)}: superseded by newer push (gen=${String(getCurrentConfigPushGeneration())}) during attempt ${String(i)} — skipping fallback write:`,
            message
          );
          onSuperseded();
          return;
        }

        // Size-drop: OpenClaw refused the write as a >50% shrink of its current
        // file. Never retried as-is and never forced in through the file (see
        // MAX_SHRINK_STEPS): calibrate, then deliver in steps on the next pass
        // — or drop the push if no step can explain the shrink.
        const sizeDrop = parseSizeDropRejection(message);
        if (sizeDrop) {
          sizeDropRefusals++;
          lastSizeDrop = `size-drop:${String(sizeDrop.fromBytes)}->${String(sizeDrop.toBytes)}`;
          if (!lastSent || sizeDropRefusals > MAX_SIZE_DROP_REFUSALS) {
            dropShrink(`was refused ${String(sizeDropRefusals)} times`, { transient: false });
            return;
          }
          if (!lastOcConfig) {
            dropShrink("OpenClaw's current config is unavailable to step from", {
              transient: false,
            });
            return;
          }
          shrink = {
            ocBaselineBytes: sizeDrop.fromBytes,
            offset: sizeDrop.toBytes - utf8Bytes(lastSent),
          };
          console.warn(
            `[openclaw-config] push gen=${String(generation)}: config.apply refused a size drop (${String(sizeDrop.fromBytes)}->${String(sizeDrop.toBytes)} bytes); delivering the provider deletion in steps`
          );
          i--;
          continue;
        }

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
          const fallback = lastSupplemented ?? supplementPayloadWithFileFields(newContent);
          if (writeFallback(fallback, { transient: true })) {
            targetReached();
            onChangeApplied?.();
          }
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
        // NOT_CONNECTED_MAX_WAIT_MS (60 s) total, so the WS reconnect during
        // OC's restart lands the next config.apply via WS instead of via
        // writeConfigAtomic-into-restart.
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
          const fallback = lastSupplemented ?? supplementPayloadWithFileFields(newContent);
          if (
            writeFallback(fallback, {
              transient: !CONFIG_REFUSED_ERROR_FRAGMENTS.some((f) => message.includes(f)),
            })
          ) {
            targetReached();
            onChangeApplied?.();
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, backoffsMs[i]));
      }
    }
  })()
    .finally(() => trackConfigPushSettled(generation))
    .catch((err: unknown) => {
      // Terminal safety net. Everything inside the retry loop already handles
      // its own errors, but the pre-loop section does not: the plaintext guard
      // throws by design, and `writeConfigAtomic` can throw on a full or
      // read-only volume. This coroutine is voided, so such a throw becomes an
      // unhandled rejection — which Node ≥ 15 escalates to an uncaught
      // exception and terminates the Pinchy server with it. Refusing the push
      // is the correct outcome; taking the process down with it is not.
      // `.finally` before `.catch` so the pending-push counter settles either
      // way (the health endpoint's `configPushesPending` must not leak).
      console.error(
        `[openclaw-config] push gen=${String(generation)}: aborted before delivery —`,
        err instanceof Error ? err.message : String(err)
      );
    });
}
