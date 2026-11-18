/**
 * The absolute ceiling on what `GET /api/agents/[id]/workspace-file` may ever
 * read off disk, independent of any agent's configured `allowed_paths`.
 *
 * Deliberately NOT `packages/plugins/pinchy-files/validate.ts`'s
 * `ALLOWED_ROOTS`, even though the two guard the same idea. The plugin runs in
 * the `openclaw` container, this runs in `pinchy`, and the two mount the same
 * volumes at different paths (see `docker-compose.yml`): the workspaces volume
 * is `/root/.openclaw/workspaces` over there and `/openclaw-config/workspaces`
 * here. Copying the plugin's list would add one root that does not exist in
 * this container — and inviting its parent `/openclaw-config` instead would
 * hand out `openclaw.json`, which carries the plaintext gateway token that
 * unlocks `/api/internal/*`.
 *
 * So: exactly the data mount, which is all this route serves today (knowledge-
 * base citation sources). A future "give me workspace file X" flow adds
 * `/openclaw-config/workspaces/` HERE — never its parent.
 *
 * Its own module so the route's tests can substitute a temporary directory
 * without mocking `resolveAllowedFile` itself.
 */
export const FILE_SERVE_ROOTS: readonly string[] = ["/data/"];
