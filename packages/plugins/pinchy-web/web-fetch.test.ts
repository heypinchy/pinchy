import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

// Import after mock setup
const { webFetch } = await import("./web-fetch.js");

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
