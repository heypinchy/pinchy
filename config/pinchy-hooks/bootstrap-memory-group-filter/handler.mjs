// @ts-check
//
// OpenClaw `agent:bootstrap` hook — strips MEMORY.md from the bootstrap set for
// channel GROUP sessions.
//
// Why this exists
// ---------------
// OpenClaw pushes a workspace's bootstrap files (AGENTS.md, SOUL.md, MEMORY.md,
// …) into every non-subagent/non-cron session. For a SHARED agent, MEMORY.md
// accumulates knowledge persisted from individual users' private DM sessions.
// A Telegram GROUP session (`agent:<id>:<channel>:group:<peer>`) receiving that
// file discloses one user's memory to everyone in the group — who may not be
// Pinchy users at all. See heypinchy/pinchy#369.
//
// The durable fix belongs upstream: OpenClaw's filterBootstrapFilesForSession
// already narrows the set for subagent + cron sessions but not channel-group
// sessions (openclaw/openclaw#108881). This hook is Pinchy's immediate,
// self-hosted mitigation and should be DELETED once that upstream fix ships.
//
// Scope (be honest about it): this stops the AUTOMATIC per-message bootstrap
// push only. It does not stop a group member from deliberately eliciting memory
// via the agent's pinchy_read / memory_search tools — that residual belongs to
// the per-user-memory work, not here.
//
// Why .mjs and not .ts: OpenClaw loads plugin entries through jiti (TS-capable)
// but loads INTERNAL HOOKS through native `import()` (see the loader's
// buildImportUrl → pathToFileURL, no transpile step). A .ts handler would fail
// to import. The bundled OpenClaw hooks are .js for the same reason.
//
// Why reassignment is safe here: the internal-hook loader registers this
// handler DIRECTLY (registerInternalHook), so `event.context` is the same
// object the caller (applyBootstrapHookOverrides) reads `bootstrapFiles` back
// from. The plugin `api.on` path wraps handlers in a spread-copied context
// where reassignment would be lost — this hook is deliberately NOT on that path.

const MEMORY_BOOTSTRAP_FILENAME = "MEMORY.md";

/**
 * A channel GROUP session key. Session keys are colon-delimited; group sessions
 * carry a `group` kind segment at index 3 (`agent:<id>:<channel>:group:<peer>`),
 * distinguishing them from `direct` DMs, `cron`, and `subagent` sessions.
 *
 * @param {unknown} sessionKey
 * @returns {boolean}
 */
export function isGroupSessionKey(sessionKey) {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return false;
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts.length >= 5 && parts[3] === "group";
}

/**
 * Returns the bootstrap file list with MEMORY.md removed IFF this is a group
 * session. Non-group sessions (DM, cron, subagent) are returned unchanged so
 * the normal memory push keeps working. Returns a new array when it filters;
 * never mutates the input.
 *
 * @template {{ name?: string }} F
 * @param {F[]} files
 * @param {unknown} sessionKey
 * @returns {F[]}
 */
export function filterGroupBootstrap(files, sessionKey) {
  if (!Array.isArray(files)) return files;
  if (!isGroupSessionKey(sessionKey)) return files;
  return files.filter((f) => f?.name !== MEMORY_BOOTSTRAP_FILENAME);
}

/**
 * `agent:bootstrap` hook entry point. Mutates the event's bootstrap set in
 * place (by reassignment) so the caller sees the filtered list. No-ops for any
 * event that isn't a bootstrap event carrying a bootstrapFiles array.
 *
 * @param {any} event
 */
export default async function bootstrapMemoryGroupFilterHook(event) {
  const context = event?.context;
  if (!context || !Array.isArray(context.bootstrapFiles)) return;
  context.bootstrapFiles = filterGroupBootstrap(
    context.bootstrapFiles,
    context.sessionKey,
  );
}
