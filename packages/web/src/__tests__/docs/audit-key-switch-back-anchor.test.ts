import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  AUDIT_KEY_SWITCH_BACK_DOCS_URL,
  AUDIT_KEY_SWITCH_DOCS_URL,
  describeAuditKeyFilePersist,
  describeIgnoredSecretEnv,
  KEY_VARIABLE_IGNORED_DOCS_URL,
  evaluateAuditSecretRotation,
} from "@/lib/secret-source";
import { describeKeyCheck, runKeyCheck } from "@/lib/key-check";
import type { SecretInspection } from "@/lib/encryption";
import { startAuditVerifyJob, stopAuditVerifyJob } from "@/server/audit-verify-job";

// A database that is never there: the only thing this file needs from the
// verify job is the line it logs when a sweep fails.
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("database unreachable");
      },
    }
  ),
}));

const repoRoot = resolve(__dirname, "../../../../..");
const docsRoot = resolve(repoRoot, "docs/src/content/docs");
const pagePath = resolve(docsRoot, "concepts/audit-trail-verification.mdx");
const envVarsPagePath = resolve(docsRoot, "reference/environment-variables.mdx");

function headingSlugs(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter((line) => /^#{2,6} /.test(line))
    .map((line) =>
      line
        .replace(/^#{2,6} /, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ /g, "-")
    );
}

function expectExistingSection(
  docsUrl: string,
  page: { pathname: string; path: string } = {
    pathname: "/concepts/audit-trail-verification/",
    path: pagePath,
  }
) {
  const url = new URL(docsUrl);
  expect(url.origin).toBe("https://docs.heypinchy.com");
  expect(url.pathname).toBe(page.pathname);
  expect(headingSlugs(page.path)).toContain(url.hash.slice(1));
}

describe("the audit-key startup notices link to sections that exist", () => {
  it("names a docs page and heading that the docs source carries", () => {
    // The notice is printed on every start while AUDIT_HMAC_SECRET differs from
    // the key file. check:anchors only reads links in the built docs, never a
    // URL inside a server log line, so a renamed heading would leave the notice
    // pointing at nothing without any check going red.
    expectExistingSection(AUDIT_KEY_SWITCH_BACK_DOCS_URL);
  });

  it("points the failed-key-file warning at the switching procedure", () => {
    // Printed when the variable's value could not be written to the key file:
    // the operator needs the one procedure that says what to do before a switch.
    expectExistingSection(AUDIT_KEY_SWITCH_DOCS_URL);
  });

  it("points the ignored-key-variable warnings at the safe steps", () => {
    // Printed on every start while ENCRYPTION_KEY or AUDIT_HMAC_SECRET is
    // malformed. The obvious "fix" makes every stored credential unreadable,
    // or, for a variable that used to work, leaves everything it signed
    // unverifiable, so the section it links to is the only place the safe
    // steps are spelled out.
    expectExistingSection(KEY_VARIABLE_IGNORED_DOCS_URL, {
      pathname: "/reference/environment-variables/",
      path: envVarsPagePath,
    });
  });
});

describe("the retire-the-earlier-key steps quote log lines Pinchy prints", () => {
  // Step 3 makes removing the key file conditional on what the log says. If
  // a message is reworded and the docs are not, an operator looks for a line
  // that never appears and either stops for nothing or, worse, reads its
  // absence the wrong way. Pin each quoted line to the code that prints it.
  const page = readFileSync(pagePath, "utf-8");
  const quoted = (line: string) => expect(page).toContain(`\`${line}\``);

  it("the key-switch notice", () => {
    const line = "AUDIT_HMAC_SECRET is set and differs from the audit signing key";
    quoted(line);
    expect(evaluateAuditSecretRotation({ hasSupersededSecret: true }).message).toContain(line);
  });

  it("the ignored-variable warning", () => {
    const line = "AUDIT_HMAC_SECRET is set but is not a valid key";
    quoted(line);
    expect(
      describeIgnoredSecretEnv({ envVar: "AUDIT_HMAC_SECRET", ignored: true }).message
    ).toContain(line);
  });

  it("the ignored-ENCRYPTION_KEY warning, on the environment variables page", () => {
    const line = "ENCRYPTION_KEY is set but is not a valid key";
    expect(readFileSync(envVarsPagePath, "utf-8")).toContain(`\`${line}\``);
    expect(describeIgnoredSecretEnv({ envVar: "ENCRYPTION_KEY", ignored: true }).message).toContain(
      line
    );
  });

  it("the key-file write", () => {
    const line = "Wrote the AUDIT_HMAC_SECRET value to .audit_hmac_secret";
    quoted(line);
    expect(
      describeAuditKeyFilePersist({ status: "written", dir: "/app/secrets" }).message
    ).toContain(line);
  });
});

describe("the key-check steps quote lines check-keys prints", () => {
  // The restore and leak steps tell the operator which line to expect from
  // `pnpm -s check-keys` before Pinchy starts. A reworded line would leave
  // them looking for one that never appears, so pin each quoted line to the
  // code that prints it, and the command to the script that runs it.
  const page = readFileSync(pagePath, "utf-8");
  const quoted = (line: string) => expect(page).toContain(`\`${line}\``);
  const auditLines = (inspection: SecretInspection) =>
    describeKeyCheck("audit_hmac_secret", inspection).lines.join("\n");

  it("the command", () => {
    expect(page).toContain("--entrypoint pnpm pinchy check-keys");
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "packages/web/package.json"), "utf-8"));
    expect(pkg.scripts["check-keys"]).toBe("node --import tsx scripts/check-keys.ts");
  });

  it("never with pnpm -s, which turns an image without the command into silence", () => {
    // `-s` hides pnpm's own `Command "check-keys" not found`, so an image
    // older than the command prints nothing and exits 254. The steps only call
    // for action on a printed line, so the operator would start Pinchy
    // unchecked.
    expect(page).not.toMatch(/pnpm[^\n]*\s-s\s+check-keys/);
  });

  it("the first line, and what its absence means", () => {
    const first = "Pinchy key check";
    quoted(first);
    expect(runKeyCheck().text.split("\n")[0]).toBe(first);
    // What pnpm prints on an image that predates the command (measured on one).
    quoted('Command "check-keys" not found');
  });

  it.each([
    [".audit_hmac_secret: holds a different key than AUDIT_HMAC_SECRET", "different"],
    [".audit_hmac_secret: holds the same key as AUDIT_HMAC_SECRET", "same"],
    [".audit_hmac_secret: no such file", "missing"],
  ] as const)("%s", (line, status) => {
    quoted(line);
    expect(auditLines({ variable: { status: "valid" }, file: { status } })).toContain(line);
  });

  it("the unreadable file", () => {
    const line = "can't be read (EACCES)";
    quoted(line);
    expect(
      auditLines({ variable: { status: "valid" }, file: { status: "unreadable", code: "EACCES" } })
    ).toContain(line);
  });

  it("the ignored variable", () => {
    const line = "set, but Pinchy ignores it";
    quoted(line);
    expect(
      auditLines({ variable: { status: "ignored", reason: "length" }, file: { status: "key" } })
    ).toContain(line);
  });

  it("the line that needs fixing", () => {
    const line = "Fix this before you start Pinchy";
    quoted(line);
    expect(
      auditLines({ variable: { status: "ignored", reason: "length" }, file: { status: "key" } })
    ).toContain(line);
  });
});

