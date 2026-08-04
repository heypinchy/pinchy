import { SimpleTextAttachmentAdapter, CompositeAttachmentAdapter } from "@assistant-ui/react";
import { uuid } from "@/lib/uuid";
import { CLIENT_MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/limits";

/**
 * Text-file attachment adapter — produces text content parts that get
 * concatenated into the user's message text. Kept because it's the only path
 * that doesn't go through the (removed) base64 `image_url` flow; image and
 * PDF uploads now go through the two-phase upload pipeline
 * (`addPendingUpload` → POST /uploads → `attachmentIds` on send).
 */
/**
 * Adapter for source-code files whose content the model reads inline as text.
 *
 * The plain-text / CSV / Markdown / JSON / YAML types are deliberately NOT
 * listed here: those are workspace data files (issue #392) routed through the
 * two-phase upload pipeline (`addPendingUpload` → POST /uploads → server
 * staging), the same path used for images and PDFs. Because the assistant-ui
 * `CompositeAttachmentAdapter` would inline anything matching its `accept`
 * mask, listing those types here would short-circuit the upload and bypass
 * the agent's workspace.
 */
class CodeTextAttachmentAdapter extends SimpleTextAttachmentAdapter {
  public override accept =
    "text/html,text/xml,text/css,application/javascript,application/typescript,.js,.ts,.tsx,.jsx,.py,.rs,.go,.sh,.sql,.toml";
}

/**
 * Adapter for Office documents the model needs as readable text.
 *
 * Currently: .docx only. The file is a ZIP archive of XML; reading it via
 * the plain-text adapter would ship the model the literal "PK…" bytes of
 * the archive. We convert it to Markdown with mammoth + turndown at upload
 * time — headings survive as ATX `#`/`##`, tables as GFM pipe tables, lists
 * as bullet/numbered lines, and embedded images become `[image]` placeholders.
 *
 * Mammoth and turndown are dynamically imported inside send() so they don't
 * land in the initial chat bundle for users who never attach a .docx.
 *
 * Filename is XML-escaped into the `<attachment name="…">` wrapper so the
 * agent can cite the source document even when the name contains spaces,
 * ampersands, or angle brackets.
 *
 * Exported only so the size-rejection contract and the wrapper escaping
 * can be unit-tested in isolation.
 */
export class OfficeDocumentAttachmentAdapter {
  public accept = "application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx";

  async add(state: { file: File }) {
    const { file } = state;
    if (file.size > CLIENT_MAX_ATTACHMENT_SIZE_BYTES) {
      const limitMb = Math.round(CLIENT_MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024);
      throw new Error(
        `File "${file.name}" is too large (${Math.round(file.size / 1024 / 1024)} MB). The limit is ${limitMb} MB.`
      );
    }
    return {
      id: uuid(),
      type: "document" as const,
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    };
  }

  async send(attachment: { id?: string; name: string; file: File }) {
    const arrayBuffer = await attachment.file.arrayBuffer();
    const { default: mammoth } = await import("mammoth");
    const { default: TurndownService } = await import("turndown");
    const { gfm } = await import("turndown-plugin-gfm");

    const { value: html } = await mammoth.convertToHtml(
      { arrayBuffer },
      {
        // Empty src skips mammoth's base64 encoding; the strip-image
        // turndown rule below replaces <img> with [image] downstream.
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
      }
    );

    const normalizedHtml = normalizeDocxTableHtml(html);

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    turndown.use(gfm);
    turndown.addRule("strip-image", {
      filter: "img",
      replacement: () => "[image]",
    });
    const value = turndown.turndown(normalizedHtml);

    return {
      id: attachment.id ?? uuid(),
      type: "document" as const,
      name: attachment.name,
      file: attachment.file,
      status: { type: "complete" as const },
      content: [
        {
          type: "text" as const,
          text: `<attachment name="${escapeXmlAttribute(attachment.name)}">\n${value}\n</attachment>`,
        },
      ],
    };
  }

  async remove(): Promise<void> {
    // No-op — local files require no cleanup
  }
}

/**
 * Normalize mammoth-generated table HTML so turndown's GFM plugin produces
 * pipe tables.
 *
 * Mammoth emits `<table><tr><td>…</td></tr></table>` — no `<thead>`, no
 * `<th>`, and cell content wrapped in `<p>`. The turndown-plugin-gfm table
 * rule only activates when the first row is a heading row (all-`<th>` or
 * inside `<thead>`). This function:
 *  1. Strips `<p>` wrappers inside cells so content is inline.
 *  2. Promotes the first `<tr>` into a `<thead>` with `<th>` cells.
 *
 * KEEP-IN-SYNC with `normalizeTableHtml` in
 * `packages/plugins/pinchy-files/docx-extract.ts`. See that file for the
 * rationale for the intentional duplication.
 */
function normalizeDocxTableHtml(html: string): string {
  let out = html.replace(/<(td|th)([^>]*)><p>([\s\S]*?)<\/p><\/(td|th)>/g, "<$1$2>$3</$1>");

  // Mammoth emits no <tbody>, so rows sit directly under <table>.
  out = out.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner: string) => {
    const firstRowMatch = inner.match(/^(<tr>[\s\S]*?<\/tr>)/);
    if (!firstRowMatch) return `<table>${inner}</table>`;
    const firstRow = firstRowMatch[1];
    const rest = inner.slice(firstRow.length);
    const headingRow = firstRow.replace(/<td([^>]*)>/g, "<th$1>").replace(/<\/td>/g, "</th>");
    return `<table><thead>${headingRow}</thead><tbody>${rest}</tbody></table>`;
  });

  return out;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Image and PDF MIMEs (and the workspace-data formats CSV/JSON/YAML/MD/TXT)
// are NOT here — they go through the two-phase upload pipeline
// (PinchyAttachmentButton → addPendingUpload → POST /uploads), not through
// the assistant-ui adapter chain. Code-text + .docx still go through adapters
// because they inline extracted text into the message content (no `image_url`
// base64 frame, no PROTOCOL_OUTDATED rejection).
// Exported for the routing tests in `__tests__/lib/attachment-adapters.test.ts`
// which assert which adapter accepts a given (filename, MIME) pair — see
// issue #392.
export const attachmentAdapter = new CompositeAttachmentAdapter([
  new CodeTextAttachmentAdapter(),
  new OfficeDocumentAttachmentAdapter(),
]);
