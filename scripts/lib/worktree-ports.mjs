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
 * Ports inside a band that some OTHER stack in this repo already owns.
 *
 * A probe only reports what is bound at the moment it runs, and allocation is
 * deliberately sticky — so without this list a worktree allocated while the
 * integration stack happened to be down would take 7779 and KEEP it. Every
 * later `pnpm test:e2e:integration` in that worktree then dies on a bound
 * port, and nothing points back to the allocation that caused it.
 *
 * `dev-stack-port-isolation.test.mjs` scans the compose files and Playwright
 * configs and fails if a hard-coded host port lands in a band without being
 * listed here, so this cannot quietly fall behind the repo.
 */
export const RESERVED_PORTS = new Set([
  5433, // standard E2E Postgres (packages/web/playwright.config.ts)
  5434, // dev default + docker-compose.e2e.yml / odoo-test db
  5435, // docker-compose.integration.yml db
  5437, // docker-compose.eval.yml db
  7777, // dev default + the port every E2E stack's Playwright config expects
  7778, // standard E2E web server (packages/web/playwright.config.ts)
  7779, // docker-compose.integration.yml pinchy
  7781, // docker-compose.eval.yml pinchy
  8443, // dev default caddy
]);

/**
 * The compose project name, which also prefixes every volume. Derived from the
 * worktree directory rather than passed in, so it matches what plain
 * `docker compose up` would have chosen — otherwise a stack started with this
 * `.env` and one started without it would own two different sets of volumes,
 * and the developer sees an empty dev database with no explanation.
 *
 * Docker's own normalisation is applied here rather than left to Docker, so
 * the name we WRITE is the name it USES: lowercase, DELETE anything outside
 * `[a-z0-9_-]` (an underscore is legal and survives — it is NOT folded to a
 * dash), then strip leading characters until the name starts with `[a-z0-9]`.
 * Measured against Docker 29.4.0, see the cases in the test file.
 */
export function projectSlug(worktreePath) {
  const base = worktreePath.replace(/\/+$/, "").split("/").pop() ?? "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[^a-z0-9]+/, "");
  // Only reachable for a name Docker itself would reject (it enforces
  // ^[a-z0-9][a-z0-9_-]*$ and refuses to start). A working stack beats a hard
  // error, and there is no "name Docker would have used" to stay faithful to.
  return slug || "pinchy";
}

/** Every port a block could ever use — the full probe set, nothing beyond. */
export function candidatePorts() {
  const ports = [];
  for (const base of Object.values(PORT_FAMILIES)) {
    for (let i = 0; i < MAX_BLOCKS; i++) ports.push(base + i);
  }
  return ports;
}

/**
 * Which of `ports` fall inside a band without being reserved — i.e. ports this
 * allocator could hand to a worktree even though something else in the repo
 * already expects to own them. Drives the repo-wide drift guard.
 *
 * Sorted ascending and de-duplicated, so the guard's failure message reads the
 * same whatever order the files were scanned in.
 */
export function unreservedBandConflicts(ports) {
  const bands = new Set(candidatePorts());
  const hits = new Set(
    ports.filter((port) => bands.has(port) && !RESERVED_PORTS.has(port)),
  );
  return [...hits].sort((a, b) => a - b);
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
    const usable = (base) =>
      !RESERVED_PORTS.has(base + offset) && isPortFree(base + offset);
    if (bases.every(usable)) {
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
