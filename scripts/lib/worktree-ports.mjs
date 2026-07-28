/**
 * Give each git worktree its own dev-stack ports, so two of them can run at
 * once without the second one failing on a bound port.
 *
 * `docker-compose.dev.yml` used to hard-code `5434:5432` and `8443:443`. The
 * workaround everyone reached for was an untracked `docker-compose.local.yml`
 * with `ports: !override` — re-derived by hand per worktree, easy to get wrong
 * (a bare `ports:` APPENDS instead of replacing, so the conflict survives), and
 * invisible to everyone else. This replaces that with one command.
 *
 * Allocation happens ONCE per worktree and is written to a gitignored `.env`.
 * It is deliberately not re-probed on every `up`: a worktree whose address
 * moves because some unrelated stack briefly held its old port is worse than
 * one that fails loudly and asks to be re-allocated.
 */

/**
 * One base port per service. They sit far apart on purpose — an offset can
 * never carry one family into another, so two worktrees cannot end up sharing a
 * port through arithmetic. The bases keep the values people already know from
 * the compose files (7777 web, 5434 db, 8443 caddy) as the first block.
 */
export const PORT_FAMILIES = {
  pinchyPort: 7777,
  dbPort: 5434,
  caddyPort: 8443,
};

/** How many blocks exist above each base before we give up. */
export const MAX_BLOCKS = 60;

/**
 * The compose project name, which also prefixes every volume. Derived from the
 * worktree directory rather than passed in, so it matches what plain
 * `docker compose up` would have chosen — otherwise a stack started with this
 * `.env` and one started without it would own two different sets of volumes.
 *
 * Docker's own normalisation is applied here rather than left to Docker, so the
 * name we WRITE is the name it USES.
 */
export function projectSlug(worktreePath) {
  const base = worktreePath.replace(/\/+$/, "").split("/").pop() ?? "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "pinchy";
}

/**
 * A stable offset from the worktree name. FNV-1a: tiny, dependency-free, and
 * good enough for spreading a few dozen names — this picks a starting point,
 * `isPortFree` decides the rest, so a hash collision costs one extra probe
 * rather than a wrong answer.
 */
function startingOffset(slug) {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % MAX_BLOCKS;
}

/**
 * Pick a block of ports — one per family, all sharing the same offset — where
 * every port passes `isPortFree`.
 *
 * The whole block moves together. A half-free block is not usable: the services
 * come up as one stack, so a free web port next to a bound database port is
 * just a failure that takes longer to surface.
 */
export function allocatePorts(slug, isPortFree) {
  const start = startingOffset(slug);
  const bases = Object.values(PORT_FAMILIES);

  for (let i = 0; i < MAX_BLOCKS; i++) {
    const offset = (start + i) % MAX_BLOCKS;
    if (bases.every((base) => isPortFree(base + offset))) {
      const ports = { offset };
      for (const [name, base] of Object.entries(PORT_FAMILIES)) {
        ports[name] = base + offset;
      }
      return ports;
    }
  }

  throw new Error(
    `No free port block for "${slug}" after ${MAX_BLOCKS} attempts. ` +
      `Stop a dev stack you are not using (docker compose ls) and try again.`,
  );
}
