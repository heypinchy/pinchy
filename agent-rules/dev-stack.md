# Dev Stack And Compose Files

Read this before editing a `docker-compose*.yml` file or running a dev stack in a worktree. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

### Running a dev stack per worktree

Two worktrees cannot both run the dev stack on the default ports. Allocate a free block for the current worktree once, then use the ordinary command:

```bash
pnpm worktree:env
```

It writes `COMPOSE_PROJECT_NAME`, `DEV_PINCHY_PORT`, `DEV_DB_PORT` and `DEV_CADDY_PORT` into a gitignored `.env`, which Compose reads automatically. Allocation happens **once** and is not re-derived on later runs — a worktree's address should stay bookmarkable — so pass `--force` if you need a new block. `pnpm -C packages/web test:db` follows the allocation on its own.

Do not hand-write a `docker-compose.local.yml` with `ports: !override` for this any more. That was the old workaround and it is easy to get wrong: a bare `ports:` **appends** instead of replacing, so the conflict survives the override that was meant to fix it.

The compose defaults are unchanged (`7777`/`5434`/`8443`), so a checkout without `.env` behaves exactly as the docs describe.

**The `DEV_` prefix is load-bearing.** Compose reads `.env` for _every_ stack started from the repo root, and `docker-compose.yml` — the base file every E2E overlay layers on — reads `PINCHY_PORT`. Writing that key per worktree therefore moved six E2E suites off the `:7777` their Playwright configs expect (`telegram` hard-codes the URL and has no override at all), and the failure surfaces as a connection timeout with nothing pointing back at the allocation. Only `docker-compose.dev.yml` reads the `DEV_*` keys, so only stacks that include it move. A stack that _does_ layer the dev overlay (`odoo`, `eval`) must pin its ports back with `ports: !override`.

Two guards in `scripts/lib/dev-stack-port-isolation.test.mjs` hold that line: one fails if a generated key is read outside the dev overlay or a dev-layered stack stops pinning, the other fails if a hard-coded host port anywhere in the repo lands inside an allocation band without being listed in `RESERVED_PORTS`. The reserved list matters because a probe only sees what is bound _right now_ while allocation is sticky: a worktree allocated while the integration stack was down would take `7779` and keep it.

### Every published port binds loopback

A `ports:` entry with no host IP — `"5434:5432"` — publishes on `0.0.0.0`. Every test overlay was written that way, so on a shared dev box or a CI runner with a routable address the test Postgres instances, each suite's Pinchy override and all eight mock servers answered the whole network: the odoo mock accepts writes, greenmail hands out mail, and the databases hold seeded credentials. Nothing was red, because reaching them over loopback works identically either way.

The prefix (`"127.0.0.1:5434:5432"`) is one token per line across nine files with no locally visible failure mode — the shape of every drift this repo has already paid for. `scripts/lib/compose-port-bindings.test.mjs` (pure logic in `compose-port-bindings.mjs`, run by `pnpm test:scripts`) is the tripwire. Three things worth knowing before editing it:

- **There is no list of accepted exceptions, deliberately.** A stack that genuinely needs a routable bind writes it the way `docker-compose.yml` does — `"${PINCHY_PORT:-127.0.0.1:7777}:7777"` — so the _default_ is loopback and an operator who wants more says so in their own environment. A checkout binds what its files say; nobody is exposed by omission.
- **The parser throws on input it cannot read** rather than skipping the line. The long syntax (`- target: 9001` / `published:`) also binds every interface when `host_ip` is omitted, and a guard that silently ignores it reports on the lines it happens to understand instead of on what the stack binds.
- **`docker-compose.dev.yml` spells the prefix two different ways, three lines apart.** `DEV_PINCHY_PORT` carries `127.0.0.1:` _inside_ the value (`managedValues` in `scripts/lib/env-file.mjs` writes it); `DEV_DB_PORT` and `DEV_CADDY_PORT` are bare numbers whose prefix the compose file supplies. Both halves are needed and neither can be "harmonised": adding the prefix to `DEV_DB_PORT` resolves to `127.0.0.1:127.0.0.1:5444:5432`, and removing it from `DEV_PINCHY_PORT` puts every already-allocated worktree back on `0.0.0.0` — a break that appears only in a worktree that has run `pnpm worktree:env`, never in CI and never in a fresh clone. The guard resolves the dev overlay against the values `managedValues` really writes, so it fails in both directions.

Verify a change to it by reproduction, not by reading: drop a `127.0.0.1:` from any overlay and watch that exact line come back in the failure.
