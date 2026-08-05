/**
 * The environment-variable reference, read against docker-compose.yml (#1082).
 *
 * Before this page existed, the variables a self-hoster sets were spread across
 * `installation.mdx` (secrets, ports), `customizing-deployment.mdx` (resource
 * limits) and `enterprise-setup.mdx` (the licence key), with no page listing
 * them all. Nobody could answer "what can I put in `.env`?" without reading
 * three guides and the Compose file.
 *
 * A consolidated list is only worth having if it stays true, so it is derived
 * rather than trusted: `findUndocumentedVariables` reads every `${VAR}` out of
 * the shipped `docker-compose.yml` and fails when the page omits one, and
 * `findGhostVariables` fails on the opposite — a documented variable that
 * Compose never expands.
 *
 * The second direction is the one that costs a reader real time, and it is not
 * hypothetical here. `AUDIT_HMAC_SECRET` was documented in `installation.mdx`
 * as something to set in `.env`; the app read it, but the production Compose
 * file never forwarded it, so setting it did exactly nothing. That is the
 * `findGhostEndpoints` lesson from AGENTS.md in a different file: an
 * undocumented variable costs a grep, a documented one that isn't wired costs
 * an afternoon. It is forwarded now — the ghost check is what would catch the
 * next one.
 *
 * Defaults are checked too. A default is the single most copied fact on a
 * reference page — it is what a reader assumes when they *don't* set the
 * variable — and `${PINCHY_MEM_LIMIT:-1g}` states it precisely enough that no
 * one should ever have to trust prose for it.
 */

/**
 * Variables the app reads but the shipped `docker-compose.yml` does not pass
 * through, so they are documented with that caveat rather than as ordinary
 * knobs. Each entry must say what is true, because the page repeats it.
 *
 * This is not a way to silence the ghost check — an entry here is a claim that
 * the gap is known and deliberate, and `assertReadNotForwardedAreAbsent` fails
 * the moment Compose starts forwarding one, so the caveat cannot outlive the
 * bug it describes.
 */
export const READ_NOT_FORWARDED = {
  // Deliberately empty. `AUDIT_HMAC_SECRET` was the only entry and Compose now
  // forwards it, so `assertReadNotForwardedAreAbsent` would reject it — which
  // is the mechanism working, not a reason to keep the caveat. The map stays so
  // the next genuinely-unwired variable has somewhere honest to land.
};

/** `${VAR}`, `${VAR:-default}`, `${VAR:?message}`. */
const COMPOSE_VAR = /\$\{([A-Z_][A-Z0-9_]*)(?::([-?])([^}]*))?\}/g;

/**
 * Every variable the Compose file expands, with the default it falls back to.
 *
 * @param {string} composeSource contents of docker-compose.yml
 * @returns {Map<string, {default: string|null, required: boolean}>}
 */
export function extractComposeVariables(composeSource) {
  const found = new Map();
  for (const [, name, kind, rest] of composeSource.matchAll(COMPOSE_VAR)) {
    const required = kind === "?";
    const fallback = kind === "-" ? rest : null;
    const prev = found.get(name);
    // A variable used twice keeps the more specific reading: a stated default
    // beats none, and "required" beats a default (PINCHY_VERSION is `:?` in
    // both image tags, DB_PASSWORD is `:-pinchy_dev` in two places).
    if (!prev) {
      found.set(name, { default: fallback, required });
    } else {
      found.set(name, {
        default: prev.default ?? fallback,
        required: prev.required || required,
      });
    }
  }
  if (found.size === 0) {
    throw new Error(
      "docker-compose.yml: no ${VAR} expansions found. Either the file moved " +
        "or the pattern stopped matching — both make this guard vacuous.",
    );
  }
  return found;
}

/**
 * Every name that appears as a key in any `environment:` block, in either
 * spelling Compose accepts:
 *
 *   - `- NAME=${NAME:-}` — the explicit form, also caught by `COMPOSE_VAR`
 *   - `- NAME`           — pass-through, which forwards the host value and
 *                          contains no `${…}` at all
 *
 * The second form is why this exists. `assertReadNotForwardedAreAbsent` claims
 * a caveat cannot outlive the gap it describes, and reading only `${VAR}`
 * expansions would break that claim on the likelier of the two ways somebody
 * wires `AUDIT_HMAC_SECRET` up — the exception would stay green while the page
 * kept telling readers the variable does nothing.
 *
 * @param {string} composeSource contents of docker-compose.yml
 * @returns {Set<string>}
 */
export function extractForwardedEnvNames(composeSource) {
  const names = new Set();
  let inEnvironment = false;
  let blockIndent = 0;
  for (const line of composeSource.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (inEnvironment && indent <= blockIndent) inEnvironment = false;
    const header = /^(\s*)environment:\s*$/.exec(line);
    if (header) {
      inEnvironment = true;
      blockIndent = header[1].length;
      continue;
    }
    if (!inEnvironment) continue;
    const entry = /^\s*-\s*([A-Z_][A-Z0-9_]*)\s*(=|$)/.exec(line);
    if (entry) names.add(entry[1]);
  }
  return names;
}

