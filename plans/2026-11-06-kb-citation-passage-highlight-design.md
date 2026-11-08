# Highlighting the cited passage in the citation viewer (#1268)

PR #1314 shipped the title and download parts of #1268. This is the third part:
when a Knowledge Base citation opens at a page of a PDF, show the reader **which
passage on that page** the answer came from, instead of leaving them to hunt for
it on a dense page.

## Two problems, not one

1. **Rendering.** The viewer embeds the browser's own PDF viewer (`<embed>`).
   Chrome's viewer accepts `#page=N` and nothing that marks text; Safari's and
   iOS's accept less. Highlighting therefore needs our own renderer.
2. **Knowing the passage.** The citation link carries path and page, because the
   model writes path and page into its Sources list. The passage the model read
   (`knowledge_search`'s chunk text) never reaches the browser — chat messages
   carry text and files only, tool results stay server-side.

## How the passage reaches the viewer

Options weighed:

| Option                                                                       | Verdict                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Put a chunk id into the citation (`[1] path — p. 5 #c3f9`)                   | Rejected. It changes the citation contract every agent follows, the eval graders' strict `parseCitedPosition`, and the text the reader sees. Models also drop opaque ids, so it degrades anyway.                                                                               |
| Match the answer's claim against the page's text layer, client-side          | Rejected as the primary path. `knowledge-search/SKILL.md` tells the model to answer **in the user's language** — a German page cited in an English answer shares almost no words with the claim. Lexical overlap would miss exactly there, or worse, highlight the wrong line. |
| Record which chunks `knowledge_search` returned per conversation             | Rejected. A new table (or audit detail beyond its 2 KB budget) to remember something the index can answer.                                                                                                                                                                     |
| **Ask the index: of the chunks on this page, which one is the claim about?** | **Chosen.**                                                                                                                                                                                                                                                                    |

The chosen path: chunks never cross a page (`chunk.ts` chunks each page on its
own), so `(document, page)` narrows the candidates to the 1–3 chunks of that
page, ~512 tokens each. Each chunk already carries its embedding. The answer's
**claim** — the sentence(s) that cite the source number — is embedded once with
the same local, multilingual model (`embeddinggemma`, ~20 ms per query on the
staging box) and the nearest chunk wins. Cross-lingual by construction, no
contract change, nothing new stored.

- One chunk on the page → returned without embedding anything.
- Several chunks and no claim (or embedder unavailable) → **no passage**. No
  highlight is honest; the wrong highlight is a false claim about the document.

### Where the claim comes from

`remarkSourceLinks` already walks the whole answer's mdast. For each citation
link it now also derives a claim:

- A Sources entry (`- [1] quality/QM/Handbook.pdf — p. 5`): the number before
  the path is read, and the claim is the answer's sentences that cite `[1]`
  (also `[1, 2]`, `[1][2]`), up to 3 sentences / 600 characters.
- A path cited inline in prose: the sentence around it.

The claim is attached to the link as a hast property (`data-cited-claim`), not
to its href. `WORKSPACE_FILE_HREF` — the security-relevant shape a citation must
have — does not widen. Markdown has no syntax for hast properties, so a model
cannot author one; and the claim is only ever a ranking hint sent to our own
endpoint, so a forged one could at most pick a different chunk of a page the
reader may already open.

## The endpoint

`POST /api/agents/:agentId/knowledge/passage` — body `{ path, page, claim? }`,
answers `{ passage: { text } | null }`.

- POST so the claim (conversation text, possibly PII) stays out of URLs and
  access logs. Read-only: `audit-exempt`, because the view it accompanies is
  already audited by `workspace-file` (`knowledge.source_viewed`) and the
  endpoint returns text from a document that view hands over whole.
- Same gates as `workspace-file`, in the same order: `getAgentWithAccess`, then
  `resolveAllowedFile` against the agent's saved `pinchy-files` grants. A path
  outside the grant answers 403 before the index is read — the endpoint must
  not become a way to read chunk text of documents the reader cannot open.
- Chunks are looked up by `source_path` (requested path or its real path) and
  `locator = {kind: page, page}`; archived and active alike (an archived document
  can still be cited when the user asked for the archive).

## Rendering

`PdfDialog` keeps the `<embed>` for everything **except** a page citation of a
PDF (the case where there is a passage to show). That one renders through
pdf.js in the browser:

- the cited page on a canvas sized to the dialog width (device-pixel-ratio
  sharp), with previous / next page buttons; "Open in new tab" still opens the
  browser's full viewer, so search, selection and printing are one click away.
- `disableStream` + `disableAutoFetch` over the route's existing Range support,
  so a 500-page binder fetches the bytes for one page, not the whole file —
  better than the `<embed>` was for large files on browsers that don't range.
- the legacy pdf.js build, for iOS Safari versions the modern build drops. On
  iOS this is an improvement in its own right: an `<embed>` there shows a static
  first page and ignores `#page=`.
- **Any** failure to load or render (encrypted file, broken PDF, worker blocked)
  falls back to the `<embed>` the dialog used before. The highlight is an
  enhancement; it must never cost the reader the document.

### Finding the passage on the page

The chunk text was built from pdf.js `getTextContent()` items on the server
(`pdf-extract.ts`: items joined with spaces, lines with `\n`). The browser runs
the same library version over the same bytes, so after **removing all
whitespace** on both sides the chunk is an exact substring of the page's item
string. Each character remembers its item; the matched items are highlighted as
rectangles computed from their transforms (the same geometry pdf.js's text
layer uses). If the exact match fails (an OCR'd scan has no text layer to match),
the first and last 60 characters are tried as anchors; failing that, no
highlight. The highlighted region is scrolled into view, and its text is also
exposed to screen readers, since a canvas has none.

## Out of scope (follow-ups)

- **Office documents.** Their citations carry a heading path, not a page, so the
  viewer has no page to start from. Finding a chunk across all pages of the
  converted PDF is possible but a separate cost decision.
- **Sentence-level focus within the chunk.** A chunk is roughly a third of a
  dense page; narrowing to the sentence would need per-sentence embeddings at
  view time.
- Text selection inside our renderer (pdf.js `TextLayer`). The new-tab viewer
  covers it.

## Tests

- `passage-match.ts` (pure): exact match across whitespace differences, anchor
  fallback, no match, multi-item spans.
- `source-links`: claim derivation (Sources entry by number, multi-number,
  inline citation, caps) and that hrefs are unchanged.
- Route: 401/404/403 gates before any DB read, single chunk without embedding,
  nearest chunk by claim, several chunks without claim → null, wrong page → null.
- `PdfDialog`: page citations render the pdf.js viewer (renderer mocked),
  highlight + accessible passage, prev/next, fallback to `<embed>` on load
  failure, non-page/Office citations keep the `<embed>`.
