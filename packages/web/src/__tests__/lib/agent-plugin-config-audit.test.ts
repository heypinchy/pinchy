import { describe, expect, it } from "vitest";
import { pluginConfigAuditChange } from "@/lib/agent-plugin-config-audit";
import type { AgentPluginConfig } from "@/db/schema";

const PERSON = "/data/hr/personnel/Maria Musterfrau";

describe("pluginConfigAuditChange", () => {
  it("never carries a granted folder path", () => {
    const from: AgentPluginConfig = {
      "pinchy-files": { allowed_paths: ["/data/hr"], write_paths: ["/data/hr/out"] },
    };
    const to: AgentPluginConfig = {
      "pinchy-files": {
        allowed_paths: ["/data/hr", PERSON],
        write_paths: [`${PERSON}/notes`],
      },
    };

    const result = pluginConfigAuditChange(from, to);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/data");
    expect(serialized).not.toContain("Musterfrau");
  });

  it("reports added and removed folder grants as counts", () => {
    const result = pluginConfigAuditChange(
      { "pinchy-files": { allowed_paths: ["/data/a", "/data/b"] } },
      { "pinchy-files": { allowed_paths: ["/data/b", "/data/c", "/data/d"] } }
    );

    expect(result.folderAccess).toEqual({ added: 2, removed: 1, count: 3 });
  });

  // A stored write_paths grants nothing: build.ts derives write access from
  // the pinchy_write / pinchy_memory tool grants, and the Permissions tab
  // drops the field on save. Reporting it would record a write grant or
  // revocation that never happened.
  it("ignores a stored write_paths entirely", () => {
    const result = pluginConfigAuditChange(
      { "pinchy-files": { allowed_paths: ["/data/a"], write_paths: ["/data/a"] } },
      { "pinchy-files": { allowed_paths: ["/data/a"] } }
    );

    expect(result).toEqual({});
  });

  it("records a swap of one folder for another, which a count alone would hide", () => {
    const result = pluginConfigAuditChange(
      { "pinchy-files": { allowed_paths: ["/data/hr/alice"] } },
      { "pinchy-files": { allowed_paths: ["/data/hr/bob"] } }
    );

    expect(result.folderAccess).toEqual({ added: 1, removed: 1, count: 1 });
    // The redacted views are identical (one path either side), so there is no
    // from/to entry — the swap lives in folderAccess alone.
    expect(result.change).toBeUndefined();
  });

  it("replaces the path list with a count in the from/to view and keeps the rest", () => {
    const result = pluginConfigAuditChange(
      {
        "pinchy-files": { allowed_paths: ["/data/a"], allowed_extensions: [".pdf"] },
        "pinchy-web": { allowedDomains: ["old.com"] },
      },
      {
        "pinchy-files": { allowed_paths: ["/data/a", "/data/b"], allowed_extensions: [".pdf"] },
        "pinchy-web": { allowedDomains: ["new.com"] },
        "pinchy-approvals": { confirm: { odoo_delete: "confirm" } },
      }
    );

    expect(result.change).toEqual({
      from: {
        "pinchy-files": { allowedPathCount: 1, allowed_extensions: [".pdf"] },
        "pinchy-web": { allowedDomains: ["old.com"] },
      },
      to: {
        "pinchy-files": { allowedPathCount: 2, allowed_extensions: [".pdf"] },
        "pinchy-web": { allowedDomains: ["new.com"] },
        "pinchy-approvals": { confirm: { odoo_delete: "confirm" } },
      },
    });
  });

  it("omits folderAccess when the folder grants did not change", () => {
    const files = { "pinchy-files": { allowed_paths: ["/data/a"] } };
    const result = pluginConfigAuditChange(files, {
      ...files,
      "pinchy-web": { allowedDomains: ["new.com"] },
    });

    expect(result.folderAccess).toBeUndefined();
    expect(result.change).toBeDefined();
  });

  it("reports nothing for a reorder of the same folders", () => {
    const result = pluginConfigAuditChange(
      { "pinchy-files": { allowed_paths: ["/data/a", "/data/b"] } },
      { "pinchy-files": { allowed_paths: ["/data/b", "/data/a"] } }
    );

    expect(result).toEqual({});
  });

  // Postgres jsonb hands keys back shortest-first; the request body comes out
  // of zod in schema order. The same config must not read as a change.
  it("reports nothing when only the key order differs", () => {
    const stored = {
      "pinchy-web": { country: "AT", language: "de", allowedDomains: ["a.com"] },
      "pinchy-files": { allowed_paths: ["/data/a"] },
    } as AgentPluginConfig;
    const sent = {
      "pinchy-files": { allowed_paths: ["/data/a"] },
      "pinchy-web": { allowedDomains: ["a.com"], language: "de", country: "AT" },
    } as AgentPluginConfig;

    expect(pluginConfigAuditChange(stored, sent)).toEqual({});
  });

  it("handles a null config on either side", () => {
    const result = pluginConfigAuditChange(null, {
      "pinchy-files": { allowed_paths: ["/data/a"] },
    });

    expect(result.change).toEqual({
      from: null,
      to: { "pinchy-files": { allowedPathCount: 1 } },
    });
    expect(result.folderAccess).toEqual({ added: 1, removed: 0, count: 1 });
  });

  it("stays under the audit detail cap for many deep grants", () => {
    const paths = Array.from(
      { length: 40 },
      (_, i) => `/data/customers/some-long-customer-folder-name-${i}/contracts/2026`
    );
    const result = pluginConfigAuditChange(
      { "pinchy-files": { allowed_paths: paths.slice(0, 20) } },
      { "pinchy-files": { allowed_paths: paths.slice(20) } }
    );

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(512);
  });
});