/**
 * Variables the reference page documents, with the default it states.
 *
 * Reads the markdown table rows: `| \`NAME\` | \`default\` | description |`.
 * A row whose default cell is `—` or `_auto_` documents "no default"; anything
 * in backticks is read as the literal default.
 *
 * @param {string} pageSource contents of the reference page
 * @returns {Map<string, {default: string|null}>}
 */
export function extractDocumentedVariables(pageSource) {
  const found = new Map();
  const row = /^\|\s*`([A-Z_][A-Z0-9_]*)`\s*\|\s*([^|]*?)\s*\|/gm;
  for (const [, name, defaultCell] of pageSource.matchAll(row)) {
    const literal = /`([^`]*)`/.exec(defaultCell);
    found.set(name, { default: literal ? literal[1] : null });
  }
  if (found.size === 0) {
    throw new Error(
      "environment-variables.mdx: no `| `VAR` | … |` table rows found. If the " +
        "table's shape changed, change this reader with it.",
    );
  }
  return found;
}

/**
 * Compose expands it, the page never mentions it.
 *
 * @param {Map<string, unknown>} compose
 * @param {Map<string, unknown>} documented
 * @returns {string[]} problems (empty = ok)
 */
export function findUndocumentedVariables(compose, documented) {
  return [...compose.keys()]
    .filter((name) => !documented.has(name))
    .map(
      (name) =>
        `docker-compose.yml expands \${${name}} but the environment-variable ` +
        `reference never documents it. Add a row for it.`,
    );
}

/**
 * The page documents it, Compose never expands it.
 *
 * @param {Map<string, unknown>} compose
 * @param {Map<string, unknown>} documented
 * @param {Record<string, string>} [readNotForwarded]
 * @returns {string[]} problems (empty = ok)
 */
export function findGhostVariables(
  compose,
  documented,
  readNotForwarded = READ_NOT_FORWARDED,
) {
  return [...documented.keys()]
    .filter((name) => !compose.has(name) && !(name in readNotForwarded))
    .map(
      (name) =>
        `the environment-variable reference documents ${name}, which ` +
        `docker-compose.yml never expands — setting it would do nothing. ` +
        `Remove the row, or add it to READ_NOT_FORWARDED with what is true.`,
    );
}

/**
 * Rows whose stated default is not the one Compose falls back to.
 *
 * @param {Map<string, {default: string|null, required: boolean}>} compose
 * @param {Map<string, {default: string|null}>} documented
 * @returns {string[]} problems (empty = ok)
 */
export function findWrongDefaults(compose, documented) {
  const problems = [];
  for (const [name, doc] of documented) {
    const actual = compose.get(name);
    if (!actual) continue;
    if (actual.required) {
      if (doc.default !== null) {
        problems.push(
          `${name}: the reference states a default of \`${doc.default}\`, but ` +
            `docker-compose.yml makes it required (\${${name}:?…}).`,
        );
      }
      continue;
    }
    // An empty Compose fallback (`${X:-}`) is "unset", which the page states as
    // prose rather than a backticked literal — both readings are "no value".
    const composeDefault = actual.default === "" ? null : actual.default;
    if (composeDefault !== doc.default) {
      problems.push(
        `${name}: the reference states a default of ` +
          `${doc.default === null ? "none" : `\`${doc.default}\``}, but ` +
          `docker-compose.yml falls back to ` +
          `${composeDefault === null ? "none" : `\`${composeDefault}\``}.`,
      );
    }
  }
  return problems;
}

/**
 * A `READ_NOT_FORWARDED` entry that Compose now forwards after all.
 *
 * The caveat must not outlive the gap: once the variable is wired, the page
 * should describe it as an ordinary knob and the exception should go.
 *
 * @param {Map<string, unknown>} compose
 * @param {Set<string>} forwarded names from every `environment:` block
 * @param {Record<string, string>} [readNotForwarded]
 * @returns {string[]} problems (empty = ok)
 */
export function assertReadNotForwardedAreAbsent(
  compose,
  forwarded,
  readNotForwarded = READ_NOT_FORWARDED,
) {
  const problems = [];
  for (const [name, reason] of Object.entries(readNotForwarded)) {
    if (compose.has(name) || forwarded.has(name)) {
      problems.push(
        `READ_NOT_FORWARDED lists ${name}, but docker-compose.yml now passes ` +
          `it through. Drop the exception and document it as a normal variable ` +
          `— the page still tells readers that setting it does nothing.`,
      );
    }
    if (reason.trim().length < 30) {
      problems.push(`READ_NOT_FORWARDED["${name}"] needs a real reason`);
    }
  }
  return problems;
}
