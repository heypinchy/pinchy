import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  parseDockerfileStages,
  resolveStageChain,
  toolchainInChain,
  validateNativeBuildToolchain,
} from "./native-build-toolchain.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every Dockerfile in the repo, the way the guard is meant to be run. */
function readRepoDockerfiles() {
  const files = readdirSync(REPO_ROOT)
    .filter((name) => name.startsWith("Dockerfile"))
    .map((name) => ({ file: name, path: join(REPO_ROOT, name) }));

  const configDir = join(REPO_ROOT, "config");
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(configDir, entry.name, "Dockerfile");
    try {
      readFileSync(path);
    } catch {
      continue;
    }
    files.push({ file: `config/${entry.name}/Dockerfile`, path });
  }

  return files.map(({ file, path }) => ({
    file,
    text: readFileSync(path, "utf8"),
  }));
}

const TOOLCHAIN_APT =
  "RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential";

test("every Dockerfile stage that installs the workspace can compile from source", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const errors = validateNativeBuildToolchain({
    dockerfiles: readRepoDockerfiles(),
    onlyBuiltDependencies: pkg.pnpm?.onlyBuiltDependencies,
  });
  assert.deepEqual(errors, [], errors.join("\n\n"));
});

test("a stage that installs without a toolchain is reported, with the line to add", () => {
  // The 2026-08-05 failure, reduced: Dockerfile.pinchy.dev as it was, one apt
  // line for LibreOffice and a pnpm install with no way to compile.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.pinchy.dev",
        text: [
          "FROM node:22-slim",
          "RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer",
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Dockerfile\.pinchy\.dev/);
  assert.match(errors[0], /python3 and build-essential/);
  assert.match(errors[0], /better-sqlite3/);
  // A failure that does not print the fix gets the next person guessing.
  assert.match(errors[0], /apt-get install -y --no-install-recommends/);
});

test("python3 alone is not a fallback — it moves the dead end one message later", () => {
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.half",
        text: [
          "FROM node:22-slim",
          "RUN apt-get update && apt-get install -y --no-install-recommends python3",
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /without build-essential/);
});

test("a toolchain in an ancestor stage counts — that is how Dockerfile.pinchy is built", () => {
  // The toolchain lives in `base`; the installs run in `prod-deps` and
  // `build`. A check that read only the installing stage would call the
  // correct file broken, and the obvious fix would be to duplicate the apt
  // line into the runtime stage — shipping 306 MB nothing needs.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.pinchy",
        text: [
          "FROM node:22-slim AS base",
          TOOLCHAIN_APT,
          "FROM base AS prod-deps",
          "RUN pnpm install --prod --frozen-lockfile",
          "FROM base AS build",
          "RUN pnpm install --frozen-lockfile",
          "FROM node:22-slim AS runtime",
          "COPY --from=prod-deps /app/node_modules ./node_modules",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.deepEqual(errors, []);
});

test("a comment naming the packages is not the packages", () => {
  // These Dockerfiles explain their apt lines in prose directly above them.
  // A guard that matched text would read the explanation of a DELETED install
  // as the install — the same "reports on the presence of a string" failure
  // the skip and format guards were both bitten by.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.commented",
        text: [
          "FROM node:22-slim",
          "# python3 + build-essential are needed for native npm modules.",
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /without python3 and build-essential/);
});

test("a mock image installing its own manifest with npm is out of scope", () => {
  // config/*-mock images run `npm install` against express/imapflow/nodemailer.
  // Demanding a toolchain in seven images to protect a dependency they do not
  // have would be worse than the gap. Stated as a limitation in the module,
  // pinned here so nobody widens the match to `npm install` by reflex.
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "config/brave-mock/Dockerfile",
        text: ["FROM node:22-slim", "RUN npm install --omit=dev"].join("\n"),
      },
      {
        file: "Dockerfile.pinchy.dev",
        text: [
          "FROM node:22-slim",
          TOOLCHAIN_APT,
          "RUN pnpm install --frozen-lockfile",
        ].join("\n"),
      },
    ],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.deepEqual(errors, []);
});

test("finding no install stage fails instead of passing on an empty comparison", () => {
  const errors = validateNativeBuildToolchain({
    dockerfiles: [{ file: "Dockerfile.none", text: "FROM node:22-slim" }],
    onlyBuiltDependencies: ["better-sqlite3"],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No Dockerfile stage running/);
});

test("an empty onlyBuiltDependencies removes the premise, and says so", () => {
  const errors = validateNativeBuildToolchain({
    dockerfiles: [
      {
        file: "Dockerfile.pinchy.dev",
        text: ["FROM node:22-slim", "RUN pnpm install"].join("\n"),
      },
    ],
    onlyBuiltDependencies: [],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /onlyBuiltDependencies is empty/);
});

test("parseDockerfileStages joins continuations and attributes RUNs to their stage", () => {
  const stages = parseDockerfileStages(
    [
      "FROM node:22-slim AS base",
      "RUN apt-get update \\",
      "    && apt-get install -y --no-install-recommends \\",
      "       python3 build-essential \\",
      "    && rm -rf /var/lib/apt/lists/*",
      "FROM base AS build",
      "RUN pnpm install",
    ].join("\n"),
  );
  assert.equal(stages.length, 2);
  assert.equal(stages[0].name, "base");
  assert.equal(stages[1].parent, "base");
  assert.equal(stages[0].runs.length, 1);
  assert.match(stages[0].runs[0], /python3 build-essential/);
  assert.deepEqual(stages[1].runs, ["pnpm install"]);
});

test("resolveStageChain terminates on a self-referential FROM", () => {
  // A malformed Dockerfile must fail as a message, never as a hang.
  const stages = parseDockerfileStages(
    ["FROM loop AS loop", "RUN pnpm install"].join("\n"),
  );
  const chain = resolveStageChain(stages, 0);
  assert.equal(chain.length, 1);
  assert.deepEqual(toolchainInChain(chain), { python: false, compiler: false });
});

test("the real Dockerfile.pinchy keeps the toolchain out of the runtime stage", () => {
  // The whole reason prod pays nothing for this. If a future edit moves the
  // apt line into `runtime`, the guard above still passes — so assert the
  // other half here.
  const stages = parseDockerfileStages(
    readFileSync(join(REPO_ROOT, "Dockerfile.pinchy"), "utf8"),
  );
  const runtime = stages.find((stage) => stage.name === "runtime");
  assert.ok(runtime, "Dockerfile.pinchy has no `runtime` stage any more");
  assert.deepEqual(toolchainInChain(resolveStageChain(stages, runtime.index)), {
    python: false,
    compiler: false,
  });
});
