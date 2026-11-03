import { describe, expect, it } from "vitest";
import { describeOdooError } from "@/lib/integrations/odoo-error";

describe("describeOdooError", () => {
  it("passes an Odoo error message through", () => {
    expect(describeOdooError(new Error("Access Denied"))).toBe("Access Denied");
  });

  it("replaces a JSON parse error, which quotes the response body, with a plain sentence", () => {
    const parseError = new SyntaxError(`Unexpected token '<', "<html>SECR"... is not valid JSON`);

    const message = describeOdooError(parseError);

    expect(message).toMatch(/not a JSON-RPC response/);
    expect(message).not.toContain("SECR");
  });

  it("treats a JSON answer of the wrong shape like a non-JSON one", () => {
    const shapeError = new TypeError("Cannot read properties of undefined (reading 'message')");

    expect(describeOdooError(shapeError)).toMatch(/not a JSON-RPC response/);
  });

  it("collapses a multi-line message to one line and caps its length", () => {
    const message = describeOdooError(new Error(`first\n\nsecond ${"x".repeat(1000)}`));

    expect(message.startsWith("first second x")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(301);
  });

  it("falls back for an empty message", () => {
    expect(describeOdooError(new Error("   "))).toBe("Connection failed");
  });
});