describe("every multi-word quote on the page is pinned to whatever prints it", () => {
  // The per-line tests above only cover the quotes someone remembered to pin.
  // This one finds every backticked span with a space in the page's prose and
  // requires it to be either something Pinchy prints, found in what the code
  // actually prints, or one of the other kinds listed here. A new quote that is
  // none of them fails until someone says what it is. Single words (`EACCES`,
  // `.audit_hmac_secret`) are names, not lines, and are left out.
  const page = readFileSync(pagePath, "utf-8");
  const fenced = [...page.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map((m) => m[1]);
  const prose = page.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, "");
  const spans = [...new Set([...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))].filter((s) =>
    /\s/.test(s)
  );
  // "Could not write …" quotes the start of a line.
  const stem = (span: string) => span.replace(/\s*…$/, "");

  // Commands the reader runs, and the code and schema the page names.
  const isCommand = (span: string) =>
    /^(docker|openssl|sudo|GET|compose_with_backup_key|backup_pinchy_keys) /.test(span);
  const CODE = new Set([
    'outcome: "failure"',
    'outcome: "success"',
    "BEFORE UPDATE",
    "BEFORE DELETE",
    "BEFORE TRUNCATE",
  ]);
  // Printed by the shell functions this page defines; checked against them.
  const PAGE_SCRIPT_OUTPUT = new Set([
    "Backed up to …",
    "No AUDIT_HMAC_SECRET in …",
    "Compose couldn't read …",
  ]);
  // Printed by Compose, coreutils or pnpm, which this repo doesn't word.
  const OTHER_TOOLS = new Set([
    "unknown flag: --environment",
    "couldn't find env file",
    "File exists",
    'Command "check-keys" not found',
  ]);
  const isPinchyOutput = (span: string) =>
    !isCommand(span) && !CODE.has(span) && !PAGE_SCRIPT_OUTPUT.has(span) && !OTHER_TOOLS.has(span);

  // Everything the key check and the startup and verify-job logs can say.
  async function pinchyOutput(): Promise<string> {
    const message = (log: { action: string; message?: string }) => log.message ?? "";
    const variables: SecretInspection["variable"][] = [
      { status: "unset" },
      { status: "valid" },
      { status: "ignored", reason: "0x-prefix" },
      { status: "ignored", reason: "not-hex" },
      { status: "ignored", reason: "length" },
    ];
    const files: SecretInspection["file"][] = [
      { status: "missing" },
      { status: "unreadable", code: "EACCES" },
      { status: "invalid" },
      { status: "key" },
      { status: "same" },
      { status: "different" },
    ];
    const keyCheck = (["audit_hmac_secret", "encryption_key"] as const).flatMap((secret) =>
      variables.flatMap((variable) =>
        files.map((file) => describeKeyCheck(secret, { variable, file }).lines.join("\n"))
      )
    );
    const startup = [
      runKeyCheck().text,
      message(evaluateAuditSecretRotation({ hasSupersededSecret: true })),
      ...(["AUDIT_HMAC_SECRET", "ENCRYPTION_KEY"] as const).map((envVar) =>
        message(describeIgnoredSecretEnv({ envVar, ignored: true }))
      ),
      ...(
        [
          { status: "written", dir: "/app/secrets" },
          { status: "failed", reason: "EACCES" },
          { status: "file-invalid" },
          { status: "file-unreadable", code: "EACCES" },
        ] as const
      ).map((outcome) => message(describeAuditKeyFilePersist(outcome))),
    ];

    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      startAuditVerifyJob();
      await vi.advanceTimersByTimeAsync(60_000);
      const job = errors.mock.calls.map((args) => args.map(String).join(" "));
      return [...keyCheck, ...startup, ...job].join("\n");
    } finally {
      stopAuditVerifyJob();
      errors.mockRestore();
      vi.useRealTimers();
    }
  }

  it("finds the quotes it is meant to classify", () => {
    // A broken extractor that finds nothing would pass every check below.
    expect(spans.filter(isPinchyOutput).length).toBeGreaterThan(15);
    expect(spans).toContain("[audit-verify-job] sweep failed");
  });

  it("every line quoted as Pinchy's output is in what Pinchy prints", async () => {
    const output = await pinchyOutput();
    const unpinned = spans.filter(isPinchyOutput).filter((span) => !output.includes(stem(span)));
    expect(unpinned).toEqual([]);
  });

  it("every line quoted from the page's own commands is in those commands", () => {
    for (const span of PAGE_SCRIPT_OUTPUT) {
      expect(spans).toContain(span);
      expect(fenced.some((code) => code.includes(stem(span)))).toBe(true);
    }
  });

  it("the other lists name only quotes the page still has", () => {
    // An entry for a quote that is gone would excuse the next one with that text.
    for (const span of [...CODE, ...OTHER_TOOLS]) expect(spans).toContain(span);
  });

  it("the other guides quote the same lines", () => {
    const guide = (path: string) => readFileSync(resolve(docsRoot, path), "utf-8");
    expect(guide("guides/upgrading.mdx")).toContain(
      "`AUDIT_HMAC_SECRET is set but is not a valid key`"
    );
    expect(guide("guides/hardening.mdx")).toContain('`Command "check-keys" not found`');
  });
});
