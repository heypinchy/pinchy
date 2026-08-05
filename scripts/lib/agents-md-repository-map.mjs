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
 * Sibling of `agents-md-commands.mjs`, which reads the same file's bash blocks.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SECTION_NAME = "Repository Map";
const SECTION_HEADING = `## ${SECTION_NAME}`;
const PLUGINS_BULLET = /^-\s+`packages\/plugins\/`.*$/m;
const MARKER = "Current Pinchy plugins:";
const BACKTICKED = /`([^`]+)`/g;

/** The `## Repository Map` section, up to the next `## ` heading. */
function repositoryMapSection(markdown) {
  const start = markdown.indexOf(SECTION_HEADING);
  if (start === -1) {
    throw new Error(
      `AGENTS.md has no "${SECTION_NAME}" section — this guard cannot read it`,
    );
  }
  const rest = markdown.slice(start + SECTION_HEADING.length);
  const end = rest.search(/^## /m);
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

/**
 * @param {string[]} documented names from AGENTS.md § "Repository Map"
 * @param {string[]} actual plugin directories on disk
 * @returns {string[]} problems (empty = ok)
 */
export function checkRepositoryMapPlugins(documented, actual) {
  const problems = [];

  const missing = actual.filter((name) => !documented.includes(name));
  if (missing.length > 0) {
    problems.push(
      `AGENTS.md § "${SECTION_NAME}" does not name ${missing
        .map((name) => `\`${name}\``)
        .join(
          ", ",
        )}, which ${missing.length === 1 ? "is a plugin" : "are plugins"} in packages/plugins/. Add ${missing.length === 1 ? "it" : "them"} to the "${MARKER}" list.`,
    );
  }

  const phantom = documented.filter((name) => !actual.includes(name));
  if (phantom.length > 0) {
    problems.push(
      `AGENTS.md § "${SECTION_NAME}" names ${phantom
        .map((name) => `\`${name}\``)
        .join(
          ", ",
        )}, which no longer ${phantom.length === 1 ? "exists" : "exist"} under packages/plugins/. Remove ${phantom.length === 1 ? "it" : "them"} from the "${MARKER}" list.`,
    );
  }

  return problems;
}
