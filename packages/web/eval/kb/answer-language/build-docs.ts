// Renders the German test documents in `docs/*.md` to the PDFs the sweep
// indexes. The ingest pipeline reads PDF and Office files, not Markdown, so the
// Markdown is the readable source and the PDF is what the agent searches.
//
//   pnpm -C packages/web tsx eval/kb/answer-language/build-docs.ts
//
// Re-run after editing a document and commit both files.
//
// A file named `*_Scan_*` becomes a scan: its pages are rasterized and the PDF
// carries images only, no text layer, so the ingest pipeline has to OCR it.
// That is the shape of the staging document that first showed #1296. It needs
// `pdftoppm` (poppler) on the PATH.
import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";

const DOCS_DIR = path.join(__dirname, "docs");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return full.endsWith(".md") ? [full] : [];
  });
}

async function render(source: string): Promise<void> {
  const target = source.replace(/\.md$/, ".pdf");
  // Fixed metadata dates keep a re-render byte-stable when the text is unchanged.
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    info: { CreationDate: new Date(0), ModDate: new Date(0) },
  });
  const done = new Promise<void>((resolve, reject) => {
    const out = createWriteStream(target);
    out.on("finish", resolve);
    out.on("error", reject);
    doc.pipe(out);
  });
  for (const block of readFileSync(source, "utf8").split(/\n\s*\n/)) {
    const text = block.trim();
    if (text.startsWith("# ")) {
      doc.font("Helvetica-Bold").fontSize(16).text(text.slice(2)).moveDown();
    } else if (text.startsWith("## ")) {
      doc.font("Helvetica-Bold").fontSize(12).text(text.slice(3)).moveDown(0.4);
    } else if (text) {
      doc.font("Helvetica").fontSize(11).text(text).moveDown();
    }
  }
  doc.end();
  await done;
  if (path.basename(source).includes("_Scan_")) await rasterize(target);
  console.log(`wrote ${path.relative(DOCS_DIR, target)}`);
}

/** Replaces a text PDF with one that holds only a 150 dpi grayscale image of each page. */
async function rasterize(pdf: string): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-scan-"));
  try {
    execFileSync("pdftoppm", ["-r", "150", "-gray", "-png", pdf, path.join(dir, "page")]);
    const pages = readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      autoFirstPage: false,
      info: { CreationDate: new Date(0), ModDate: new Date(0) },
    });
    const done = new Promise<void>((resolve, reject) => {
      const out = createWriteStream(pdf);
      out.on("finish", resolve);
      out.on("error", reject);
      doc.pipe(out);
    });
    for (const page of pages) {
      doc.addPage();
      doc.image(path.join(dir, page), 0, 0, {
        width: doc.page.width,
        height: doc.page.height,
      });
    }
    doc.end();
    await done;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  for (const file of markdownFiles(DOCS_DIR)) await render(file);
}

void main();
