import { describe, expect, it } from "vitest";
import { OdooError } from "odoo-node";
import {
  describeOdooAuthenticateFailure,
  describeOdooError,
  isOdooTimeout,
  odooRedirectRefusedMessage,
} from "@/lib/integrations/odoo-error";
import { ODOO_REQUEST_TIMEOUT_MS } from "@/lib/integrations/odoo-pin";

/** odoo-node's error for a request the pinned fetch's bound cut off. */
function timedOut(): OdooError {
  return new OdooError("The operation was aborted due to timeout", 0, undefined, {
    cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  });
}

describe("isOdooTimeout", () => {
  it("recognises the bound cutting off a request, through odoo-node's wrapping", () => {
    expect(isOdooTimeout(timedOut())).toBe(true);
  });

  it("does not take a caller's cancellation or another network failure for one", () => {
    const aborted = new OdooError("This operation was aborted", 0, undefined, {
      cause: new DOMException("This operation was aborted", "AbortError"),
    });
    expect(isOdooTimeout(aborted)).toBe(false);
    expect(isOdooTimeout(new OdooError("fetch failed", 0))).toBe(false);
    expect(isOdooTimeout(new Error("ETIMEDOUT"))).toBe(false);
  });
});

describe("describeOdooError", () => {
  it("says Odoo did not answer in time, naming the bound, instead of a bare abort", () => {
    const seconds = ODOO_REQUEST_TIMEOUT_MS / 1000;

    expect(describeOdooError(timedOut())).toBe(
      `Odoo did not answer within ${seconds} seconds. ` +
        "The server took the connection but sent no reply: check that Odoo is running and not overloaded, " +
        "and that nothing in front of it, such as a proxy or firewall, holds the request."
    );
  });

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

  it("reports a TypeError reading 'message' as Pinchy's own, not as a non-JSON-RPC answer", () => {
    // odoo-node reports a JSON-RPC error envelope without a message as
    // "Response is not JSON-RPC" itself; it no longer escapes as a TypeError.
    // One that does is a bug of ours, and must not read as the URL's fault.
    const bug = new TypeError("Cannot read properties of undefined (reading 'message')");

    const message = describeOdooError(bug);

    expect(message).not.toMatch(/JSON-RPC/);
    expect(message).toMatch(/internal error.*TypeError reading 'message'/);
  });

  it("reports any other TypeError as an internal error, not as Odoo's answer", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'map')");

    const message = describeOdooError(bug);

    expect(message).not.toMatch(/JSON-RPC/);
    expect(message).toBe(
      "Pinchy hit an internal error while talking to Odoo (TypeError reading 'map'). " +
        "This is not a problem with the connection's settings."
    );
  });

  it("never repeats an internal error's free text", () => {
    const bug = new TypeError("token.secret-value is not a function");

    const message = describeOdooError(bug);

    expect(message).not.toContain("secret-value");
    expect(message).toBe(
      "Pinchy hit an internal error while talking to Odoo (TypeError). " +
        "This is not a problem with the connection's settings."
    );
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

describe("describeOdooAuthenticateFailure", () => {
  // Our own bug is neither Odoo misbehaving nor a refused login.
  it("reports an internal error as Pinchy's, without blaming Odoo", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'map')");

    const result = describeOdooAuthenticateFailure(bug);

    expect(result.reason).toBe(describeOdooError(bug));
    expect(result.reason).not.toMatch(/Odoo didn't answer/);
    expect(result.transient).toBe(true);
  });
});
