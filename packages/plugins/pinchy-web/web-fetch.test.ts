// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

// Import after mock setup
const { webFetch, pinnedLookup, readBodyCapped, extractReadableContent, visibleTextFromHtml } =
  await import("./web-fetch.js");

// Build a Response whose body streams the given byte chunks, to exercise
// readBodyCapped's streaming cap path (the text() fallback is used elsewhere).
function streamResponse(chunks: Uint8Array[]): Response {
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

describe("readBodyCapped streaming byte cap", () => {
  it("never collects more than maxBytes when a single chunk overshoots the cap", async () => {
    // One 1000-byte chunk arriving against an 800-byte cap. ASCII → 1 byte/char,
    // so the decoded length equals the byte count we kept.
    const out = await readBodyCapped(streamResponse([new Uint8Array(1000).fill(65)]), 800);
    expect(out.length).toBeLessThanOrEqual(800);
  });

  it("accumulates multiple chunks but still stops exactly at the cap", async () => {
    const chunk = () => new Uint8Array(300).fill(66);
    const out = await readBodyCapped(streamResponse([chunk(), chunk(), chunk()]), 800);
    expect(out.length).toBeLessThanOrEqual(800);
    expect(out.length).toBeGreaterThan(0);
  });
});

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

  // Routing/SSRF/redirect tests care only about isError, not the body. Use a
  // body with enough real text to clear extractReadableContent's empty-content
  // guard, so these tests stay decoupled from content-extraction behaviour.
  const ROUTING_FIXTURE =
    "<html><body><article><p>This is an ordinary web page whose body carries enough readable prose for the extractor to treat it as genuine content.</p></article></body></html>";

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
      mockHtmlResponse(ROUTING_FIXTURE);

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
      mockHtmlResponse(ROUTING_FIXTURE);

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
      mockHtmlResponse(ROUTING_FIXTURE);
      const result = await webFetch("https://GitHub.com/user/repo", {
        allowedDomains: ["github.com"],
      });
      expect(result.isError).toBeUndefined();
    });

    it("treats a trailing-dot hostname as matching allowedDomains", async () => {
      mockHtmlResponse(ROUTING_FIXTURE);
      const result = await webFetch("https://github.com./user/repo", {
        allowedDomains: ["github.com"],
      });
      expect(result.isError).toBeUndefined();
    });

    it("allows any public URL when no domain config is set", async () => {
      mockHtmlResponse(ROUTING_FIXTURE);

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
      mockHtmlResponse(ROUTING_FIXTURE);

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
      mockHtmlResponse(ROUTING_FIXTURE);

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
      // Reset the call-history on the dns mocks. vitest 4 no longer
      // clears call-history between `it` blocks automatically (vitest 3 did),
      // so without this the earlier SSRF tests' resolve* calls would still be
      // counted here.
      resolve4Mock.mockClear();
      resolve6Mock.mockClear();

      // No DNS to rebind — the URL itself names the destination address.
      mockHtmlResponse(ROUTING_FIXTURE);

      const result = await webFetch("https://93.184.216.34/page");

      expect(result.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // No DNS resolution attempted for IP literals.
      expect(resolve4Mock).not.toHaveBeenCalled();
      expect(resolve6Mock).not.toHaveBeenCalled();
    });

    it("rejects too many redirects", async () => {
      // Reset DNS mocks to a clean public-IP baseline. vitest 4 carries
      // `mockResolvedValue` state across tests within a describe block (an
      // earlier test sets `resolve6Mock.mockResolvedValue([])`, which would
      // otherwise persist as the default here and make every fall-through
      // resolution see only the public ipv4 array — fine — but a single
      // unexpected fall-through to the private-IP branch from another
      // accumulated mock state would mask the real assertion). Pin both
      // mocks to a public-IP default for this test alone.
      resolve4Mock.mockReset().mockResolvedValue(["93.184.216.34"]);
      resolve6Mock.mockReset().mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);

      // 6 consecutive 302 responses. webFetch's loop is
      // `for (i=0; i <= MAX_REDIRECT_HOPS; i++)`, so it fires
      // MAX_REDIRECT_HOPS + 1 = 6 fetches before the "Too many redirects"
      // branch trips at `i === MAX_REDIRECT_HOPS`.
      for (let i = 0; i < 6; i++) {
        fetchMock.mockResolvedValueOnce({
          status: 302,
          ok: false,
          headers: new Map([["location", `https://example.com/hop${i + 1}`]]),
        });
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

  describe("body size cap (OOM guard)", () => {
    it("rejects a response whose Content-Length exceeds the byte budget", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map([
          ["content-type", "text/plain"],
          ["content-length", String(100 * 1024 * 1024)],
        ]),
        text: async () => {
          throw new Error("body must not be read when Content-Length is over budget");
        },
      });

      const result = await webFetch("https://example.com/huge", { maxChars: 1000 });

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/too large/i);
    });

    it("stops streaming the body at the byte cap when Content-Length is absent", async () => {
      let chunksPulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksPulled++;
          controller.enqueue(new Uint8Array(1024).fill(65)); // 1 KB of 'A'
          if (chunksPulled > 100) controller.close(); // would be ~100 KB total
        },
      });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map([["content-type", "text/plain"]]), // no content-length
        body,
        text: async () => {
          throw new Error("must not buffer the whole body via text()");
        },
      });

      const result = await webFetch("https://example.com/chunked", { maxChars: 100 });

      expect(result.isError).toBeUndefined();
      // cap = 100 * 8 = 800 bytes ≈ 1 chunk, so we stop far before the 100-chunk end.
      expect(chunksPulled).toBeLessThan(5);
    });
  });
});

