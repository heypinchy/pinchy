/**
 * AGENTS.md is loaded into every agent session and every subagent, so it
 * holds only the core rules. Rules for one area live in `agent-rules/*.md`,
 * and AGENTS.md's "## Topic Rules" section links each file with the trigger
 * for reading it. A topic file nobody links is a rule nobody reads; a link to
 * a missing file sends the reader nowhere. This module checks both, and that
 * no section heading exists in two places, so a moved rule cannot quietly
 * come back as a second, diverging copy.
 */

/** AGENTS.md was 172 KB before the topic split; the core is ~17 KB. */
export const AGENTS_MD_BYTE_BUDGET = 20 * 1024;

const INDEX_LINE = /^- `agent-rules\/([^`]+\.md)`(?: — (.*))?$/;

/**
 * @param {string} markdown AGENTS.md
 * @returns {Array<{file: string, trigger: string}>}
 */
export function extractTopicIndex(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l === "## Topic Rules");
  if (start < 0) {
    throw new Error(
      'AGENTS.md has no "## Topic Rules" section to read the topic index from',
    );
  }
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const m = INDEX_LINE.exec(line);
    if (m) entries.push({ file: m[1], trigger: (m[2] ?? "").trim() });
  }
  return entries;
}

/**
 * @param {Array<{file: string, trigger: string}>} index
 * @param {string[]} onDisk file names in agent-rules/
 * @returns {string[]} problems, empty when consistent
 */
export function checkTopicIndex(index, onDisk) {
  const problems = [];
  const linked = new Set(index.map((e) => e.file));
  for (const e of index) {
    if (!onDisk.includes(e.file)) {
      problems.push(
        `AGENTS.md links agent-rules/${e.file}, which does not exist`,
      );
    }
    if (!e.trigger) {
      problems.push(
        `AGENTS.md links agent-rules/${e.file} without a trigger (" — before …")`,
      );
    }
  }
  for (const f of onDisk) {
    if (!linked.has(f)) {
      problems.push(
        `agent-rules/${f} is not linked from AGENTS.md § "Topic Rules"`,
      );
    }
  }
  return problems;
}

/**
 * @param {Record<string, string>} files path -> markdown
 * @returns {string[]} one message per heading found in more than one file
 */
export function findDuplicateHeadings(files) {
  const seen = new Map();
  for (const [path, markdown] of Object.entries(files)) {
    let fence = false;
    for (const line of markdown.split(/\r?\n/)) {
      if (/^```/.test(line)) fence = !fence;
      if (fence) continue;
      const m = /^#{2,4} (.+)$/.exec(line);
      if (!m) continue;
      const owners = seen.get(m[1]) ?? new Set();
      owners.add(path);
      seen.set(m[1], owners);
    }
  }
  return [...seen]
    .filter(([, owners]) => owners.size > 1)
    .map(
      ([heading, owners]) =>
        `"${heading}" is a heading in ${[...owners].join(", ")}`,
    );
}
