import { describe, it, expect } from "vitest";
import { mcpErrorMessage } from "../mcp-error-messages";

// PERSONALITY.md § Error Messages: be honest, be helpful, don't blame the
// user — and never leak implementation jargon ("MCP server returned 401
// Unauthorized") at users who simply clicked "GitHub" in the picker.

describe("mcpErrorMessage", () => {
  describe("named preset (GitHub)", () => {
    const opts = { providerName: "GitHub", isCustom: false };

    it("explains a rejected token in the provider's name with a recovery hint", () => {
      const { message, detail } = mcpErrorMessage({
        ...opts,
        code: "unauthorized",
        rawMessage: "MCP server returned 401 Unauthorized",
      });
      expect(message).toBe(
        "GitHub rejected this token. Check that it hasn't expired and has the permissions listed above, then paste a fresh one."
      );
      // No technical detail for brand presets — the raw protocol error means
      // nothing to someone who just wants to connect GitHub.
      expect(detail).toBeUndefined();
      expect(message).not.toMatch(/MCP|401/);
    });

    it("describes a server-side failure without protocol jargon", () => {
      const { message } = mcpErrorMessage({ ...opts, code: "server_error" });
      expect(message).toBe("GitHub couldn't process the request right now. Try again in a moment.");
    });

    it("describes an unreachable provider", () => {
      const { message } = mcpErrorMessage({ ...opts, code: "network" });
      expect(message).toBe("Couldn't reach GitHub. Check your network connection and try again.");
    });

    it("describes an incompatible response", () => {
      const { message } = mcpErrorMessage({ ...opts, code: "schema" });
      expect(message).toBe(
        "GitHub responded in an unexpected format. Try again — if this keeps happening, the integration may need an update."
      );
    });

    it("falls back to a generic-but-friendly message when the code is missing", () => {
      const { message } = mcpErrorMessage({ ...opts, code: undefined });
      expect(message).toBe("Connecting to GitHub failed. Check your input and try again.");
    });
  });

  describe("custom MCP server", () => {
    const opts = { providerName: "Generic MCP", isCustom: true };

    it("speaks of 'the server' and surfaces the raw error as detail for debugging", () => {
      const { message, detail } = mcpErrorMessage({
        ...opts,
        code: "unauthorized",
        rawMessage: "MCP server returned 401 Unauthorized",
      });
      expect(message).toBe(
        "The server rejected this token. Check that it's valid and hasn't expired."
      );
      // Custom-server admins run the server themselves — the raw response is
      // genuinely useful for them.
      expect(detail).toBe("MCP server returned 401 Unauthorized");
    });

    it("points at the URL for network failures (the URL is user-entered here)", () => {
      const { message } = mcpErrorMessage({ ...opts, code: "network" });
      expect(message).toBe("Couldn't reach the server. Check the URL and your network connection.");
    });

    it("omits the detail line when there is no raw message", () => {
      const { detail } = mcpErrorMessage({ ...opts, code: "server_error" });
      expect(detail).toBeUndefined();
    });
  });
});