describe("extractReadableContent", () => {
  // A JavaScript single-page-app shell: the real content is rendered client-side,
  // so the static HTML carries no readable prose (the zaruba-edv.at case). The
  // old code fell back to `?? text` and shipped ~50KB of raw markup to the agent
  // with isError unset — an honest, distinct error is required instead.
  it("flags a client-side-rendered shell instead of returning raw HTML markup", () => {
    const spa = `<!DOCTYPE html><html dir="ltr" lang="en"><head><title>App</title>
      <meta name="app-name" content="export_website"></head>
      <body><div id="root"></div><script>window.__APP__=1;</script></body></html>`;

    const result = extractReadableContent(spa, "text/html", 50000);

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("<");
    expect(result.content).not.toContain("DOCTYPE");
    // Honest empty-state: names client-side rendering as ONE possibility...
    expect(result.content.toLowerCase()).toMatch(/client-side|javascript|single-page/);
    // ...without asserting it as the sole cause (a short static page is also possible).
    expect(result.content.toLowerCase()).toMatch(/little text|or simply|little textual/);
  });

  // A content-rich marketing/landing page with no <article> element. Readability
  // grabs only a fragment of such pages (the ambersearch.de case: 1048 of 5241
  // visible chars), so we must fall back to the full visible text — keeping the
  // first AND last section — rather than to a fragment or raw markup.
  it("returns full visible text when Readability under-extracts a non-article page", () => {
    const sections = Array.from(
      { length: 14 },
      (_, i) => `<section><div>Heading ${i}</div><div>Distinct marketing line number ${i}.</div></section>`,
    ).join("");
    const html = `<!DOCTYPE html><html><head><title>Marketing</title></head><body><header>Home Pricing Login</header>${sections}</body></html>`;

    const result = extractReadableContent(html, "text/html", 50000);

    expect(result.isError).toBeFalsy();
    expect(result.content).not.toContain("<");
    expect(result.content).toContain("Distinct marketing line number 0.");
    expect(result.content).toContain("Distinct marketing line number 13.");
    // Header chrome survives only on the visible-text branch (Readability strips
    // nav), proving the fallback ran rather than Readability capturing the page.
    expect(result.content).toContain("Pricing");
  });

  // A well-structured article: Readability's clean extraction is preferred over
  // the raw visible text (which would include nav/footer chrome).
  it("uses Readability's clean text for a well-structured article", () => {
    const para =
      "<p>This is a substantial paragraph of genuine article prose that Readability recognises as the main body of the document.</p>";
    const html = `<html><body><nav>Home About Contact</nav><article><h1>Headline</h1>${para.repeat(5)}</article><footer>Footer chrome junk</footer></body></html>`;

    const result = extractReadableContent(html, "text/html", 50000);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("substantial paragraph of genuine article prose");
    expect(result.content).not.toContain("<");
  });

  // Script/style code must never leak into the visible-text fallback, even when
  // the closing tag is irregular (e.g. `</script >` with a space). Regex tag
  // stripping misses these (CodeQL js/bad-tag-filter); DOM parsing does not.
  it("strips script and style code from visible text despite irregular closing tags", () => {
    const html = `<!DOCTYPE html><html><head><style>.brand{color:#f00}</style ></head>
      <body><div>Hello world visible content</div>
      <script>window.SECRET_TOKEN = "leakme12345";</script >
      <div>second visible block</div></body></html>`;

    const out = visibleTextFromHtml(html);

    expect(out).toContain("Hello world visible content");
    expect(out).not.toContain("SECRET_TOKEN");
    expect(out).not.toContain("leakme12345");
    expect(out).not.toContain("color:#f00");
  });

  it("truncates extracted text at maxChars with a marker", () => {
    const html = `<html><body><article><p>${"word ".repeat(400)}</p></article></body></html>`;

    const result = extractReadableContent(html, "text/html", 100);

    expect(result.content.length).toBeLessThanOrEqual(100 + "\n\n[truncated]".length);
    expect(result.content).toContain("[truncated]");
  });

  it("returns non-HTML content unchanged", () => {
    const result = extractReadableContent("plain text body", "text/plain", 50000);

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("plain text body");
  });
});
