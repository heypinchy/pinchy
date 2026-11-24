/**
 * Turns a scanned TIFF into a PDF of one image page per frame (#1409).
 *
 * A TIFF in a document archive is a scan: it has no text layer, so the only
 * reader that gets anything out of it is index-time OCR. The scanned-PDF path
 * already is that reader — its page budget, its retry rule for a failed vision
 * call, its audit tally and its page citations — so a TIFF is handed to it as
 * a PDF rather than given a second OCR path of its own. The same PDF is what a
 * citation opens, on the page the passage came from.
 *
 * The frames are decoded by libvips (through sharp), which reads TIFF with
 * libtiff. The file is untrusted, and libtiff has a long CVE history, so:
 *
 *   - The first bytes must be a TIFF header before any decoder sees the file.
 *     libvips picks its loader by sniffing the content, not the name, so
 *     without this check a `.tif` holding an SVG would reach librsvg, and one
 *     holding something else the loader for that.
 *   - The file, each frame's pixel count and the number of frames are bounded.
 *   - The caller runs this in the fenced, secret-free child process
 *     (`tiffToPdfIsolated`), so a decoder crash or a memory blow-up ends that
 *     child and not the server.
 *
 * One point per pixel: pdfjs renders a page at scale 1 for OCR
 * (`renderPageToImage`), so the vision model sees a frame at the resolution it
 * was scanned at, up to the same pixel budget a scanned PDF page gets.
 */
import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { finished } from "node:stream/promises";

import PDFDocument from "pdfkit";
import sharp from "sharp";

import { MAX_RENDER_PIXELS } from "../../../../plugins/pinchy-files/pdf-scan-rule";
import { OfficeFileRejectedError } from "./office-formats";

const MiB = 1024 * 1024;

/** The same ceiling an Office file gets (`OFFICE_MAX_FILE_BYTES`). */
export const TIFF_MAX_FILE_BYTES = 200 * MiB;

/**
 * libvips' own default: 16383 × 16383 pixels in one frame. That admits an A0
 * sheet scanned at 300 dpi; a frame larger than that is refused undecoded.
 */
export const TIFF_MAX_INPUT_PIXELS = 0x3fff * 0x3fff;

export interface TiffToPdfOptions {
  /**
   * Frames past this many are not converted. A frame has no text layer, so a
   * frame the OCR budget will not read would only cost a decode — the caller
   * passes that budget and accounts for the rest from `frames`.
   */
  maxFrames: number;
  /** Test seam; production uses `TIFF_MAX_FILE_BYTES`. */
  maxBytes?: number;
  /** Test seam; production uses `TIFF_MAX_INPUT_PIXELS`. */
  maxInputPixels?: number;
}

export interface TiffConversion {
  /** How many frames the TIFF has. */
  frames: number;
  /** How many of them are pages of the PDF: the first `converted`, in order. */
  converted: number;
}

/** Whether `head` starts like a TIFF or a BigTIFF, in either byte order. */
export function isTiffBytes(head: Buffer): boolean {
  if (head.length < 4) return false;
  const le = head[0] === 0x49 && head[1] === 0x49 && head[3] === 0x00;
  const be = head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00;
  if (le) return head[2] === 0x2a || head[2] === 0x2b;
  if (be) return head[3] === 0x2a || head[3] === 0x2b;
  return false;
}

async function readHead(path: string): Promise<Buffer> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a private copy the ingest or the artifact store made.
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** A decoder error is a verdict on the file; which one depends on what libvips said. */
function decodeRefusal(err: unknown): OfficeFileRejectedError {
  const message = err instanceof Error ? err.message : String(err);
  return /pixel limit/i.test(message)
    ? new OfficeFileRejectedError(
        "too_large",
        `a frame is larger than ${TIFF_MAX_INPUT_PIXELS} pixels`
      )
    : new OfficeFileRejectedError("unexpected_content", `not a readable TIFF: ${message}`);
}

/** One frame, oriented, shrunk to the render budget, encoded for the PDF. */
async function encodeFrame(
  src: string,
  page: number,
  limitInputPixels: number
): Promise<{ image: Buffer; width: number; height: number }> {
  // `failOn: "error"`: scanners write tags libtiff only warns about, and a
  // warning is no reason to refuse a scan. A truncated or corrupt frame is
  // an error and still refused.
  const load = () => sharp(src, { page, limitInputPixels, failOn: "error" });
  const meta = await load().metadata();
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new Error("frame has no dimensions");

  const pixels = width * height;
  const scale = pixels > MAX_RENDER_PIXELS ? Math.sqrt(MAX_RENDER_PIXELS / pixels) : 1;
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));

  const pipeline = load().rotate().resize(w, h, { fit: "fill" });
  // A bilevel scan (fax, office scanner on "text") stays lossless: JPEG
  // smears the edges OCR reads. Everything else is a photograph of a page,
  // and JPEG keeps a long scan's PDF a sensible size.
  const image =
    meta.bitsPerSample === 1
      ? await pipeline.toColourspace("b-w").png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  return { image, width: w, height: h };
}

/**
 * Writes the TIFF at `src` to `dest` as a PDF, one page per frame, at most
 * `maxFrames` of them.
 *
 * A file that is not a TIFF, is too large, or cannot be decoded is refused
 * with `OfficeFileRejectedError` — a verdict on the file, final for these
 * bytes. Anything else (the source vanished, `dest` could not be written) is
 * a plain error, about the machine rather than the file.
 */
export async function tiffToPdf(
  src: string,
  dest: string,
  opts: TiffToPdfOptions
): Promise<TiffConversion> {
  const maxBytes = opts.maxBytes ?? TIFF_MAX_FILE_BYTES;
  const limitInputPixels = opts.maxInputPixels ?? TIFF_MAX_INPUT_PIXELS;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a private copy the ingest or the artifact store made.
  const { size } = await stat(src);
  if (size > maxBytes) {
    throw new OfficeFileRejectedError(
      "too_large",
      `the file is ${size} bytes, over the ${maxBytes}-byte limit for a scan`
    );
  }
  if (!isTiffBytes(await readHead(src))) {
    throw new OfficeFileRejectedError(
      "unexpected_content",
      "the file does not start with a TIFF header"
    );
  }

  let frames: number;
  try {
    const meta = await sharp(src, { limitInputPixels, failOn: "error" }).metadata();
    if (meta.format !== "tiff") throw new Error(`decoded as ${meta.format}`);
    frames = meta.pages ?? 1;
  } catch (err) {
    throw decodeRefusal(err);
  }
  const converted = Math.min(frames, Math.max(0, opts.maxFrames));

  const doc = new PDFDocument({ autoFirstPage: false, compress: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller's private destination.
  const out = createWriteStream(dest);
  doc.pipe(out);
  try {
    for (let page = 0; page < converted; page++) {
      let encoded: Awaited<ReturnType<typeof encodeFrame>>;
      try {
        encoded = await encodeFrame(src, page, limitInputPixels);
      } catch (err) {
        throw decodeRefusal(err);
      }
      doc.addPage({ size: [encoded.width, encoded.height], margin: 0 });
      doc.image(encoded.image, 0, 0, { width: encoded.width, height: encoded.height });
    }
  } finally {
    doc.end();
    await finished(out);
  }
  return { frames, converted };
}
