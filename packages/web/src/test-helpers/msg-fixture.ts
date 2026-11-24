/**
 * A minimal Outlook `.msg` file, built byte by byte for tests (#1409).
 *
 * Built with `cfb` — an independent Compound File writer — rather than with the
 * parser's own writer, so a fixture and the reader that reads it cannot share
 * a misunderstanding of the format. Only the properties the knowledge base
 * reads are written: subject, body (plain or HTML), sender, recipients with
 * their type, the delivery time, and attachments with a file name.
 *
 * Property streams follow [MS-OXMSG]: `__substg1.0_<tag><type>` for strings
 * (type 001F, UTF-16LE) and binaries (0102), fixed-size values in
 * `__properties_version1.0` as 16-byte rows after a header that is 32 bytes at
 * the top level and 8 bytes inside a recipient or attachment storage.
 */
import CFB from "cfb";

export interface MsgFixture {
  subject?: string;
  body?: string;
  /** Written as PidTagHtml (binary) when `body` is absent and this is set. */
  html?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: { name: string; email: string; type: "to" | "cc" | "bcc" }[];
  delivered?: Date;
  attachments?: { name: string; data: Buffer; hidden?: boolean }[];
}

const utf16 = (s: string) => Buffer.from(s, "utf16le");

/** 100-ns ticks since 1601-01-01, the FILETIME every MAPI time property uses. */
function filetime(d: Date): bigint {
  return BigInt(d.getTime()) * BigInt(10000) + BigInt("116444736000000000");
}

type FixedProp = { tag: number; int32?: number; int64?: bigint };

function propertyStream(header: Buffer, props: FixedProp[]): Buffer {
  const rows = props.map((p) => {
    const row = Buffer.alloc(16);
    row.writeUInt32LE(p.tag >>> 0, 0);
    row.writeUInt32LE(0x6, 4); // readable | writable
    if (p.int64 !== undefined) row.writeBigUInt64LE(p.int64, 8);
    else row.writeInt32LE(p.int32 ?? 0, 8);
    return row;
  });
  return Buffer.concat([header, ...rows]);
}

const RECIP_TYPE = { to: 1, cc: 2, bcc: 3 } as const;

export function buildMsg(fixture: MsgFixture): Buffer {
  const cfb = CFB.utils.cfb_new();
  const add = (path: string, content: Buffer) => CFB.utils.cfb_add(cfb, path, content);

  if (fixture.subject !== undefined) add("/__substg1.0_0037001F", utf16(fixture.subject));
  if (fixture.body !== undefined) add("/__substg1.0_1000001F", utf16(fixture.body));
  else if (fixture.html !== undefined) add("/__substg1.0_10130102", Buffer.from(fixture.html));
  if (fixture.senderName !== undefined) add("/__substg1.0_0C1A001F", utf16(fixture.senderName));
  if (fixture.senderEmail !== undefined) {
    add("/__substg1.0_0C1F001F", utf16(fixture.senderEmail));
    add("/__substg1.0_5D01001F", utf16(fixture.senderEmail));
  }

  const recipients = fixture.recipients ?? [];
  const attachments = fixture.attachments ?? [];

  const top = Buffer.alloc(32);
  top.writeUInt32LE(recipients.length, 8);
  top.writeUInt32LE(attachments.length, 12);
  top.writeUInt32LE(recipients.length, 16);
  top.writeUInt32LE(attachments.length, 20);
  const topProps: FixedProp[] = [];
  if (fixture.delivered) topProps.push({ tag: 0x0e060040, int64: filetime(fixture.delivered) });
  add("/__properties_version1.0", propertyStream(top, topProps));

  recipients.forEach((r, i) => {
    const dir = `/__recip_version1.0_#${i.toString(16).toUpperCase().padStart(8, "0")}`;
    add(`${dir}/__substg1.0_3001001F`, utf16(r.name));
    add(`${dir}/__substg1.0_3003001F`, utf16(r.email));
    add(`${dir}/__substg1.0_39FE001F`, utf16(r.email));
    add(
      `${dir}/__properties_version1.0`,
      propertyStream(Buffer.alloc(8), [{ tag: 0x0c150003, int32: RECIP_TYPE[r.type] }])
    );
  });

  attachments.forEach((a, i) => {
    const dir = `/__attach_version1.0_#${i.toString(16).toUpperCase().padStart(8, "0")}`;
    add(`${dir}/__substg1.0_3707001F`, utf16(a.name));
    add(`${dir}/__substg1.0_37010102`, a.data);
    const props: FixedProp[] = [{ tag: 0x37050003, int32: 1 }]; // ATTACH_BY_VALUE
    if (a.hidden) props.push({ tag: 0x7ffe000b, int32: 1 }); // PidTagAttachmentHidden
    add(`${dir}/__properties_version1.0`, propertyStream(Buffer.alloc(8), props));
  });

  // cfb_new seeds a placeholder stream; a real .msg has none.
  CFB.utils.cfb_del(cfb, "/\u0001Sh33tJ5");
  return CFB.write(cfb, { type: "buffer" }) as Buffer;
}
