/**
 * Which host interfaces a compose file's `ports:` entries publish on.
 *
 * A short-form entry with no host IP — `"5434:5432"` — binds `0.0.0.0`. Every
 * test overlay was written that way, so on any shared dev or CI host the test
 * Postgres instances, each suite's Pinchy override and all eight mock servers
 * answered the whole network. The fix is one token per line
 * (`"127.0.0.1:5434:5432"`), which is exactly the kind of convention that holds
 * until the next overlay is added and nobody remembers it. Hence a parser
 * rather than a habit.
 *
 * Two readings matter and they are deliberately the same one:
 *
 * - `${VAR:-default}` resolves to its default, because that is what a checkout
 *   without a `.env` actually binds. `dev-stack-port-isolation.test.mjs` was
 *   already reading compose ports that way with its own copy of this logic;
 *   both now share this module, so the two questions ("which port" and "which
 *   interface") cannot come apart.
 * - Passing an `env` resolves against a concrete `.env` instead — how the dev
 *   overlay behaves once `pnpm worktree:env` has run, which is a different
 *   binding from the default one and has to be checked separately.
 *
 * The scan is scoped to `ports:` blocks and **throws** on an entry it cannot
 * read, rather than skipping it. A guard that silently ignores the long syntax
 * (`- target: 9001` / `published: 9001`, which also binds every interface when
 * `host_ip` is omitted) reports on the lines it happens to understand, not on
 * what the stack binds.
 */

/**
 * Host IPs that reach no further than the machine itself. `localhost` is
 * accepted because Docker resolves it, though nothing here uses it.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Anything in 127.0.0.0/8 is loopback, not just .0.1. */
export function isLoopbackHost(host) {
  if (host === null || host === undefined) return false;
  return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Substitute `${VAR}` and `${VAR:-default}`. A name present in `env` wins over
 * the default — that is the whole difference between "what a fresh checkout
 * binds" and "what this worktree binds".
 *
 * @param {string} value
 * @param {Record<string, string>} env
 */
export function expandComposeVars(value, env = {}) {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name, fallback) => env[name] ?? fallback ?? "",
  );
}

/** A port number or a `3000-3005` range, as Compose writes them. */
const PORT_OR_RANGE = /^\d+(-\d+)?$/;

/**
 * Split one resolved short-form entry into its parts.
 *
 * @param {string} resolved
 * @returns {{hostIp: string|null, hostPort: string|null, containerPort: string}}
 */
function parseShortForm(resolved) {
  const proto = /\/(tcp|udp|sctp)$/i.exec(resolved);
  const bare = proto ? resolved.slice(0, -proto[0].length) : resolved;

  // An IPv6 host IP is bracketed: "[::1]:8080:80".
  const bracketed = /^(\[[^\]]+\]):(.*)$/.exec(bare);
  const head = bracketed ? bracketed[1] : null;
  const parts = (bracketed ? bracketed[2] : bare).split(":");

  const shape = `${head ? "ip+" : ""}${parts.length}`;
  const [hostIp, hostPort, containerPort] = {
    // "[::1]:8080:80"
    "ip+2": [head, parts[0], parts[1]],
    // "9100" — a random host port on every interface.
    1: [null, null, parts[0]],
    // "5434:5432"
    2: [null, parts[0], parts[1]],
    // "127.0.0.1:5434:5432"
    3: [parts[0], parts[1], parts[2]],
  }[shape] ?? [undefined, undefined, undefined];

  if (containerPort === undefined) {
    throw new Error(
      `cannot read the port entry "${resolved}": ${parts.length + (head ? 1 : 0)} ` +
        `colon-separated fields. A doubled host IP ` +
        `("127.0.0.1:127.0.0.1:5434:5432") looks exactly like this — check ` +
        `whether a variable already carries the prefix the compose file adds.`,
    );
  }
  if (!PORT_OR_RANGE.test(containerPort)) {
    throw new Error(
      `cannot read the port entry "${resolved}": "${containerPort}" is not a ` +
        `container port.`,
    );
  }
  if (hostPort !== null && !PORT_OR_RANGE.test(hostPort)) {
    throw new Error(
      `cannot read the port entry "${resolved}": "${hostPort}" is not a host port.`,
    );
  }
  return { hostIp, hostPort, containerPort };
}

/** Lines belonging to each `ports:` block, keyed by the block's start line. */
function portsBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)ports:(.*)$/.exec(lines[i]);
    if (!header) continue;
    const indent = header[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") continue;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      body.push({ line, number: j + 1 });
    }
    blocks.push({ body, number: i + 1 });
  }
  return blocks;
}

/**
 * Every host-port publish a compose file declares.
 *
 * @param {string} text compose file contents
 * @param {Record<string, string>} env values from a `.env`, overriding defaults
 * @returns {{raw: string, resolved: string, hostIp: string|null, hostPort: string|null, containerPort: string, line: number}[]}
 */
export function publishedPortEntries(text, env = {}) {
  const entries = [];
  for (const block of portsBlocks(text)) {
    for (const { line, number } of block.body) {
      const trimmed = line.trim().replace(/\s+#.*$/, "");
      // The `!override` / `!reset` tag may sit on its own line under the key,
      // and a comment line carries nothing.
      if (trimmed.startsWith("#") || /^![a-z]+$/.test(trimmed)) continue;

      const item = /^-\s*(.*)$/.exec(trimmed);
      if (!item) {
        throw new Error(
          `line ${number}: ${JSON.stringify(line.trim())} is not a short-form ` +
            `port entry. The long syntax (target:/published:) publishes on ` +
            `every interface when host_ip is omitted — teach this parser to ` +
            `read it rather than letting it pass unread.`,
        );
      }
      const raw = item[1].replace(/^(["'])(.*)\1$/, "$2");
      if (raw.startsWith("target:") || raw.startsWith("published:")) {
        throw new Error(
          `line ${number}: ${JSON.stringify(raw)} is the long port syntax, ` +
            `which this parser cannot read. It publishes on every interface ` +
            `unless host_ip is set.`,
        );
      }
      const resolved = expandComposeVars(raw, env);
      try {
        entries.push({
          raw,
          resolved,
          line: number,
          ...parseShortForm(resolved),
        });
      } catch (err) {
        throw new Error(`line ${number}: ${err.message}`);
      }
    }
  }
  return entries;
}

/**
 * Host ports a compose file publishes, as numbers. `${VAR:-default}` resolves
 * to its default — what a checkout without `.env` binds. A random-port entry
 * ("9100") is not a claim on any particular port and is left out.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function publishedHostPorts(text) {
  return publishedPortEntries(text)
    .map((entry) => Number(entry.hostPort))
    .filter((port) => Number.isInteger(port));
}

/**
 * Entries that publish beyond the machine, each with the reason.
 *
 * @param {string} text
 * @param {Record<string, string>} env
 */
export function nonLoopbackPublishes(text, env = {}) {
  const offenders = [];
  for (const entry of publishedPortEntries(text, env)) {
    if (entry.hostPort === null) {
      offenders.push({
        ...entry,
        why: "publishes a random host port on every interface",
      });
    } else if (!isLoopbackHost(entry.hostIp)) {
      offenders.push({
        ...entry,
        why: entry.hostIp
          ? `binds ${entry.hostIp}`
          : "has no host IP, so Docker binds 0.0.0.0",
      });
    }
  }
  return offenders;
}
