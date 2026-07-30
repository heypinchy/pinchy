import { describe, it, expect } from "vitest";
import {
  isValidDomain,
  validatePinchyWebConfig,
  pluginConfigSchema,
} from "@/lib/domain-validation";

describe("isValidDomain", () => {
  it.each(["example.com", "docs.example.com", "a.b.c.d.example.com", "xn--bcher-kva.example"])(
    "accepts %s",
    (d) => {
      expect(isValidDomain(d)).toBe(true);
    }
  );

  it.each([
    "",
    "localhost",
    "not a domain",
    "example..com",
    "-example.com",
    "example-.com",
    "example.com ",
    " example.com",
  ])("rejects %s", (d) => {
    expect(isValidDomain(d)).toBe(false);
  });
});

describe("validatePinchyWebConfig", () => {
  it("returns null when pluginConfig is absent", () => {
    expect(validatePinchyWebConfig(undefined)).toBeNull();
    expect(validatePinchyWebConfig(null)).toBeNull();
  });

  it("returns null when pinchy-web entry is absent", () => {
    expect(validatePinchyWebConfig({ "pinchy-files": { allowed_paths: [] } })).toBeNull();
  });

  it("returns null for valid allowedDomains / excludedDomains", () => {
    expect(
      validatePinchyWebConfig({
        "pinchy-web": {
          allowedDomains: ["example.com", "docs.example.com"],
          excludedDomains: ["bad.com"],
        },
      })
    ).toBeNull();
  });

  it("rejects non-object pluginConfig", () => {
    expect(validatePinchyWebConfig("string")).toMatch(/object/i);
    expect(validatePinchyWebConfig([])).toMatch(/object/i);
  });

  it("rejects invalid allowedDomains entry", () => {
    expect(
      validatePinchyWebConfig({ "pinchy-web": { allowedDomains: ["not a domain!"] } })
    ).toMatch(/allowedDomains/i);
  });

  it("rejects invalid excludedDomains entry", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": { excludedDomains: ["@@@"] } })).toMatch(
      /excludedDomains/i
    );
  });

  it("rejects non-array allowedDomains", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": { allowedDomains: "example.com" } })).toMatch(
      /allowedDomains/i
    );
  });

  it("rejects non-string domain entries", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": { allowedDomains: [123] } })).toMatch(
      /allowedDomains/i
    );
  });

  it("rejects non-object pinchy-web entry", () => {
    expect(validatePinchyWebConfig({ "pinchy-web": "yes" })).toMatch(/pinchy-web/i);
  });
});

describe("pluginConfigSchema — pinchy-files", () => {
  it("accepts write_paths and allowed_extensions as optional fields", () => {
    const result = pluginConfigSchema.safeParse({
      "pinchy-files": {
        allowed_paths: ["/data/kb"],
        write_paths: ["/root/.openclaw/workspaces/agent-1/uploads"],
        allowed_extensions: [".csv", ".txt"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields in pinchy-files config", () => {
    const result = pluginConfigSchema.safeParse({
      "pinchy-files": {
        allowed_paths: ["/data/kb"],
        evil_field: "x",
      },
    });
    expect(result.success).toBe(false);
  });
});

/**
 * `allowed_paths` is not a preference — it is the allowlist that scopes the
 * agent's file tools, its knowledge-base retrieval AND the browser-facing
 * `/api/agents/[id]/workspace-file` route. It has to be clamped in the SCHEMA
 * rather than in a route, because the two routes disagreed about it: POST
 * only called `validateAllowedPaths` when `template.pluginId ===
 * "pinchy-files"`, and PATCH never called it at all — so any member could
 * widen their own personal agent's scope to `/` and read the container's
 * secrets. One boundary, shared by every writer, is the only version of this
 * that stays true as routes are added.
 */
describe("pluginConfigSchema — allowed_paths is clamped to /data/", () => {
  const accepts = (paths: string[]) =>
    pluginConfigSchema.safeParse({ "pinchy-files": { allowed_paths: paths } }).success;

  it("accepts paths under /data/", () => {
    expect(accepts(["/data/kb", "/data/finance/invoices"])).toBe(true);
  });

  it("accepts /data itself", () => {
    expect(accepts(["/data"])).toBe(true);
  });

  it("rejects the filesystem root", () => {
    expect(accepts(["/"])).toBe(false);
  });

  it("rejects the directory holding the container's decrypted provider keys", () => {
    expect(accepts(["/openclaw-secrets"])).toBe(false);
  });

  it("rejects the directory holding the AES master key", () => {
    expect(accepts(["/app/secrets"])).toBe(false);
  });

  it("rejects a traversal that lexically escapes /data", () => {
    expect(accepts(["/data/../etc"])).toBe(false);
  });

  it("rejects a sibling that merely shares the /data prefix", () => {
    expect(accepts(["/database"])).toBe(false);
  });

  it("rejects a relative path, which would resolve against the server's cwd", () => {
    expect(accepts(["kb"])).toBe(false);
  });

  it("rejects a null byte, which can truncate the path in a native call", () => {
    expect(accepts(["/data/kb\0/../../etc"])).toBe(false);
  });

  it("rejects the whole list when only one entry escapes", () => {
    expect(accepts(["/data/kb", "/etc"])).toBe(false);
  });
});
