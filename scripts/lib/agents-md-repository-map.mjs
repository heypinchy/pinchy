/**
 * Drift guard for the plugin list in AGENTS.md § "Repository Map".
 *
 * That bullet is a hand-maintained list mirroring a directory listing, sitting
 * in the very file that argues such lists will be wrong (§ "A Hand-Maintained
 * List That Mirrors Code Will Be Wrong") — and it was: `pinchy-knowledge`
 * shipped with its own manifest, the `knowledge_search` tool and E2E coverage,
 * and the sentence naming "current Pinchy plugins" named eight of nine. Every
 * agent session starts by reading that sentence, so the cost is paid over and
 * over, and nothing else in CI reads this file.
 *
 * The list is checked in BOTH directions: a plugin on disk the prose omits, and
 * a name the prose keeps after its directory is gone. The second half is the
 * one a code → docs check is structurally blind to, and the more expensive one
 * to a reader — an omitted plugin costs a `ls`, a phantom one costs a search
 * for something that is not there.
 *
 * Scope: this reads ONE bullet. The Repository Map names eight other paths
 * (`config/`, `plans/`, `sample-data/`, `marketplace/`, …) and nothing checks
 * that any of them still exists — a green run here is not a statement about
 * the section as a whole. The plugin list is singled out because it is the one
 * that enumerates a directory's contents rather than naming a single path, and
 * so is the one that goes stale by addition, silently.
 *
 * Sibling of `agents-md-commands.mjs`, which reads the same file's bash blocks.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SECTION_NAME = "Repository Map";
// Built from the name so the two cannot drift apart. Safe as a pattern: the
// heading is plain words, with nothing a regex reads as syntax.
const SECTION_HEADING = new RegExp(`^## ${SECTION_NAME}[ \\t]*$`, "m");
const NEXT_SECTION = /^## /m;
const PLUGINS_BULLET = /^-\s+`packages\/plugins\/`.*$/m;
const MARKER = "Current Pinchy plugins:";
const BACKTICKED = /`([^`]+)`/g;

/**
 * The `## Repository Map` section, up to the next `## ` heading.
 *
 * Both ends are anchored to a line start. An unanchored search for the heading
 * would accept `### Repository Map` — which contains it as a substring — and
 * then stop at the real heading, so the guard would report on a subsection in
 * place of the section it names.
 */
function repositoryMapSection(markdown) {
  const heading = markdown.match(SECTION_HEADING);
  if (!heading) {
    throw new Error(
      `AGENTS.md has no "${SECTION_NAME}" section — this guard cannot read it`,
    );
  }
  const rest = markdown.slice(heading.index + heading[0].length);
  const end = rest.search(NEXT_SECTION);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The list is a sentence, not a line: everything up to the first period outside
 * a code span. A bullet may carry more prose after the list — the pointer at
 * this guard does — and reading to the line end takes the backticks out of it
 * as further plugin names.
 */
function listSentence(text) {
  let inCode = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "`") inCode = !inCode;
    else if (text[i] === "." && !inCode) return text.slice(0, i);
  }
  return text;
}

/**
 * The plugin names documented in AGENTS.md § "Repository Map".
 *
 * Throws rather than returning a short list on input it cannot read: a guard
 * that answers "none documented" to a reworded sentence reports every plugin as
 * missing, and one that answers "all documented" reports nothing at all. Both
 * are verdicts about the prose that the guard is in no position to give.
 *
 * @param {string} markdown contents of AGENTS.md
 * @returns {string[]} plugin directory names, in the order the prose lists them
 */
export function extractRepositoryMapPlugins(markdown) {
  const section = repositoryMapSection(markdown);

  const bullet = section.match(PLUGINS_BULLET)?.[0];
  if (!bullet) {
    throw new Error(
      `AGENTS.md § "${SECTION_NAME}" has no \`packages/plugins/\` bullet — this guard cannot read it`,
    );
  }

  const markerAt = bullet.indexOf(MARKER);
  if (markerAt === -1) {
    throw new Error(
      `AGENTS.md's \`packages/plugins/\` bullet no longer says "${MARKER}" — this guard cannot read it:\n  ${bullet}`,
    );
  }

  const names = [
    ...listSentence(bullet.slice(markerAt + MARKER.length)).matchAll(
      BACKTICKED,
    ),
  ].map(([, name]) => name);
  if (names.length === 0) {
    throw new Error(
      `AGENTS.md's \`packages/plugins/\` bullet says "${MARKER}" but lists no plugin names:\n  ${bullet}`,
    );
  }
  return names;
}

/**
 * Every plugin directory under `packages/plugins/`.
 *
 * A directory counts as a plugin when it carries an `openclaw.plugin.json` —
 * what actually makes it one — rather than by matching `pinchy-*`. A plugin
 * added under a different name would otherwise be exempt from the prose by
 * virtue of its name, which is the drift one level up.
 *
 * @param {string} repoRoot
 * @returns {string[]} directory names, sorted
 */
export function discoverPluginPackages(repoRoot) {
  const pluginsDir = join(repoRoot, "packages", "plugins");
  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read packages/plugins: ${err.message}`);
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(
          join(pluginsDir, name, "openclaw.plugin.json"),
        ).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** `` `a`, `b` `` — the names as the bullet would spell them. */
function quoted(names) {
  return names.map((name) => `\`${name}\``).join(", ");
}

/**
 * @param {string[]} documented names from AGENTS.md § "Repository Map"
 * @param {string[]} actual plugin directories on disk
 * @returns {string[]} problems (empty = ok)
 */
export function checkRepositoryMapPlugins(documented, actual) {
  const problems = [];
  const section = `AGENTS.md § "${SECTION_NAME}"`;

  const missing = actual.filter((name) => !documented.includes(name));
  if (missing.length > 0) {
    const [is, them] =
      missing.length === 1 ? ["is a plugin", "it"] : ["are plugins", "them"];
    problems.push(
      `${section} does not name ${quoted(missing)}, which ${is} in ` +
        `packages/plugins/. Add ${them} to the "${MARKER}" list.`,
    );
  }

  const phantom = documented.filter((name) => !actual.includes(name));
  if (phantom.length > 0) {
    const [exists, them] =
      phantom.length === 1 ? ["exists", "it"] : ["exist", "them"];
    problems.push(
      `${section} names ${quoted(phantom)}, which no longer ${exists} under ` +
        `packages/plugins/. Remove ${them} from the "${MARKER}" list.`,
    );
  }

  return problems;
}
