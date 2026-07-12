/* global caches, crypto */
// Handles the Web Share Target API POST that the installed PWA receives at
// /share-target (manifest `share_target` entry, method: POST, enctype:
// multipart/form-data, files field name "files"). Lives outside the Service
// Worker file itself (sw.js) so it can be `importScripts()`-ed by the SW
// AND imported directly by vitest — plain JS, no imports/exports, no
// top-level side effects beyond attaching functions to globalThis.
//
// Cache contract (see packages/web/src/__tests__/lib/pwa/sw-share-target.test.ts
// and the /share page client that reads this back — do not change without
// updating both):
//   Cache name: "share-target"
//   meta -> /__share/<id>/meta
//     JSON body: { files: [{ index, name, type }], title, text, url, createdAt }
//     createdAt (epoch ms) lets sweepStaleShares() reclaim entries the user
//     previewed but never sent — Cache Storage has no TTL of its own.
//   file -> /__share/<id>/file/<index>
//     Body: the raw file blob.
//     Headers: Content-Type: <mime>, X-Filename: <encodeURIComponent(name)>

async function handleShareTarget(request) {
  const form = await request.formData();
  const id = crypto.randomUUID();
  const cache = await caches.open("share-target");

  const files = form.getAll("files").filter((value) => value && typeof value !== "string");

  const meta = {
    files: [],
    title: String(form.get("title") || ""),
    text: String(form.get("text") || ""),
    url: String(form.get("url") || ""),
    createdAt: Date.now(),
  };

  for (let index = 0; index < files.length; index++) {
    // `index` is a bounded loop counter over `files.length`, never
    // user-controlled input — safe array access.
    // eslint-disable-next-line security/detect-object-injection
    const file = files[index];
    const name = file.name || `file-${index}`;
    const type = file.type || "application/octet-stream";
    meta.files.push({ index, name, type });
    await cache.put(
      `/__share/${id}/file/${index}`,
      new Response(file, {
        headers: {
          "Content-Type": type,
          "X-Filename": encodeURIComponent(name),
        },
      })
    );
  }

  await cache.put(
    `/__share/${id}/meta`,
    new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    })
  );

  // Manual 303 Response rather than Response.redirect(): POST-to-GET
  // redirects after a share-target submission must be a real 303 so the
  // browser re-requests /share as a GET, and constructing it directly here
  // avoids relying on Response.redirect()'s cross-environment quirks.
  return new Response(null, {
    status: 303,
    headers: { Location: `/share?share_id=${id}` },
  });
}

globalThis.handleShareTarget = handleShareTarget;
