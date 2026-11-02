/**
 * Builds Windows metafiles (EMF, EMF+, WMF) for tests of the Office preflight.
 *
 * A metafile is a picture LibreOffice draws record by record — and some of
 * those records carry ANOTHER picture: an EMF+ image object holds compressed
 * bitmap bytes (any format LibreOffice's graphic filter detects, SVG included),
 * a WMF escape can hold a whole EMF. The third review of PR #1243 put an SVG
 * that reads a local file into an EMF+ image object, behind 4 KiB of comment
 * padding so the first bytes looked like nothing but a metafile, and
 * LibreOffice drew the local file into the PDF. These builders make those
 * shapes, and the plain ones the preflight must keep, from first principles
 * ([MS-EMF], [MS-EMFPLUS], [MS-WMF]) rather than from a captured file.
 */

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const pad4 = (data: Buffer) => Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);

/** One EMF record: type, size, payload (padded to 4 bytes). */
export function emfRecord(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const body = pad4(payload);
  return Buffer.concat([u32(type), u32(8 + body.length), body]);
}

/** An EMR_COMMENT whose data starts with `identifier` (omit it for a bare private comment). */
export function emfComment(identifier: number | null, data: Buffer = Buffer.alloc(0)): Buffer {
  const payload = identifier === null ? data : Buffer.concat([u32(identifier), data]);
  const padded = pad4(payload);
  return Buffer.concat([u32(70), u32(12 + padded.length), u32(payload.length), padded]);
}

export const EMF_PLUS_ID = 0x2b464d45; // "EMF+"
export const GDI_PUBLIC_ID = 0x43494447; // "GDIC"

/** One EMF+ record: type, flags, size, data size, data (padded to 4 bytes). */
export function emfPlusRecord(type: number, flags: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const body = pad4(data);
  return Buffer.concat([u16(type), u16(flags), u32(12 + body.length), u32(data.length), body]);
}

const EMF_PLUS_HEADER = emfPlusRecord(
  0x4001,
  0,
  Buffer.concat([u32(0xdbc01002), u32(1), u32(96), u32(96)])
);
const EMF_PLUS_EOF = emfPlusRecord(0x4002, 0);

/** An EMR_COMMENT carrying EMF+ records, framed by the EMF+ header and end-of-file records. */
export function emfPlusComment(...records: Buffer[]): Buffer {
  return emfComment(EMF_PLUS_ID, Buffer.concat([EMF_PLUS_HEADER, ...records, EMF_PLUS_EOF]));
}

/**
 * An EMF+ Object record holding an Image: a COMPRESSED bitmap (bytes in any
 * format a graphic filter detects) or an embedded METAFILE.
 */
export function emfPlusImageObject(bytes: Buffer, kind: "bitmap" | "metafile" = "bitmap"): Buffer {
  const image =
    kind === "bitmap"
      ? Buffer.concat([
          u32(0xdbc01002),
          u32(1), // ImageDataTypeBitmap
          i32(400),
          i32(200),
          i32(0),
          u32(0),
          u32(1), // BitmapDataTypeCompressed
          bytes,
        ])
      : Buffer.concat([
          u32(0xdbc01002),
          u32(2), // ImageDataTypeMetafile
          u32(3), // MetafileDataTypeEmf
          u32(bytes.length),
          bytes,
        ]);
  return emfPlusRecord(0x4008, 0x0500, image); // object type 5 = Image, id 0
}

/** An EMF+ Object record holding a Brush of `brushType` (0 solid, 2 texture fill…). */
export function emfPlusBrushObject(brushType: number, rest: Buffer = u32(0xff0070c0)): Buffer {
  return emfPlusRecord(0x4008, 0x0100, Buffer.concat([u32(0xdbc01002), u32(brushType), rest]));
}

/** An EMF+ Object record holding a solid Pen of no optional data, carrying a brush of `brushType`. */
export function emfPlusPenObject(brushType: number): Buffer {
  const pen = Buffer.concat([u32(0xdbc01002), u32(0), u32(0), u32(0), Buffer.alloc(4)]);
  return emfPlusRecord(
    0x4008,
    0x0200,
    Buffer.concat([pen, u32(0xdbc01002), u32(brushType), u32(0xff000000)])
  );
}

