// Defense-in-depth check. Add a pattern for every new provider whose secret
// shape can be recognized by prefix — otherwise the scanner can silently miss
// a leak when a future migration forgets to route through SecretRef. See
// `packages/web/src/lib/providers.ts` for the canonical provider list; any new
// entry there with a recognizable key prefix should also land here.
const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "anthropic", regex: /^sk-ant-[a-zA-Z0-9_-]{16,}/ },
  { name: "openai-generic", regex: /^sk-(proj-)?[a-zA-Z0-9]{16,}/ },
  { name: "gemini", regex: /^AIza[a-zA-Z0-9_-]{30,}/ },
  { name: "brave", regex: /^BSA[a-zA-Z0-9]{16,}/ },
  // Ollama Cloud: 32-hex prefix + "." + ≥16 base62 chars (observed format).
  { name: "ollama-cloud", regex: /^[a-f0-9]{32}\.[a-zA-Z0-9]{16,}/ },
  // telegram-bot tokens omitted: OpenClaw 2026.4.26 does not resolve SecretRef
  // in channels.telegram.accounts.*.botToken — tokens stay as plain strings.
];

export type Finding = { path: string; pattern: string };

/** Internal: a finding plus the matched value, used to compare two configs. */
type Hit = Finding & { value: string };

export function findPlaintextSecrets(config: unknown, prefix = ""): Finding[] {
  return collectHits(config, prefix).map(({ path, pattern }) => ({ path, pattern }));
}

/**
 * Findings that `config` INTRODUCES relative to `previous` — a hit counts as
 * carried over only when the previous config held the very same value at the
 * very same path.
 *
 * The absolute scan answers "does this tree contain a plaintext secret", which
 * is the wrong question for a writer that spreads the on-disk config through
 * verbatim (the boot seeds, the Telegram channel writer). On an install that
 * already has a plaintext key on disk, every such write was rejected forever —
 * which never removed the secret, it only meant the write's actual payload
 * (Pinchy's restart-class overrides) was silently never applied (#884).
 *
 * The guard's job is to catch a Pinchy regression that routes a secret around
 * SecretRef, and that still holds: such a regression writes a value the file
 * did not previously carry at that path, so it is reported as new.
 */
export function findNewPlaintextSecrets(config: unknown, previous: unknown): Finding[] {
  return partition(collectHits(config), previous).introduced;
}

/**
 * Split `hits` by whether `previous` already carried them. An absent
 * `previous` carries nothing, so everything counts as introduced — which is
 * exactly the absolute scan.
 */
function partition(
  hits: Hit[],
  previous: unknown
): { introduced: Finding[]; inherited: Finding[] } {
  const carriedOver = new Set(collectHits(previous).map(keyOf));
  const introduced: Finding[] = [];
  const inherited: Finding[] = [];
  for (const hit of hits) {
    const finding = { path: hit.path, pattern: hit.pattern };
    (carriedOver.has(keyOf(hit)) ? inherited : introduced).push(finding);
  }
  return { introduced, inherited };
}

function keyOf(hit: Hit): string {
  // NUL separator: a path can contain dots and a value can contain anything,
  // so any printable delimiter risks two different (path, value) pairs
  // colliding onto one key.
  return `${hit.path}\u0000${hit.value}`;
}

function collectHits(config: unknown, prefix = ""): Hit[] {
  const hits: Hit[] = [];
  walk(config, prefix, hits);
  return hits;
}

function walk(value: unknown, path: string, hits: Hit[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const { name, regex } of PATTERNS) {
      if (regex.test(value)) {
        hits.push({ path, pattern: name, value });
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, hits));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, hits);
    }
  }
}

/**
 * Paths already reported as carrying a pre-existing plaintext secret, so the
 * warning below fires once per process instead of once per config write. Holds
 * `path` and pattern name only — never a value; the point of the report is that
 * the value must not be logged.
 */
const reportedInheritedPaths = new Set<string>();

/** Exposed only for unit-testing the once-per-process report; do not call in app code. */
export function _resetInheritedSecretReports(): void {
  reportedInheritedPaths.clear();
}

/**
 * Throw if `config` introduces a plaintext secret.
 *
 * `readPrevious` supplies the config currently on disk, for writes that spread
 * existing content through; omit it to judge the whole tree, which is the right
 * call for a payload Pinchy built from scratch. It is a thunk because a clean
 * config — the overwhelmingly common case — has nothing to exempt: no baseline
 * is read and no second tree is walked unless the payload actually matched.
 */
export function assertNoPlaintextSecrets(config: unknown, readPrevious?: () => unknown): void {
  const hits = collectHits(config);
  if (hits.length === 0) return;

  const { introduced, inherited } = partition(hits, readPrevious?.());

  // Report before throwing: an inherited leak is still a leak, and staying
  // quiet about it is how it survived every upgrade so far. Paths and pattern
  // names only — never the value. Once per process per path: an affected
  // install writes this config on every boot seed, settings save and agent
  // create, and a paragraph repeated that often stops being read.
  const unreported = inherited.filter((h) => !reportedInheritedPaths.has(`${h.path}|${h.pattern}`));
  if (unreported.length > 0) {
    for (const h of unreported) reportedInheritedPaths.add(`${h.path}|${h.pattern}`);
    console.warn(
      "[openclaw-config] Carrying pre-existing plaintext secrets through this " +
        "config write (Pinchy did not add them; refusing the write would not " +
        "remove them):\n" +
        unreported.map((h) => `  ${h.path} matches ${h.pattern}`).join("\n") +
        "\nInstalls upgraded from a pre-SecretRef Pinchy still carry a top-level " +
        "`env` block holding raw provider keys. Pinchy resolves provider keys " +
        "from the secrets file, so an entry whose provider is configured under " +
        "Settings is obsolete: rotate that key and delete the entry to clear this."
    );
  }

  if (introduced.length > 0) {
    const msg = introduced.map((h) => `  ${h.path} matches ${h.pattern}`).join("\n");
    throw new Error(`plaintext secret detected in config:\n${msg}`);
  }
}
