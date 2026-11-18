import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  AGENTS_MD_BYTE_BUDGET,
  extractTopicIndex,
  checkTopicIndex,
  findDuplicateHeadings,
} from "./agents-md-topics.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOPIC_DIR = join(REPO_ROOT, "agent-rules");

function agentsMd(bullets) {
  return [
    "# AGENTS.md - Pinchy",
    "",
    "## Topic Rules",
    "",
    "Intro.",
    "",
    ...bullets,
    "",
    "- Never do X. → `testing.md`",
    "",
    "## Commands",
    "",
    "- `agent-rules/ghost.md` — outside the index, so not a link.",
  ].join("\n");
}

test("extractTopicIndex reads each indexed file with its trigger", () => {
  const md = agentsMd([
    "- `agent-rules/testing.md` — before skipping a test.",
    "- `agent-rules/ci.md` — before changing a workflow.",
  ]);
  assert.deepEqual(extractTopicIndex(md), [
    { file: "testing.md", trigger: "before skipping a test." },
    { file: "ci.md", trigger: "before changing a workflow." },
  ]);
});

test("extractTopicIndex throws when the Topic Rules section is missing", () => {
  // An absent index must not read as "nothing to check".
  assert.throws(
    () => extractTopicIndex("# AGENTS.md\n\n## Commands\n"),
    /Topic Rules/,
  );
});

test("checkTopicIndex reports an unlinked file, a dangling link and a missing trigger", () => {
  const problems = checkTopicIndex(
    [
      { file: "testing.md", trigger: "before skipping a test." },
      { file: "gone.md", trigger: "before nothing." },
      { file: "ci.md", trigger: "" },
    ],
    ["testing.md", "ci.md", "orphan.md"],
  );
  assert.equal(problems.length, 3);
  assert.match(problems.join("\n"), /gone\.md/);
  assert.match(problems.join("\n"), /orphan\.md/);
  assert.match(problems.join("\n"), /ci\.md.*trigger/);
});

test("findDuplicateHeadings names a heading that lives in two files", () => {
  const dupes = findDuplicateHeadings({
    "AGENTS.md": "## Commands\n\n### Shared\n",
    "agent-rules/a.md":
      "# A\n\n## Shared Thing\n\n```md\n## Shared Thing\n```\n",
    "agent-rules/b.md": "# B\n\n## Shared Thing\n",
  });
  assert.equal(dupes.length, 1);
  assert.match(dupes[0], /Shared Thing.*a\.md.*b\.md/);
});

test("the real AGENTS.md indexes exactly the files in agent-rules/", () => {
  const markdown = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  const onDisk = readdirSync(TOPIC_DIR).filter((f) => f.endsWith(".md"));
  // Corpus floor: a reader that found nothing would agree with an empty dir.
  assert.ok(onDisk.length >= 10, `only found ${onDisk.length} topic files`);
  assert.deepEqual(checkTopicIndex(extractTopicIndex(markdown), onDisk), []);
});

test("no section heading lives in more than one agent instruction file", () => {
  const files = {
    "AGENTS.md": readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
  };
  for (const f of readdirSync(TOPIC_DIR).filter((n) => n.endsWith(".md"))) {
    files[`agent-rules/${f}`] = readFileSync(join(TOPIC_DIR, f), "utf8");
  }
  assert.deepEqual(findDuplicateHeadings(files), []);
});

test("AGENTS.md stays within its byte budget", () => {
  // AGENTS.md is loaded into every session and every subagent. It reached
  // 172 KB before the topic rules moved out; a rule for one area goes into
  // agent-rules/, not back in here.
  const bytes = readFileSync(join(REPO_ROOT, "AGENTS.md")).length;
  assert.ok(
    bytes <= AGENTS_MD_BYTE_BUDGET,
    `AGENTS.md is ${bytes} bytes, budget is ${AGENTS_MD_BYTE_BUDGET}. Move the new rule into a file under agent-rules/ and link it from § "Topic Rules".`,
  );
});
