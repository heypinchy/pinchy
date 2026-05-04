import { describe, it, expect } from "vitest";
import { validateBuiltConfig } from "@/lib/openclaw-config/validate-built-config";

describe("validateBuiltConfig", () => {
  it("returns ok=true when every emitted plugin entry matches its manifest", () => {
    const config = {
      plugins: {
        allow: ["pinchy-audit"],
        entries: {
          "pinchy-audit": {
            enabled: true,
            config: {
              apiBaseUrl: "http://pinchy:7777",
              gatewayToken: "t",
            },
          },
        },
      },
    };
    const result = validateBuiltConfig(config);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with plugin-id-tagged errors when an entry doesn't match its manifest", () => {
    const config = {
      plugins: {
        allow: ["pinchy-odoo"],
        entries: {
          "pinchy-odoo": {
            enabled: true,
            config: {},
          },
        },
      },
    };
    const result = validateBuiltConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/pinchy-odoo/);
    }
  });

  it("ignores non-Pinchy plugins (e.g. anthropic, telegram)", () => {
    const config = {
      plugins: {
        allow: ["anthropic", "telegram"],
        entries: {
          anthropic: { enabled: true },
          telegram: { enabled: true, config: { whatever: 1 } },
        },
      },
    };
    expect(validateBuiltConfig(config).ok).toBe(true);
  });

  it("returns ok=true when there are no plugins at all (empty entries)", () => {
    expect(validateBuiltConfig({}).ok).toBe(true);
    expect(validateBuiltConfig({ plugins: { allow: [], entries: {} } }).ok).toBe(true);
  });

  it("validates every Pinchy plugin entry, not just the first failing one", () => {
    const config = {
      plugins: {
        allow: ["pinchy-odoo", "pinchy-web"],
        entries: {
          "pinchy-odoo": { enabled: true, config: {} },
          "pinchy-web": { enabled: true, config: {} },
        },
      },
    };
    const result = validateBuiltConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join("\n");
      expect(joined).toMatch(/pinchy-odoo/);
      expect(joined).toMatch(/pinchy-web/);
    }
  });
});
