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

- **Office documents.** Their citations carry a heading path or a slide, not a
  page, so the viewer has no page to start from. Decided and built in the
  addendum below.
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

## Addendum: Office documents (Word, PowerPoint)

The first cut highlighted PDF page citations only. An Office citation opens as
its converted PDF, but it names a slide (`deck.pptx — slide 4`) or a heading
path (`Handbook.docx — § Quality > Incoming goods`), not a page, so the viewer
had no page to draw and kept the browser's `<embed>`. This addendum closes that.

### What the index already knows

Office documents are indexed from the PDF LibreOffice makes of them
(`ingest.ts` → `extractOfficeDocument`), with the same `pdf-extract.ts` and the
same per-page `chunkPages` as a PDF. Two consequences:

- **Every Office chunk lies on exactly one page of the converted PDF**, and its
  text matches that page's pdf.js runs once whitespace is removed — the premise
  `locatePassage` rests on holds unchanged.
- **The page is not stored.** A presentation chunk carries `{kind: "slide",
slide: chunk.page}`, so for slides the page is the slide number: the
  converter maps them one to one (`ingest.ts`, `pageCount` comment) and the
  locator is literally the artifact page. A Word chunk carries only
  `{kind: "heading", headings}`; the page is the renderer's, deliberately
  dropped (`locator.ts`).

So slides need nothing new: slide N is page N, and the existing page flow
applies. The question is Word: which page of the converted PDF holds a chunk
filed under a heading path?

### Options for Word

| Option                                                                             | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store the artifact page on each chunk (new column)                                 | Rejected. A migration plus a backfill that only a re-conversion of every Office document can do; until then every existing chunk has no page, so the fallback is needed anyway. Pre-existing data is the normal state after an upgrade (AGENTS.md, "Test Migrations Against Pre-Existing Data").                                                                                                                                                                                               |
| Client scans the whole converted PDF's text layer for the chunk                    | Rejected. O(document): on a 400-page manual that is every page's content stream over Range requests plus 400 `getTextContent` calls before anything is highlighted — seconds to tens of seconds, and the whole file downloaded for one passage. It also degrades worst exactly where a highlight helps most.                                                                                                                                                                                   |
| Server finds the page in the artifact and returns it with the passage              | Rejected. It needs pdf.js parsing of the artifact on the server per citation click (CPU and memory in the web process, multiplied by concurrent readers), a second place that resolves an Office source to its artifact, and a server-side copy of the matching the browser already does over the document it already opened.                                                                                                                                                                  |
| **Client resolves the heading through the PDF's outline, scans only that section** | **Chosen.** LibreOffice exports Word's outline as PDF bookmarks, and the index's heading paths ARE that outline (`pdf-extract.ts` → `readOutline`). The outline sits in the document catalog, so resolving a heading to its page costs a few small Range requests, independent of document length. A chunk filed under a section lies between the page the section starts on and the page the next outline entry starts on (inclusive) — `headingLocatorAt` files by "latest section started". |

The scan is bounded twice: by the section's own pages, and by a hard cap
(`MAX_SECTION_SCAN_PAGES`, 25). A long section that exhausts the cap opens at
its first page without a highlight, which is still "opens at the cited
section". Cost on a large document is therefore the size of one section, not
of the document.

To guarantee the browser reads the outline exactly as the indexer did, the
flattening moves into one shared, pdf.js-free module (`lib/pdf/outline.ts`)
that both `pdf-extract.ts` and the browser use — same trimming, same rule that
an untitled entry adds no level. Two copies would drift on the first change,
and a drift here shows up only as silently missing highlights.

### Carrying the slide or heading to the viewer

The citation href does not change: `WORKSPACE_FILE_HREF` and the `#page=` /
`#sheet=` fragments stay exactly as they are. The slide or heading the citation
names is read from the citation text (`— slide 4`, `— § A > B`, also in
parentheses) and attached to the link as hast properties (`data-cited-slide`,
`data-cited-heading`), the same channel as `data-cited-claim` and for the same
reason: markdown has no syntax for them, so a model cannot author one, and they
are only ever a hint to our own endpoint and viewer. They are honoured only for
the matching format — a slide on a presentation, a heading on a Word document.

### Endpoint

`POST /api/agents/:agentId/knowledge/passage` takes exactly one anchor:
`{ path, page }`, `{ path, slide }` or `{ path, heading }` (heading as the path
joined with " > ", the spelling the citation shows), plus the optional `claim`.
Same gates, same order, same `audit-exempt` reasoning.

- `slide` matches `locator @> {kind: "slide", slide}`.
- `heading` matches by **equality of the joined path**, not by `@>`: jsonb
  containment on arrays ignores order and accepts subsets, so `["Quality"]`
  would match every chunk under "Quality > Incoming goods". Comparing the
  joined string also sidesteps a heading title that itself contains " > ".
- Ranking is unchanged. A section often holds many chunks (a page holds 1–3),
  so the claim matters more here; without a claim or embedder and with more
  than one candidate, the answer stays `null`.

### Viewer

- Slide: identical to a page citation, starting at page = slide.
- Heading: open the converted PDF, read its outline, find the entry whose
  joined path equals the heading. Not found (no outline, heading renamed since
  indexing, model misspelled it) → the browser's `<embed>`, exactly as today.
  Found → open at the section's first page at once, without waiting for the
  passage lookup: with several candidates the lookup embeds the claim, which
  takes seconds on a cold embedding model, and waiting for it left a Word
  citation on a spinner for that long. Once the passage arrives, scan
  the section's pages for it and move the highlight to the page that holds it;
  the reader moves with it only if they are still on the section's first page.
  No passage, or not found within the cap → stay at the section's first page.
- Any load, outline or render failure → the `<embed>`, as for PDFs.

### Tests (addendum)

- `outline.ts`: flattening (paths, untitled entries, unresolvable destinations),
  section page ranges (next entry, last entry, out-of-order outline), the
  bounded section scan; plus a real-PDF test against the committed LibreOffice
  fixture that every heading chunk the real ingest builds is found by the scan
  on the page it came from.
- `pdf-headings.test.ts` stays green after `pdf-extract.ts` moves onto the
  shared flattening.
- `source-links`: slide/heading parsed from the citation text into hast
  properties, href unchanged, honoured per format only; `buildPassageRequest`
  for slide and heading.
- Route + `cited-passage.integration`: slide and heading anchors, heading
  equality (not containment), body with zero or two anchors → 400.
- Viewer / dialog: slide opens at the slide; heading resolves to the section,
  highlights the scanned page; unknown heading → `<embed>`.
