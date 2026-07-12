// @vitest-environment node
//
// This module deals with real multipart FormData/Request/Response bodies.
// jsdom's fetch polyfill does not implement Request.formData() reliably
// (observed: it hangs indefinitely), so this file opts out of the default
// jsdom environment in favor of Node's native fetch implementation.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// sw-share-target.js is a plain-JS module with no imports/exports (it runs
// inside Service Worker scope, which cannot import from src/). It only
// defines functions and attaches them to globalThis, so importing it here
// for that side effect is safe to do directly in a vitest (Node) context.
import "../../../../public/sw-share-target.js";

const handleShareTarget = (
  globalThis as unknown as { handleShareTarget: (request: Request) => Promise<Response> }
).handleShareTarget;

/**
 * Minimal in-memory stand-in for the Cache Storage API (`caches.open`).
 * Keyed by request URL, mirroring how the real Cache API dedupes entries.
 * `keys()` returns `Request` objects (as the spec requires) built from
 * same-origin absolute URLs so `new URL(key.url).pathname` works exactly
 * like it would against a real Cache.
 */
function createMockCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async put(request: RequestInfo, response: Response) {
      const url = typeof request === "string" ? request : request.url;
      const absolute = new URL(url, "https://pinchy.example").toString();
      store.set(absolute, response);
    },
    async match(request: RequestInfo) {
      const url = typeof request === "string" ? request : request.url;
      const absolute = new URL(url, "https://pinchy.example").toString();
      return store.get(absolute);
    },
    async keys() {
      return Array.from(store.keys()).map((url) => new Request(url));
    },
    async delete(request: RequestInfo) {
      const url = typeof request === "string" ? request : request.url;
      const absolute = new URL(url, "https://pinchy.example").toString();
      return store.delete(absolute);
    },
  };
}

const FIXED_ID = "11111111-1111-1111-1111-111111111111";
const FIXED_TIME = 1_700_000_000_000;

describe("sw-share-target", () => {
  let mockCache: ReturnType<typeof createMockCache>;

  beforeEach(() => {
    mockCache = createMockCache();
    vi.stubGlobal("caches", {
      open: vi.fn(async (name: string) => {
        expect(name).toBe("share-target");
        return mockCache;
      }),
    });
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      randomUUID: vi.fn(() => FIXED_ID),
    });
    vi.spyOn(Date, "now").mockReturnValue(FIXED_TIME);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function buildRequest(form: FormData) {
    return new Request("https://pinchy.example/share-target", {
      method: "POST",
      body: form,
    });
  }

  async function readMeta(id: string) {
    const metaResponse = await mockCache.match(`/__share/${id}/meta`);
    expect(metaResponse).toBeDefined();
    return metaResponse!.json();
  }

  it("stashes a single shared file + text and redirects to /share?share_id=<id>", async () => {
    const form = new FormData();
    const file = new File(["fake-jpeg-bytes"], "invoice.jpg", { type: "image/jpeg" });
    form.set("files", file);
    form.set("text", "Look at this invoice");

    const response = await handleShareTarget(buildRequest(form));

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/share?share_id=${FIXED_ID}`);

    const fileResponse = await mockCache.match(`/__share/${FIXED_ID}/file/0`);
    expect(fileResponse).toBeDefined();
    expect(fileResponse!.headers.get("Content-Type")).toBe("image/jpeg");
    expect(decodeURIComponent(fileResponse!.headers.get("X-Filename")!)).toBe("invoice.jpg");
    const bytes = await fileResponse!.arrayBuffer();
    expect(new TextDecoder().decode(bytes)).toBe("fake-jpeg-bytes");

    const meta = await readMeta(FIXED_ID);
    expect(meta).toEqual({
      files: [{ index: 0, name: "invoice.jpg", type: "image/jpeg" }],
      title: "",
      text: "Look at this invoice",
      url: "",
      createdAt: FIXED_TIME,
    });
  });

  it("stashes multiple shared files at distinct indices", async () => {
    const form = new FormData();
    form.append("files", new File(["one"], "a.png", { type: "image/png" }));
    form.append("files", new File(["two"], "b.pdf", { type: "application/pdf" }));
    form.set("title", "Two files");
    form.set("url", "https://example.com/source");

    const response = await handleShareTarget(buildRequest(form));
    expect(response.status).toBe(303);

    const file0 = await mockCache.match(`/__share/${FIXED_ID}/file/0`);
    const file1 = await mockCache.match(`/__share/${FIXED_ID}/file/1`);
    expect(file0).toBeDefined();
    expect(file1).toBeDefined();
    expect(decodeURIComponent(file0!.headers.get("X-Filename")!)).toBe("a.png");
    expect(decodeURIComponent(file1!.headers.get("X-Filename")!)).toBe("b.pdf");

    const meta = await readMeta(FIXED_ID);
    expect(meta).toEqual({
      files: [
        { index: 0, name: "a.png", type: "image/png" },
        { index: 1, name: "b.pdf", type: "application/pdf" },
      ],
      title: "Two files",
      text: "",
      url: "https://example.com/source",
      createdAt: FIXED_TIME,
    });
  });
});
