import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  canonicalizeIpAddress,
  classifyIpAddress,
  type IpAddressClass,
} from "../../../../plugins/pinchy-web/ip-address";

// `reference/network-address-checks.mdx` is the one page that lists every range
// the shared address table treats specially; the guides link to it instead of
// keeping lists of their own. A hand-written list that mirrors code drifts (see
// AGENTS.md), and these lists did: Teredo described as "wrapping" an address
// the classifier refuses outright, 192.0.0.0/24 called a test range, fec0::/10
// missing from every private-range list. So both directions are checked:
//
//   page → classifier  every documented range is treated the way the page says,
//                      at both ends of the range;
//   classifier → page  every range and exact address the classifier names in
//                      its source appears on the page.

const repoRoot = resolve(__dirname, "../../../../..");
const page = readFileSync(
  resolve(repoRoot, "docs/src/content/docs/reference/network-address-checks.mdx"),
  "utf-8"
);
const classifierSource = readFileSync(
  resolve(repoRoot, "packages/plugins/pinchy-web/ip-address.ts"),
  "utf-8"
);

const REFUSED: ReadonlySet<IpAddressClass> = new Set([
  "loopback",
  "unspecified",
  "link-local",
  "reserved",
]);

type Treatment = "private" | "refused" | "wrapped";

interface Entry {
  network: bigint;
  prefix: number;
  v6: boolean;
  token: string;
}

function parseEntry(token: string): Entry {
  const [address, prefixText] = token.split("/");
  const canonical = canonicalizeIpAddress(address);
  if (!canonical) throw new Error(`not an IP address or range: ${token}`);
  const v6 = canonical.includes(":");
  const bits = v6 ? 128 : 32;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`bad prefix length in ${token}`);
  }
  const value = v6
    ? canonical
        .split(":")
        .reduce((acc, group) => (acc << BigInt(16)) | BigInt(parseInt(group, 16)), BigInt(0))
    : canonical
        .split(".")
        .reduce((acc, octet) => (acc << BigInt(8)) | BigInt(Number(octet)), BigInt(0));
  const hostBits = BigInt(bits - prefix);
  return { network: (value >> hostBits) << hostBits, prefix, v6, token };
}

function format(value: bigint, v6: boolean): string {
  if (!v6)
    return [BigInt(24), BigInt(16), BigInt(8), BigInt(0)]
      .map((shift) => String((value >> shift) & BigInt(0xff)))
      .join(".");
  return Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt(112 - 16 * i)) & BigInt(0xffff)).toString(16)
  ).join(":");
}

function lastAddress(entry: Entry): bigint {
  const hostBits = BigInt((entry.v6 ? 128 : 32) - entry.prefix);
  return entry.network | ((BigInt(1) << hostBits) - BigInt(1));
}

function key(entry: Entry): string {
  return `${format(entry.network, entry.v6)}/${entry.prefix}`;
}

function treatmentOf(cell: string): Treatment {
  const text = cell.trim().toLowerCase();
  if (text.startsWith("private")) return "private";
  if (text.startsWith("always refused")) return "refused";
  if (text.startsWith("the ipv4 address inside")) return "wrapped";
  throw new Error(`unknown treatment "${cell.trim()}" — the guard cannot read this row`);
}

/** Every table row on the page whose first cell names an address or range. */
function documentedRows(): Array<{ entries: Entry[]; treatment: Treatment; row: string }> {
  const rows: Array<{ entries: Entry[]; treatment: Treatment; row: string }> = [];
  for (const line of page.split("\n")) {
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 3) continue;
    const tokens = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (tokens.length === 0) continue; // a header row
    rows.push({
      entries: tokens.map(parseEntry),
      treatment: treatmentOf(cells[cells.length - 1]),
      row: line,
    });
  }
  return rows;
}

describe("reference/network-address-checks.mdx matches the shared address table", () => {
  const rows = documentedRows();

  it("finds a real table on the page", () => {
    expect(rows.length).toBeGreaterThan(15);
  });

  it("treats every documented range the way the page says, at both ends", () => {
    const wrong: string[] = [];
    for (const { entries, treatment, row } of rows) {
      for (const entry of entries) {
        if (treatment === "wrapped") {
          // The classifier must read the IPv4 address out of the wrapper, so the
          // wrapper takes on that address's class. The IPv4 address sits right
          // after the prefix: bits 96–127 for the /96 forms, 16–47 for 6to4.
          const shift = BigInt(128 - entry.prefix - 32);
          for (const [v4, expected] of [
            ["10.0.0.1", "private"],
            ["127.0.0.1", "loopback"],
            ["93.184.216.34", "public"],
          ] as const) {
            const embedded = entry.network | (parseEntry(v4).network << shift);
            const actual = classifyIpAddress(format(embedded, true));
            if (actual !== expected) {
              wrong.push(`${entry.token} wrapping ${v4}: ${actual}, expected ${expected} — ${row}`);
            }
          }
          continue;
        }
        for (const probe of [entry.network, lastAddress(entry)]) {
          const address = format(probe, entry.v6);
          const actual = classifyIpAddress(address);
          const ok =
            treatment === "private" ? actual === "private" : actual !== null && REFUSED.has(actual);
          if (!ok) wrong.push(`${entry.token} (${address}): ${actual}, page says ${treatment}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  // Ranges the classifier's source names only to say they are NOT special.
  const SOURCE_MENTIONS_NOT_LISTED: Record<string, string> = {
    "2001::/16": "named only to say the rest of 2001::/16 outside Teredo is ordinary public space",
  };

  it("lists every range and exact address the classifier names", () => {
    const ranges = [
      ...classifierSource.matchAll(
        /(?<![\w:.])((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}|\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,3})(?!\w)/gi
      ),
    ].map((m) => m[0]);
    const exactV4 = [...classifierSource.matchAll(/^\s*\/\/ (\d{1,3}(?:\.\d{1,3}){3}) —/gm)].map(
      (m) => m[1]
    );
    const metadataBlock = classifierSource.split("IPV6_METADATA_ADDRESSES")[1]?.split("].map")[0];
    if (!metadataBlock) throw new Error("ip-address.ts: IPV6_METADATA_ADDRESSES not found");
    const exactV6 = [...metadataBlock.matchAll(/"([0-9a-f:.]+)"/g)].map((m) => m[1]);

    // A walker that finds next to nothing would pass in silence.
    expect(ranges.length).toBeGreaterThan(20);
    expect(exactV4.length).toBeGreaterThanOrEqual(2);
    expect(exactV6.length).toBeGreaterThanOrEqual(4);

    for (const exempt of Object.keys(SOURCE_MENTIONS_NOT_LISTED)) {
      expect(ranges, `stale exemption ${exempt}`).toContain(exempt);
    }

    const documented = new Set(rows.flatMap(({ entries }) => entries.map(key)));
    const missing = [...new Set([...ranges, ...exactV4, ...exactV6])]
      .filter((token) => !(token in SOURCE_MENTIONS_NOT_LISTED))
      .filter((token) => !documented.has(key(parseEntry(token))));
    expect(missing).toEqual([]);
  });
});
