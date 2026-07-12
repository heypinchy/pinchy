// Reads and clears the shared payload the service worker's share-target
// handler stashes in the Cache API before redirecting to /share?share_id=<id>
// (see public/sw-share-target.js for the writer and the exact contract this
// module reads back).
//
// Cache contract (do not change without updating both):
//   Cache name: "share-target"
//   meta -> /__share/<id>/meta
//     JSON body: { files: [{ index, name, type }], title, text, url, createdAt }
//   file -> /__share/<id>/file/<index>
//     Body: the raw file blob.
//     Headers: Content-Type: <mime>, X-Filename: <encodeURIComponent(name)>

const CACHE_NAME = "share-target";

interface ShareMetaFile {
  index: number;
  name: string;
  type: string;
}

interface ShareMeta {
  files?: ShareMetaFile[];
  title?: string;
  text?: string;
  url?: string;
  /** Epoch ms the share was written by the service worker. */
  createdAt?: number;
}

export interface SharedPayload {
  files: File[];
  title: string;
  text: string;
  url: string;
}

/**
 * Reads the shared payload for `id` back out of the "share-target" cache.
 * Returns `null` when the Cache API is unavailable (SSR, unsupported
 * browser) or when no meta entry exists for `id` (unknown/already-cleared
 * share).
 */
export async function readSharedPayload(id: string): Promise<SharedPayload | null> {
  if (typeof caches === "undefined") {
    return null;
  }

  const cache = await caches.open(CACHE_NAME);
  const metaResponse = await cache.match(`/__share/${id}/meta`);
  if (!metaResponse) {
    return null;
  }

  const meta = (await metaResponse.json()) as ShareMeta;
  const files: File[] = [];

  for (const entry of meta.files ?? []) {
    const fileResponse = await cache.match(`/__share/${id}/file/${entry.index}`);
    if (!fileResponse) {
      continue;
    }

    const blob = await fileResponse.blob();
    const encodedName = fileResponse.headers.get("X-Filename");
    const name = encodedName ? decodeURIComponent(encodedName) : entry.name;
    files.push(new File([blob], name, { type: entry.type }));
  }

  return {
    files,
    title: meta.title ?? "",
    text: meta.text ?? "",
    url: meta.url ?? "",
  };
}

/**
 * Deletes every cache entry belonging to `id` (the meta entry and all of
 * its file entries). No-op when the Cache API is unavailable.
 */
export async function clearSharedPayload(id: string): Promise<void> {
  if (typeof caches === "undefined") {
    return;
  }

  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const prefix = `/__share/${id}/`;

  await Promise.all(
    keys
      .filter((key) => new URL(key.url).pathname.startsWith(prefix))
      .map((key) => cache.delete(key))
  );
}

const META_PATH_RE = /^\/__share\/([^/]+)\/meta$/;
const SHARE_ID_FROM_PATH_RE = /^\/__share\/([^/]+)\//;

/**
 * Reclaims shares older than `maxAgeMs` — the ones a user previewed on /share
 * but never sent (Cache Storage entries otherwise live until quota pressure
 * evicts them, which for 15 MB photos can mean they linger indefinitely). The
 * activate-time sweep is deliberately absent (a deploy landing mid-share must
 * not wipe an unconsumed one — see sw.js), so this age-gated sweep runs from
 * the /share page instead. `now` is injectable for deterministic tests.
 *
 * An entry whose meta is missing `createdAt` (written by an older SW build) or
 * is unreadable is treated as stale: only the current SW writes fresh entries,
 * and it always stamps `createdAt`, so a timestamp-less entry is safe to drop.
 */
export async function sweepStaleShares(maxAgeMs: number, now: number = Date.now()): Promise<void> {
  if (typeof caches === "undefined") {
    return;
  }

  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();

  const staleIds = new Set<string>();
  for (const key of keys) {
    const match = new URL(key.url).pathname.match(META_PATH_RE);
    if (!match) continue;
    const id = match[1];

    let createdAt: number | undefined;
    const metaResponse = await cache.match(key);
    if (metaResponse) {
      try {
        createdAt = ((await metaResponse.json()) as ShareMeta).createdAt;
      } catch {
        // Corrupted meta — reclaim it.
      }
    }

    if (createdAt === undefined || now - createdAt > maxAgeMs) {
      staleIds.add(id);
    }
  }

  if (staleIds.size === 0) {
    return;
  }

  await Promise.all(
    keys
      .filter((key) => {
        const idMatch = new URL(key.url).pathname.match(SHARE_ID_FROM_PATH_RE);
        return idMatch ? staleIds.has(idMatch[1]) : false;
      })
      .map((key) => cache.delete(key))
  );
}
