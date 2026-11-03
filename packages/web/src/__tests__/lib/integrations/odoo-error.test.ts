import { describe, expect, it } from "vitest";
import { OdooError } from "odoo-node";
import { describeOdooError, odooRedirectRefusedMessage } from "@/lib/integrations/odoo-error";

describe("describeOdooError", () => {
  it("passes an Odoo error message through", () => {
    expect(describeOdooError(new Error("Access Denied"))).toBe("Access Denied");
  });

  it("says a non-JSON-RPC answer means the URL is not Odoo's, keeping status and content type", () => {
    const notJsonRpc = new OdooError("Response is not JSON-RPC (HTTP 200, text/html)", 200);

    expect(describeOdooError(notJsonRpc)).toBe(
      "Odoo answered with something that is not a JSON-RPC response (HTTP 200, text/html). " +
        "Check that the URL points at the Odoo server itself."
    );
  });

  it("says Pinchy refused a redirect, naming the status, as listing databases does", () => {
    const redirect = new OdooError(
      "Odoo answered with a redirect (HTTP 308); odoo-node does not follow redirects. " +
        "Use the address Odoo is actually served from.",
      308
    );

    expect(describeOdooError(redirect)).toBe(odooRedirectRefusedMessage(308));
    expect(odooRedirectRefusedMessage(308)).toBe(
      "Odoo answered with a redirect (HTTP 308), and Pinchy does not follow redirects. " +
        "Enter the address Odoo is actually served from — if this URL starts with http://, that is usually its https:// address."
    );
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