const rectF = (...values: number[]) => {
  const b = Buffer.alloc(16);
  values.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
};

/** A DrawImage record drawing object 0 from and into a 400x200 rectangle. */
export const EMF_PLUS_DRAW_IMAGE = emfPlusRecord(
  0x401a,
  0x0000,
  Buffer.concat([u32(0), i32(2), rectF(0, 0, 400, 200), rectF(0, 0, 400, 200)])
);

/** A private EMR_COMMENT of `bytes` padding: pushes what follows past any "first kilobytes" check. */
export function paddingComment(bytes: number): Buffer {
  return emfComment(0x20444150 /* "PAD " */, Buffer.alloc(bytes, 0x41));
}

/** A complete EMF: header, `records`, and an EMR_EOF. */
export function emf(...records: Buffer[]): Buffer {
  const eof = Buffer.concat([u32(14), u32(20), u32(0), u32(16), u32(20)]);
  const body = Buffer.concat([...records, eof]);
  const size = 108 + body.length;
  const header = Buffer.concat([
    u32(1),
    u32(108),
    ...[0, 0, 400, 200].map(i32),
    ...[0, 0, 10583, 5291].map(i32),
    u32(0x464d4520), // " EMF"
    u32(0x10000),
    u32(size),
    u32(records.length + 2),
    u16(1),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    i32(1920),
    i32(1080),
    i32(508),
    i32(286),
    u32(0),
    u32(0),
    u32(0),
    i32(508000),
    i32(286000),
  ]);
  return Buffer.concat([header, body]);
}

/** One WMF record: size in 16-bit words, function, parameters. */
export function wmfRecord(fn: number, params: Buffer = Buffer.alloc(0)): Buffer {
  const body = params.length % 2 ? Buffer.concat([params, Buffer.alloc(1)]) : params;
  return Buffer.concat([u32(3 + body.length / 2), u16(fn), body]);
}

/** A META_ESCAPE record of `escapeFunction` carrying `data`. */
export function wmfEscape(escapeFunction: number, data: Buffer): Buffer {
  return wmfRecord(0x0626, Buffer.concat([u16(escapeFunction), u16(data.length), data]));
}

/** The MFCOMMENT escape Office uses to carry a whole EMF inside a WMF ("WMFC"). */
export function wmfEmbeddedEmf(emfBytes: Buffer): Buffer {
  const head = Buffer.concat([
    u32(0x43464d57), // "WMFC"
    u32(1),
    u32(0x00010000),
    u16(0),
    u32(0),
    u32(1),
    u32(emfBytes.length),
    u32(0),
    u32(emfBytes.length),
  ]);
  return wmfEscape(0x000f, Buffer.concat([head, emfBytes]));
}

/** A placeable WMF: the Aldus header, the WMF header, `records`, and META_EOF. */
export function wmf(...records: Buffer[]): Buffer {
  const body = Buffer.concat([...records, wmfRecord(0x0000)]);
  const header = Buffer.concat([
    u16(1),
    u16(9),
    u16(0x0300),
    u32((18 + body.length) / 2),
    u16(0),
    u32(3),
    u16(0),
  ]);
  const placeable = Buffer.concat([
    u32(0x9ac6cdd7),
    u16(0),
    ...[0, 0, 400, 200].map((n) => u16(n)),
    u16(1440),
    u32(0),
  ]);
  let checksum = 0;
  for (let i = 0; i < 20; i += 2) checksum ^= placeable.readUInt16LE(i);
  return Buffer.concat([placeable, u16(checksum), header, body]);
}

/** A rectangle: something for a plain metafile to draw. */
export const WMF_RECTANGLE = wmfRecord(
  0x041b,
  Buffer.concat([u16(100), u16(200), u16(10), u16(10)])
);
export const EMF_RECTANGLE = emfRecord(43, Buffer.concat([...[10, 10, 200, 100].map(i32)]));
