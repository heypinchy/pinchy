/**
 * The office-converter sidecar's isolation is a property of docker-compose.yml,
 * not of any code — so it is pinned here, line by line.
 *
 * LibreOffice opens files anyone with write access to a mounted share can
 * plant. The boundary that holds when the profile and the preflight do not is
 * the container: no network, no secrets, no volume but the spool. Each
 * assertion below is one way that boundary could be quietly undone by an edit
 * that looks harmless in review — a "temporary" `networks:` for debugging, a
 * convenience mount of `/data`, an `env_file:` copied from the pinchy service.
 *
 * office-convert.sidecar.canary.test.ts proves the shipped service really has
 * no network, against the real image. This guard is what keeps the file it
 * runs from drifting between canary runs.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const WEB_ROOT = join(REPO_ROOT, "packages/web");
const read = (name: string) => readFileSync(join(REPO_ROOT, name), "utf8");

const COMPOSE = read("docker-compose.yml");
const SERVICE = "office-converter";

/** The lines of one service block (2-space service headers, 4-space keys). */
function serviceBlock(yaml: string, service: string): string[] | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start === -1) return null;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** Non-comment lines of the block, without comments at the end of a line. */
function meaningful(block: string[]): string[] {
  return block
    .filter((l) => !/^\s*#/.test(l) && l.trim() !== "")
    .map((l) => l.replace(/\s+#.*$/, ""));
}

function scalar(block: string[], key: string): string | undefined {
  const line = meaningful(block).find((l) => l.startsWith(`    ${key}:`));
  return line?.slice(`    ${key}:`.length).trim();
}

function list(block: string[], key: string): string[] {
  const lines = meaningful(block);
  const start = lines.findIndex((l) => l === `    ${key}:`);
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("      ")) break;
    items.push(
      line
        .trim()
        .replace(/^- /, "")
        .replace(/^"(.*)"$/, "$1")
    );
  }
  return items;
}

function hasKey(block: string[], key: string): boolean {
  return meaningful(block).some((l) => l.startsWith(`    ${key}:`));
}

/** `ENV KB_OFFICE_SPOOL_DIR=…` in a Dockerfile's runtime stage. */
function spoolDirOf(dockerfile: string): string | undefined {
  return read(dockerfile).match(/^ENV KB_OFFICE_SPOOL_DIR=(\S+)$/m)?.[1];
}

const converter = serviceBlock(COMPOSE, SERVICE);
const pinchy = serviceBlock(COMPOSE, "pinchy")!;
const SPOOL = spoolDirOf("Dockerfile.pinchy");

describe("office-converter sidecar isolation (docker-compose.yml)", () => {
  it("exists, and the production image tells the web process to use it", () => {
    expect(converter, `no "${SERVICE}" service in docker-compose.yml`).not.toBeNull();
    // Without this the web process would convert in-process again: the image,
    // not the compose file, is what every install runs.
    expect(SPOOL, "Dockerfile.pinchy must set ENV KB_OFFICE_SPOOL_DIR").toBeDefined();
  });

  it("has no network at all", () => {
    expect(scalar(converter!, "network_mode")).toBe("none");
    expect(hasKey(converter!, "networks"), "a networks: entry would give it one").toBe(false);
    expect(hasKey(converter!, "ports")).toBe(false);
    expect(hasKey(converter!, "extra_hosts")).toBe(false);
  });

  it("mounts the spool and nothing else — no config, no secrets, no corpus, no artifacts", () => {
    expect(list(converter!, "volumes")).toEqual([`pinchy-office-spool:${SPOOL}`]);
  });

  it("inherits no environment", () => {
    // The pinchy service's environment holds DATABASE_URL, ENCRYPTION_KEY and
    // BETTER_AUTH_SECRET. The converter needs none of it, so it gets nothing.
    expect(hasKey(converter!, "environment")).toBe(false);
    expect(hasKey(converter!, "env_file")).toBe(false);
  });

  it("runs unprivileged on a read-only root filesystem", () => {
    expect(scalar(converter!, "read_only")).toBe("true");
    expect(scalar(converter!, "user")).toBe('"999:999"');
    expect(list(converter!, "cap_drop")).toEqual(["ALL"]);
    expect(list(converter!, "security_opt")).toContain("no-new-privileges:true");
    expect(hasKey(converter!, "privileged")).toBe(false);
    expect(hasKey(converter!, "cap_add")).toBe(false);
  });

  it("runs the same image as the web process it serves, with the sidecar entrypoint", () => {
    expect(scalar(converter!, "image")).toBe(scalar(pinchy, "image"));
    const entrypoint = scalar(converter!, "entrypoint") ?? "";
    expect(entrypoint).toContain("src/server/office-converter.ts");
    expect(existsSync(join(WEB_ROOT, "src/server/office-converter.ts"))).toBe(true);
    expect(scalar(converter!, "working_dir")).toBe("/app/packages/web");
  });

  it("shares the spool with the web process at the same path", () => {
    // Same path in both containers: the protocol sends batch ids, and both
    // sides derive the same absolute paths from them.
    expect(list(pinchy, "volumes")).toContain(`pinchy-office-spool:${SPOOL}`);
    expect(COMPOSE).toMatch(/^ {2}pinchy-office-spool:$/m);
  });

  it("is the only service besides pinchy that can reach the socket", () => {
    for (const service of ["openclaw", "db"]) {
      const block = serviceBlock(COMPOSE, service)!;
      expect(
        list(block, "volumes").some((v) => v.startsWith("pinchy-office-spool:")),
        service
      ).toBe(false);
    }
  });

  it("the dev image points the web process at the same spool", () => {
    expect(spoolDirOf("Dockerfile.pinchy.dev")).toBe(SPOOL);
  });
});

describe("compose overlays keep the converter on the web process's image", () => {
  // An overlay that rebuilds or retags `pinchy` but leaves the converter on
  // `ghcr.io/heypinchy/pinchy:${PINCHY_VERSION}` would run a RELEASED image
  // next to the build under test — one that may not even have the sidecar
  // entrypoint, so every E2E stack would crash-loop it, or worse, test the
  // wrong converter.
  const overlays = readdirSync(REPO_ROOT).filter(
    (f) => /^docker-compose\..+\.yml$/.test(f) && f !== "docker-compose.yml"
  );

  it.each(overlays)("%s", (file) => {
    const yaml = read(file);
    const pinchyBlock = serviceBlock(yaml, "pinchy");
    const pinchyImage = pinchyBlock && scalar(pinchyBlock, "image");
    if (!pinchyImage) return;
    const converterBlock = serviceBlock(yaml, SERVICE);
    expect(converterBlock, `${file} overrides pinchy's image but not ${SERVICE}'s`).not.toBeNull();
    expect(scalar(converterBlock!, "image")).toBe(pinchyImage);
  });

  it("checks at least the e2e overlay", () => {
    expect(overlays).toContain("docker-compose.e2e.yml");
  });
});
