import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

// Import after mock setup
const { webFetch, pinnedLookup } = await import("./web-fetch.js");

describe("webFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const resolve4Mock = dns.resolve4 as ReturnType<typeof vi.fn>;
  const resolve6Mock = dns.resolve6 as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Default: resolve to public IPs
    resolve4Mock.mockResolvedValue(["93.184.216.34"]);
    resolve6Mock.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockHtmlResponse(html: string, status = 200) {
    fetchMock.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: new Map([["content-type", "text/html; charset=utf-8"]]),
      text: async () => html,
    });
  }

  function mockTextResponse(text: string, contentType = "text/plain") {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", contentType]]),
      text: async () => text,
    });
  }

  it("fetches URL and returns extracted text content", async () => {
    mockHtmlResponse(`
      <html><head><title>Test Page</title></head>
      <body>
        <article>
          <h1>Hello World</h1>
          <p>This is the main content of the page.</p>
        </article>
        <nav>Navigation links here</nav>
      </body></html>
    `);

    const result = await webFetch("https://example.com/page");

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Hello World");
    expect(result.content).toContain("main content");
  });

  it("respects maxChars limit and truncates with marker", async () => {
    mockHtmlResponse(`
      <html><head><title>Long Page</title></head>
      <body><article><p>${"A".repeat(500)}</p></article></body></html>
    `);

    const result = await webFetch("https://example.com/long", { maxChars: 100 });

    expect(result.content.length).toBeLessThanOrEqual(100 + "\n\n[truncated]".length);
    expect(result.content).toContain("[truncated]");
  });

  describe("domain filtering", () => {
    it("allows URL matching allowedDomains", async () => {
      mockHtmlResponse("<html><body><p>Content</p></body></html>");

      const result = await webFetch("https://github.com/foo", {
        allowedDomains: ["github.com"],
      });

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
    });

    it("rejects URL not matching allowedDomains", async () => {
      const result = await webFetch("https://evil.com/foo", {
        allowedDomains: ["github.com"],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not allowed");
      expect(result.content).toContain("github.com");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows subdomains of allowedDomains", async () => {
      mockHtmlResponse("<html><body><p>Docs</p></body></html>");

      const result = await webFetch("https://docs.github.com/foo", {
        allowedDomains: ["github.com"],
      });

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
    });

    it("rejects URL matching excludedDomains", async () => {
      const result = await webFetch("https://evil.com/foo", {
        excludedDomains: ["evil.com"],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("blocked");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("matches allowedDomains case-insensitively", async () => {
      mockHtmlResponse("<html><body><p>hi</p></body></html>");
      const result = await webFetch("https://GitHub.com/user/repo", {
        allowedDomains: ["github.com"],
      });
      expect(result.isError).toBeUndefined();
    });

    it("treats a trailing-dot hostname as matching allowedDomains", async () => {
      mockHtmlResponse("<html><body><p>hi</p></body></html>");
      const result = await webFetch("https://github.com./user/repo", {
        allowedDomains: ["github.com"],
      });
      expect(result.isError).toBeUndefined();
    });

    it("allows any public URL when no domain config is set", async () => {
      mockHtmlResponse("<html><body><p>Any content</p></body></html>");

      const result = await webFetch("https://any-site.example.org/page");

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe("SSRF guard", () => {
    it("blocks http://localhost", async () => {
      const result = await webFetch("http://localhost/admin");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks http://127.0.0.1", async () => {
      const result = await webFetch("http://127.0.0.1/admin");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks http://10.0.0.1", async () => {
      const result = await webFetch("http://10.0.0.1/internal");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks http://192.168.1.1", async () => {
      const result = await webFetch("http://192.168.1.1/router");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks http://169.254.169.254 (AWS metadata)", async () => {
      const result = await webFetch("http://169.254.169.254/latest/meta-data/");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks hostnames that resolve to private IPs", async () => {
      resolve4Mock.mockResolvedValue(["192.168.1.100"]);
      resolve6Mock.mockResolvedValue([]);

      const result = await webFetch("https://internal.company.com/secret");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks hostnames that resolve to IPv6 private IPs", async () => {
      resolve4Mock.mockResolvedValue([]);
      resolve6Mock.mockResolvedValue(["fc00::1"]);

      const result = await webFetch("https://sneaky.example.com/page");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks IPv4-mapped IPv6 wrapping a private IPv4 (::ffff:10.0.0.1)", async () => {
      // Attacker DNS returns an IPv4-mapped IPv6 address that embeds a
      // private IPv4. Without unwrapping, the regex check sees an opaque
      // IPv6 string that none of the IPv4 patterns match.
      resolve4Mock.mockResolvedValue([]);
      resolve6Mock.mockResolvedValue(["::ffff:10.0.0.1"]);

      const result = await webFetch("https://sneaky.example.com/page");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)", async () => {
      const result = await webFetch("http://[::ffff:127.0.0.1]/admin");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows IPv4-mapped IPv6 wrapping a public IPv4 (::ffff:8.8.8.8)", async () => {
      resolve4Mock.mockResolvedValue([]);
      resolve6Mock.mockResolvedValue(["::ffff:8.8.8.8"]);
      mockHtmlResponse("<html><body><p>OK</p></body></html>");

      const result = await webFetch("https://example.com/page");

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
    });

    it("blocks redirects to private IPs (SSRF via redirect)", async () => {
      // First request returns a redirect to a private IP
      fetchMock.mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: new Map([["location", "http://169.254.169.254/latest/meta-data/"]]),
      });

      const result = await webFetch("https://evil.com/redirect");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
    });

    it("blocks redirects to hostnames resolving to private IPs", async () => {
      // First fetch for the initial URL (public IP)
      fetchMock.mockResolvedValueOnce({
        status: 301,
        ok: false,
        headers: new Map([["location", "https://internal.corp.com/secret"]]),
      });
      // DNS for redirect target resolves to private IP
      resolve4Mock
        .mockResolvedValueOnce(["93.184.216.34"])  // initial URL
        .mockResolvedValueOnce(["10.0.0.5"]);      // redirect target
      resolve6Mock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await webFetch("https://evil.com/redirect");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("private network");
    });

    it("follows safe redirects", async () => {
      fetchMock
        .mockResolvedValueOnce({
          status: 301,
          ok: false,
          headers: new Map([["location", "https://www.example.com/page"]]),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Final content",
        });
      // DNS for both hops resolves to public IPs
      resolve4Mock
        .mockResolvedValueOnce(["93.184.216.34"])
        .mockResolvedValueOnce(["93.184.216.34"]);
      resolve6Mock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await webFetch("https://example.com/old");

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("Final content");
    });

    it("pins the resolved IP for the actual fetch (DNS rebinding mitigation)", async () => {
      // Attacker DNS: returns a public IP to the pre-check, would return a
      // private IP to a follow-up resolution. Without pinning, fetch could be
      // tricked into hitting the private IP (classic TOCTOU).
      resolve4Mock
        .mockResolvedValueOnce(["93.184.216.34"]) // guard sees public
        .mockResolvedValueOnce(["10.0.0.5"]); // a second resolution would see private
      resolve6Mock.mockResolvedValue([]);
      mockHtmlResponse("<html><body><p>Safe</p></body></html>");

      const result = await webFetch("https://example.com/page");

      // Guard passes on the public address.
      expect(result.isError).toBeUndefined();

      // fetch must be dispatched through a pinned-IP undici Agent so the OS
      // resolver cannot return a different (private) IP at connect time.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
      expect(callArgs[1]).toBeDefined();
      expect(callArgs[1].dispatcher).toBeDefined();
    });

    it("does not attach a dispatcher when the URL is already an IP literal", async () => {
      // No DNS to rebind — the URL itself names the destination address.
      mockHtmlResponse("<html><body><p>Direct</p></body></html>");

      const result = await webFetch("https://93.184.216.34/page");

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // No DNS resolution attempted for IP literals.
      expect(resolve4Mock).not.toHaveBeenCalled();
      expect(resolve6Mock).not.toHaveBeenCalled();
    });

    it("rejects too many redirects", async () => {
      // 6 consecutive redirects (limit is 5)
      for (let i = 0; i < 6; i++) {
        fetchMock.mockResolvedValueOnce({
          status: 302,
          ok: false,
          headers: new Map([["location", `https://example.com/hop${i + 1}`]]),
        });
        resolve4Mock.mockResolvedValueOnce(["93.184.216.34"]);
        resolve6Mock.mockResolvedValueOnce([]);
      }

      const result = await webFetch("https://example.com/start");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Too many redirects");
    });
  });

  describe("pinnedLookup", () => {
    it("invokes the callback with the pinned address regardless of hostname", async () => {
      const lookup = pinnedLookup("93.184.216.34", 4);

      const result = await new Promise<{ address: string; family: number }>(
        (resolve, reject) => {
          lookup("evil.com", {}, (err, address, family) => {
            if (err) reject(err);
            else resolve({ address: address as string, family: family as number });
          });
        },
      );

      expect(result.address).toBe("93.184.216.34");
      expect(result.family).toBe(4);
    });

    it("supports IPv6 addresses", async () => {
      const lookup = pinnedLookup("2606:2800:220:1:248:1893:25c8:1946", 6);

      const result = await new Promise<{ address: string; family: number }>(
        (resolve, reject) => {
          lookup("example.com", {}, (err, address, family) => {
            if (err) reject(err);
            else resolve({ address: address as string, family: family as number });
          });
        },
      );

      expect(result.address).toBe("2606:2800:220:1:248:1893:25c8:1946");
      expect(result.family).toBe(6);
    });
  });

  describe("error handling", () => {
    it("returns isError for invalid URLs", async () => {
      const result = await webFetch("not-a-url");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid URL");
    });

    it("rejects non-HTTP(S) protocols", async () => {
      const ftpResult = await webFetch("ftp://files.example.com/data");
      expect(ftpResult.isError).toBe(true);
      expect(ftpResult.content).toContain("HTTP");

      const fileResult = await webFetch("file:///etc/passwd");
      expect(fileResult.isError).toBe(true);
      expect(fileResult.content).toContain("HTTP");
    });

    it("handles HTTP error responses", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Map([["content-type", "text/html"]]),
        text: async () => "Page not found",
      });

      const result = await webFetch("https://example.com/missing");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("404");
    });

    it("handles fetch errors (timeout, DNS failure)", async () => {
      fetchMock.mockRejectedValue(new Error("fetch failed"));

      const result = await webFetch("https://example.com/timeout");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("fetch failed");
    });

    it("handles non-HTML content gracefully (returns raw text)", async () => {
      mockTextResponse("This is plain text content");

      const result = await webFetch("https://example.com/data.txt");

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("This is plain text content");
    });
  });
});
