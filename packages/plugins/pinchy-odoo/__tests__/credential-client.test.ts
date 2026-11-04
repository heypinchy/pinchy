// @vitest-environment node
/**
 * Unit tests for the shared credential/HTTP client (#1077).
 *
 * The module is duplicated byte-for-byte into pinchy-email and pinchy-web
 * (see the file's own docblock for why a real import cannot work), and
 * `plugin-credential-client-drift.test.ts` in packages/web fails if the three
 * copies stop being identical. So this one suite is the coverage for all
 * three copies — that is the same argument the docx-table drift guard makes,
 * and it only holds as long as the drift guard does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CredentialsFetchError,
  credentialCacheKey,
  authErrorStatus,
  isAuthError,
  requestCredentials,
  postAuthFailure,
  trackMutations,
} from "../credential-client";

describe("credentialCacheKey", () => {
  it("separates two connections for the same agent", () => {
    expect(credentialCacheKey("agent-1", "conn-a")).not.toBe(
      credentialCacheKey("agent-1", "conn-b")
    );
  });

  it("separates two agents on the same connection", () => {
    expect(credentialCacheKey("agent-1", "conn-a")).not.toBe(
      credentialCacheKey("agent-2", "conn-a")
    );
  });
});

describe("authErrorStatus", () => {
  it("reads status, statusCode and response.status", () => {
    expect(authErrorStatus(Object.assign(new Error("x"), { status: 401 }))).toBe(401);
    expect(authErrorStatus(Object.assign(new Error("x"), { statusCode: 403 }))).toBe(403);
    expect(authErrorStatus(Object.assign(new Error("x"), { response: { status: 401 } }))).toBe(401);
  });

  it("reads a numeric code (odoo-node's OdooError carries the HTTP status there)", () => {
    expect(authErrorStatus(Object.assign(new Error("HTTP 401"), { code: 401 }))).toBe(401);
  });

  it("ignores a string code — a Node system error is not an HTTP status", () => {
    expect(authErrorStatus(Object.assign(new Error("boom"), { code: "ECONNRESET" }))).toBeNull();
  });

  it("returns null for a plain error and for non-objects", () => {
    expect(authErrorStatus(new Error("boom"))).toBeNull();
    expect(authErrorStatus("boom")).toBeNull();
    expect(authErrorStatus(null)).toBeNull();
  });
});

describe("isAuthError", () => {
  it("classifies a structured 401 regardless of the message", () => {
    // Brave answers `Brave Search API error (401): {"code":"SUBSCRIPTION_TOKEN_INVALID"}`
    // — no auth *word* anywhere in it. The status is the only honest signal.
    const err = Object.assign(
      new Error('Brave Search API error (401): {"code":"SUBSCRIPTION_TOKEN_INVALID"}'),
      { status: 401 }
    );
    expect(isAuthError(err)).toBe(true);
  });

  it("needs the status for Graph's own 401 body, whose words match nothing", () => {
    // Graph names its reason in an error CODE, not in prose:
    // `{"error":{"code":"InvalidAuthenticationToken", …}}`. "invalidauthenticationtoken"
    // has no word boundary where the patterns need one, so the message alone
    // is not classified — asserted here so that stays a deliberate fact and
    // not an accident someone "fixes" by loosening a pattern.
    const body = 'Graph 401: {"error":{"code":"InvalidAuthenticationToken","message":"x"}}';
    expect(isAuthError(new Error(body))).toBe(false);
    expect(isAuthError(Object.assign(new Error(body), { status: 401 }))).toBe(true);
  });

  it("does not classify other structured statuses", () => {
    expect(isAuthError(Object.assign(new Error("nope"), { status: 500 }))).toBe(false);
    // 403 is an authorization/scope problem: a fresh token is the same token
    // with the same scopes, so retrying cannot help and flagging the
    // connection auth_failed would be a lie.
    expect(isAuthError(Object.assign(new Error("nope"), { status: 403 }))).toBe(false);
  });

  it.each([
    ["401 Unauthorized"],
    ["Graph 401: Unauthorised"],
    ["Access Denied: invalid api key"],
    ["Authentication failed"],
    ["Failed to authenticate with the server"],
    ["HTTP 401: Invalid Credentials"],
    ["invalid_grant"],
    ["Invalid API key"],
    // pinchy-web's old matcher caught this on the bare prefix "invalid api".
    ["Invalid API token"],
    ["Access token has expired"],
    ["The session expired, please sign in again"],
    ["Expired access token"],
  ])("classifies the real auth error %j", (message) => {
    expect(isAuthError(new Error(message))).toBe(true);
  });

  it.each([
    // #1077: the substring match that started this. Odoo's MissingError names
    // the record id, and re-running the call cannot fix a deleted record —
    // but two of them in a row flipped the whole connection to auth_failed.
    ["Record does not exist or has been deleted. (Records: account.move(401,), User: 2)"],
    // An amount, not a status.
    ["You cannot create a journal entry with an unbalanced amount of 401.50"],
    // A supplier's invoice number.
    ["A vendor bill with ref INV-401-2026 already exists"],
    // The single most common way "401" reaches an email error message.
    ['Graph 400: {"error":{"message":"Recipient not found: 401k-plan@example.com"}}'],
    // Microsoft puts a GUID request-id in every error body; ~1 in 70 contains
    // "401" by chance alone.
    ['Graph 500: {"innerError":{"request-id":"a1b2401c-9f31-4a11-b0de-77c1f0a2e5d9"}}'],
    // Transient failures must stay transient.
    ["503 Service Unavailable"],
    ["fetch failed"],
    ["socket hang up"],
  ])("does not classify %j", (message) => {
    expect(isAuthError(new Error(message))).toBe(false);
  });

  it("reads a bare string throw", () => {
    expect(isAuthError("401 Unauthorized")).toBe(true);
    expect(isAuthError("nothing to see here")).toBe(false);
  });
});

describe("requestCredentials", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const args = {
    apiBaseUrl: "http://pinchy:7777",
    gatewayToken: "gw-token",
    connectionId: "conn-1",
    agentId: "agent-1",
    label: "Odoo",
  };

  it("passes the agentId and the gateway token (#987)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ credentials: { apiKey: "k" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await requestCredentials(args);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "http://pinchy:7777/api/internal/integrations/conn-1/credentials?agentId=agent-1"
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gw-token");
  });

  it("throws a CredentialsFetchError carrying the status and the body's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ error: "Google OAuth is not configured." }),
      }))
    );

    const err = await requestCredentials(args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialsFetchError);
    expect((err as CredentialsFetchError).status).toBe(503);
    expect((err as Error).message).toContain("Google OAuth is not configured.");
    expect((err as Error).message).toContain("conn-1");
  });

  it("keeps the status when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => {
          throw new Error("not json");
        },
      }))
    );

    const err = (await requestCredentials(args).catch((e: unknown) => e)) as CredentialsFetchError;
    expect(err.status).toBe(502);
    expect(err.message).toContain("502");
  });

  it("names an unreadable success body as Pinchy's, without quoting it", async () => {
    // A parse error quotes the start of what it choked on — and the caller
    // hands the error message to the model.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("proxy-page-body", { status: 200 }))
    );

    const err = (await requestCredentials(args).catch((e: unknown) => e)) as CredentialsFetchError;
    expect(err).toBeInstanceOf(CredentialsFetchError);
    expect(err.status).toBe(200);
    expect(err.message).toBe(
      "Failed to fetch Odoo credentials for connection conn-1: " +
        "Pinchy answered HTTP 200 with a body that is not JSON"
    );
  });

  // A transport failure on the way to Pinchy is Pinchy's, and must say so: a
  // bare TypeError("fetch failed") would otherwise reach the model as if Odoo
  // (or the mail or search provider) had failed.
  it.each([
    ["a connection reset", new TypeError("terminated"), "request failed"],
    [
      "the request timing out",
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      "TimeoutError",
    ],
  ])(
    "names %s mid-body as an answer that broke off, not a body that is not JSON",
    async (_label, cause, named) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"credentials":'));
          controller.error(cause);
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 }))
      );

      const err = (await requestCredentials(args).catch(
        (e: unknown) => e
      )) as CredentialsFetchError;
      expect(err).toBeInstanceOf(CredentialsFetchError);
      // No usable answer, exactly as when the request never got there.
      expect(err.status).toBe(0);
      expect(err.message).toBe(
        `Failed to fetch Odoo credentials for connection conn-1: the answer from Pinchy broke off (${named})`
      );
    }
  );

  it("names a request that never reached Pinchy as such", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const err = (await requestCredentials(args).catch((e: unknown) => e)) as CredentialsFetchError;
    expect(err).toBeInstanceOf(CredentialsFetchError);
    expect(err.status).toBe(0);
    expect(err.message).toBe(
      "Failed to fetch Odoo credentials for connection conn-1: could not reach Pinchy (request failed)"
    );
  });

  // The message goes to the model and into the audit trail, so it carries an
  // error code, an error name or a fixed phrase, never the error's own text:
  // undici's header check quotes the header value — the gateway token — and a
  // connect error names the internal address.
  it("never repeats a transport error's own text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(
          'Headers.append: "Bearer sek\u0000rit-token" is an invalid header value.'
        );
      })
    );

    const err = (await requestCredentials(args).catch((e: unknown) => e)) as CredentialsFetchError;
    expect(err.status).toBe(0);
    expect(err.message).not.toContain("sek");
    expect(err.message).not.toContain("Bearer");
    expect(err.message).toBe(
      "Failed to fetch Odoo credentials for connection conn-1: could not reach Pinchy (request failed)"
    );
  });

  it("names undici's error code, and only the code, when the request never reached Pinchy", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.2:7777"), {
      code: "ECONNREFUSED",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause });
      })
    );

    const err = (await requestCredentials(args).catch((e: unknown) => e)) as CredentialsFetchError;
    expect(err.status).toBe(0);
    expect(err.message).toBe(
      "Failed to fetch Odoo credentials for connection conn-1: could not reach Pinchy (ECONNREFUSED)"
    );
    expect(err.message).not.toContain("10.0.0.2");
  });

  // The route answers 401 only from its gateway-token check (a missing grant
  // is a 403, #987), and Pinchy fails that check while it momentarily cannot
  // read the shared token — OpenClaw rewrites openclaw.json root-only on
  // every config apply. A single attempt turned that moment into a failed
  // tool call ("HTTP 401 Unauthorized" on the Brave credentials).
  describe("a 401 from Pinchy's own gateway-token check", () => {
    const unauthorized = () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
      });
    const ok = () =>
      new Response(JSON.stringify({ credentials: { apiKey: "k" } }), { status: 200 });

    // Every retry logs a warning; keep it out of the test output and never
    // let the silenced console leak past this block.
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
      vi.useRealTimers();
    });

    it("is retried with growing backoff until Pinchy accepts the token again", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(ok());
      vi.stubGlobal("fetch", fetchMock);

      const result = requestCredentials(args);
      // 250, 500, 1000 ms — spread across seconds, not one window.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      await expect(result).resolves.toEqual({ credentials: { apiKey: "k" } });
    });

    it("warns once per retry, naming the connection but never the token or the body", async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(ok());
      vi.stubGlobal("fetch", fetchMock);

      const result = requestCredentials(args);
      await vi.advanceTimersByTimeAsync(250 + 500);
      await result;

      expect(warn).toHaveBeenCalledTimes(2);
      for (const [message] of warn.mock.calls) {
        expect(String(message)).toContain("conn-1");
        expect(String(message)).toContain("401");
        expect(String(message)).not.toContain("gw-token");
        expect(String(message)).not.toContain("Unauthorized");
      }
    });

    it("surfaces as a 401 CredentialsFetchError once the retries run out", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => unauthorized());
      vi.stubGlobal("fetch", fetchMock);

      const result = requestCredentials(args).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000);
      const err = (await result) as CredentialsFetchError;

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(err).toBeInstanceOf(CredentialsFetchError);
      expect(err.status).toBe(401);
      expect(err.message).toContain("HTTP 401 Unauthorized: Unauthorized");
    });

    it.each([403, 404, 503])("does not hold up a final %i", async (status) => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ error: "final" }), { status })
      );
      vi.stubGlobal("fetch", fetchMock);

      const err = (await requestCredentials(args).catch(
        (e: unknown) => e
      )) as CredentialsFetchError;
      expect(err.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "ok"],
  ])("refuses a credentials answer that is %s", async (label, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    );

    const err = (await requestCredentials(args).catch((e: unknown) => e)) as CredentialsFetchError;
    expect(err).toBeInstanceOf(CredentialsFetchError);
    expect(err.status).toBe(200);
    expect(err.message).toBe(
      `Failed to fetch Odoo credentials for connection conn-1: Pinchy's credentials API answered ${label}, not an object`
    );
  });
});

describe("postAuthFailure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the plugin id and a truncated reason", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await postAuthFailure({
      apiBaseUrl: "http://pinchy:7777",
      connectionId: "conn-1",
      gatewayToken: "gw-token",
      pluginId: "pinchy-odoo",
      reason: "x".repeat(900),
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://pinchy:7777/api/internal/integrations/conn-1/report-auth-failure");
    expect((init.headers as Record<string, string>)["X-Plugin-Id"]).toBe("pinchy-odoo");
    const body = JSON.parse(init.body as string) as { reason: string };
    expect(body.reason).toHaveLength(500);
  });

  it("never throws — it must not mask the original tool error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(
      postAuthFailure({
        apiBaseUrl: "http://pinchy:7777",
        connectionId: "conn-1",
        gatewayToken: "gw-token",
        pluginId: "pinchy-odoo",
        reason: "boom",
      })
    ).resolves.toBeUndefined();
  });
});

describe("trackMutations", () => {
  it("marks only after a mutating call resolves", async () => {
    let mutated = false;
    const target = {
      read: async () => "r",
      write: async () => "w",
    };
    const tracked = trackMutations(target, ["write"], () => {
      mutated = true;
    });

    await tracked.read();
    expect(mutated).toBe(false);

    await tracked.write();
    expect(mutated).toBe(true);
  });

  it("does NOT mark when the mutating call rejects", async () => {
    let mutated = false;
    const target = {
      write: async () => {
        throw new Error("Access Denied");
      },
    };
    const tracked = trackMutations(target, ["write"], () => {
      mutated = true;
    });

    await expect(tracked.write()).rejects.toThrow("Access Denied");
    // A rejected write changed nothing server-side, so re-running it under a
    // fresh token is exactly what the auth retry is for. Marking here would
    // disable the transparent token refresh for every write tool.
    expect(mutated).toBe(false);
  });

  it("passes arguments and preserves the return value", async () => {
    const write = vi.fn(async (model: string, ids: number[]) => ({ model, ids }));
    const tracked = trackMutations({ write }, ["write"], () => {});

    await expect(tracked.write("res.partner", [7])).resolves.toEqual({
      model: "res.partner",
      ids: [7],
    });
    expect(write).toHaveBeenCalledWith("res.partner", [7]);
  });

  it("leaves non-function and untracked properties alone", () => {
    const tracked = trackMutations({ name: "client", read: () => 1 }, ["write"], () => {
      throw new Error("must not fire");
    });
    expect(tracked.name).toBe("client");
    expect(tracked.read()).toBe(1);
  });
});
