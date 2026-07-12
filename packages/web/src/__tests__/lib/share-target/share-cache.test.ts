// @vitest-environment node
//
// This module reads real Blob/File bodies out of Response objects retrieved
// from the Cache API. jsdom's fetch polyfill is unreliable for this kind of
// body handling (see src/__tests__/lib/pwa/sw-share-target.test.ts and
// src/__tests__/lib/license.test.ts for the same precedent — jsdom hangs or
// misbehaves on real Request/Response bodies), so this file opts out of the
// default jsdom environment in favor of Node's native fetch implementation.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readSharedPayload,
  clearSharedPayload,
  sweepStaleShares,
} from "@/lib/share-target/share-cache";

/**
 * Minimal in-memory stand-in for the Cache Storage API (`caches.open`),
 * mirroring the one used in sw-share-target.test.ts. Keyed by absolute URL,
 * `keys()` returns `Request` objects (as the real Cache API does) built from
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
      const response = store.get(absolute);
      // Real Cache API responses can be read once; clone so repeated
      // match() calls in a single test (or across readSharedPayload's own
      // meta + per-file matches) each get a fresh, unconsumed body.
      return response ? response.clone() : undefined;
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

async function seedShare(
  mockCache: ReturnType<typeof createMockCache>,
  id: string,
  options: {
    title?: string;
    text?: string;
    url?: string;
    fileName?: string;
    fileType?: string;
    fileBody?: string;
    createdAt?: number;
  } = {}
) {
  const fileName = options.fileName ?? "photo.jpg";
  const fileType = options.fileType ?? "image/jpeg";
  const fileBody = options.fileBody ?? "fake-image-bytes";

  await mockCache.put(
    `/__share/${id}/file/0`,
    new Response(fileBody, {
      headers: {
        "Content-Type": fileType,
        "X-Filename": encodeURIComponent(fileName),
      },
    })
  );

  const meta: Record<string, unknown> = {
    files: [{ index: 0, name: fileName, type: fileType }],
    title: options.title ?? "Shared title",
    text: options.text ?? "Shared text",
    url: options.url ?? "https://example.com/shared",
  };
  if (options.createdAt !== undefined) {
    meta.createdAt = options.createdAt;
  }

  await mockCache.put(
    `/__share/${id}/meta`,
    new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("share-cache", () => {
  let mockCache: ReturnType<typeof createMockCache>;

  beforeEach(() => {
    mockCache = createMockCache();
    vi.stubGlobal("caches", {
      open: async () => mockCache,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("readSharedPayload", () => {
    it("reads back the file, title, text, and url written by the service worker", async () => {
      const id = "share-1";
      await seedShare(mockCache, id, {
        title: "My Title",
        text: "My Text",
        url: "https://example.com/page",
        fileName: "vacation photo.jpg",
        fileType: "image/jpeg",
        fileBody: "binary-jpeg-content",
      });

      const payload = await readSharedPayload(id);

      expect(payload).not.toBeNull();
      expect(payload!.title).toBe("My Title");
      expect(payload!.text).toBe("My Text");
      expect(payload!.url).toBe("https://example.com/page");
      expect(payload!.files).toHaveLength(1);
      const file = payload!.files[0];
      expect(file).toBeInstanceOf(File);
      expect(file.name).toBe("vacation photo.jpg");
      expect(file.type).toBe("image/jpeg");
      expect(file.size).toBe(new TextEncoder().encode("binary-jpeg-content").length);
      expect(await file.text()).toBe("binary-jpeg-content");
    });

    it("falls back to empty strings when meta omits title/text/url", async () => {
      const id = "share-empty-meta";
      await mockCache.put(
        `/__share/${id}/meta`,
        new Response(JSON.stringify({ files: [] }), {
          headers: { "Content-Type": "application/json" },
        })
      );

      const payload = await readSharedPayload(id);

      expect(payload).toEqual({ files: [], title: "", text: "", url: "" });
    });

    it("decodes the filename from the X-Filename header rather than the meta name when they differ", async () => {
      const id = "share-header-name";
      await mockCache.put(
        `/__share/${id}/file/0`,
        new Response("content", {
          headers: {
            "Content-Type": "text/plain",
            "X-Filename": encodeURIComponent("hello world.txt"),
          },
        })
      );
      await mockCache.put(
        `/__share/${id}/meta`,
        new Response(
          JSON.stringify({
            files: [{ index: 0, name: "stale-name.txt", type: "text/plain" }],
            title: "",
            text: "",
            url: "",
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

      const payload = await readSharedPayload(id);

      expect(payload!.files[0].name).toBe("hello world.txt");
    });

    it("falls back to the meta entry's name when the X-Filename header is absent", async () => {
      const id = "share-no-header";
      await mockCache.put(`/__share/${id}/file/0`, new Response("content"));
      await mockCache.put(
        `/__share/${id}/meta`,
        new Response(
          JSON.stringify({
            files: [{ index: 0, name: "fallback-name.txt", type: "text/plain" }],
            title: "",
            text: "",
            url: "",
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

      const payload = await readSharedPayload(id);

      expect(payload!.files[0].name).toBe("fallback-name.txt");
    });

    it("skips a file entry whose blob is missing from the cache", async () => {
      const id = "share-missing-file";
      // Meta references file index 0, but no file/0 entry was ever put.
      await mockCache.put(
        `/__share/${id}/meta`,
        new Response(
          JSON.stringify({
            files: [{ index: 0, name: "ghost.txt", type: "text/plain" }],
            title: "",
            text: "",
            url: "",
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );

      const payload = await readSharedPayload(id);

      expect(payload!.files).toHaveLength(0);
    });

    it("returns null when the meta entry is missing (unknown id)", async () => {
      const payload = await readSharedPayload("unknown-id");
      expect(payload).toBeNull();
    });

    it("returns null when the Cache API is unavailable (SSR/unsupported)", async () => {
      vi.unstubAllGlobals();
      const original = globalThis.caches;
      // @ts-expect-error - simulating an environment without Cache API
      delete globalThis.caches;

      try {
        const payload = await readSharedPayload("any-id");
        expect(payload).toBeNull();
      } finally {
        globalThis.caches = original;
      }
    });
  });

  describe("clearSharedPayload", () => {
    it("deletes exactly the entries for the given id and leaves other ids intact", async () => {
      await seedShare(mockCache, "share-a");
      await seedShare(mockCache, "share-b");

      expect(mockCache.store.size).toBe(4);

      await clearSharedPayload("share-a");

      const remainingKeys = Array.from(mockCache.store.keys()).map((url) => new URL(url).pathname);
      expect(remainingKeys).toHaveLength(2);
      expect(remainingKeys.every((path) => path.startsWith("/__share/share-b/"))).toBe(true);

      // share-a is really gone: reading it back returns null.
      const payload = await readSharedPayload("share-a");
      expect(payload).toBeNull();

      // share-b is untouched: reading it back still works.
      const otherPayload = await readSharedPayload("share-b");
      expect(otherPayload).not.toBeNull();
    });

    it("does nothing when the Cache API is unavailable (SSR/unsupported)", async () => {
      vi.unstubAllGlobals();
      const original = globalThis.caches;
      // @ts-expect-error - simulating an environment without Cache API
      delete globalThis.caches;

      try {
        await expect(clearSharedPayload("any-id")).resolves.toBeUndefined();
      } finally {
        globalThis.caches = original;
      }
    });
  });

  describe("sweepStaleShares", () => {
    it("deletes shares older than maxAge and leaves fresh ones intact", async () => {
      await seedShare(mockCache, "old", { createdAt: 1000 });
      await seedShare(mockCache, "fresh", { createdAt: 9000 });
      expect(mockCache.store.size).toBe(4);

      // now=10000, maxAge=2000 → "old" (age 9000) is stale, "fresh" (age 1000) survives.
      await sweepStaleShares(2000, 10000);

      const paths = Array.from(mockCache.store.keys()).map((url) => new URL(url).pathname);
      expect(paths).toHaveLength(2);
      expect(paths.every((path) => path.startsWith("/__share/fresh/"))).toBe(true);

      expect(await readSharedPayload("old")).toBeNull();
      expect(await readSharedPayload("fresh")).not.toBeNull();
    });

    it("reclaims an entry whose meta predates the createdAt field", async () => {
      await mockCache.put(
        `/__share/legacy/meta`,
        new Response(JSON.stringify({ files: [] }), {
          headers: { "Content-Type": "application/json" },
        })
      );

      await sweepStaleShares(2000, 10000);

      expect(mockCache.store.size).toBe(0);
    });

    it("keeps an entry exactly at the age boundary (not strictly older)", async () => {
      await seedShare(mockCache, "boundary", { createdAt: 8000 });

      // age === maxAge is NOT "older than", so it stays.
      await sweepStaleShares(2000, 10000);

      expect(await readSharedPayload("boundary")).not.toBeNull();
    });

    it("does nothing when the Cache API is unavailable (SSR/unsupported)", async () => {
      vi.unstubAllGlobals();
      const original = globalThis.caches;
      // @ts-expect-error - simulating an environment without Cache API
      delete globalThis.caches;

      try {
        await expect(sweepStaleShares(2000, 10000)).resolves.toBeUndefined();
      } finally {
        globalThis.caches = original;
      }
    });
  });
});
