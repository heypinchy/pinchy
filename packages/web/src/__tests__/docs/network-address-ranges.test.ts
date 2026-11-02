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
//   classifier → page  every address the classifier does NOT call public lies
//                      in a documented row that says so.
//
// The second direction asks the classifier, not its source. It used to read
// `x/len` literals and `// a.b.c.d —` comments out of ip-address.ts, which
// missed every rule written without one — NAT64's `64:ff9b::a.b.c.d`, the `::`
// and `::1` checks — so deleting those rows from the page stayed green.

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

  // `::` and `::1` sit inside `::/96`, but IPv6 defines them in their own right
  // (RFC 4291 §2.5.2–2.5.3): they are not IPv4-compatible spellings of 0.0.0.0
  // and 0.0.0.1, and the classifier names them before it unwraps anything. So
  // the `::/96` row does not cover them; they need rows of their own.
  const NOT_WRAPPED = new Set(["::", "::1"].map((a) => parseEntry(a).network));

  function contains(entry: Entry, value: bigint, v6: boolean): boolean {
    return entry.v6 === v6 && value >= entry.network && value <= lastAddress(entry);
  }

  /** The IPv4 address a wrapped-form entry carries in `value`. */
  function embeddedIn(entry: Entry, value: bigint): string {
    const shift = BigInt(128 - entry.prefix - 32);
    return format((value >> shift) & BigInt(0xffffffff), false);
  }

  function isCovered(value: bigint, v6: boolean, verdict: IpAddressClass): boolean {
    const treatment: Treatment = verdict === "private" ? "private" : "refused";
    return rows.some(({ entries, treatment: documented }) =>
      entries.some((entry) => {
        if (!contains(entry, value, v6)) return false;
        if (documented !== "wrapped") return documented === treatment;
        return !NOT_WRAPPED.has(value) && classifyIpAddress(embeddedIn(entry, value)) === verdict;
      })
    );
  }

  /** The probe set: addresses to ask the classifier about, as [value, v6]. */
  function probes(): Array<[bigint, boolean]> {
    const out: Array<[bigint, boolean]> = [];
    const add = (address: string) => {
      const { network, v6 } = parseEntry(address);
      out.push([network, v6]);
    };
    const edges = (entry: Entry) => {
      const max = (BigInt(1) << BigInt(entry.v6 ? 128 : 32)) - BigInt(1);
      const last = lastAddress(entry);
      for (const value of [
        entry.network - BigInt(1),
        entry.network,
        entry.network + BigInt(1),
        last - BigInt(1),
        last,
        last + BigInt(1),
      ]) {
        if (value >= BigInt(0) && value <= max) out.push([value, entry.v6]);
      }
    };

    // Both ends of every documented row, and one step past them.
    for (const { entries } of rows) entries.forEach(edges);

    // Both ends of every range and address the classifier's source spells out,
    // so a rule the page documents too narrowly shows up at its far end. Only
    // a probe source: what the verdict is comes from the classifier.
    const sourceTokens = [
      ...[
        ...classifierSource.matchAll(
          /(?<![\w:.])((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}|\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,3})(?!\w)/gi
        ),
      ].map((m) => m[0]),
      ...[...classifierSource.matchAll(/"([0-9a-f]*:[0-9a-f:.]+)"/g)].map((m) => m[1]),
    ];
    // A walker that finds next to nothing would pass in silence.
    expect(sourceTokens.length).toBeGreaterThan(20);
    sourceTokens.map(parseEntry).forEach(edges);

    // Addresses that matter whether or not anything above reaches them.
    [
      "0.0.0.0",
      "127.0.0.1",
      "169.254.169.254",
      "100.100.100.200",
      "168.63.129.16",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "ff02::1",
      "fd00:ec2::254",
      "fd00:ec2::23",
      "fd20:ce::254",
      "fd00:c1::a9fe:a9fe",
    ].forEach(add);

    // Every IPv6 form that can carry an IPv4 address, wrapping one address of
    // each kind: private, loopback, metadata, public.
    for (const v4 of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "93.184.216.34"]) {
      const value = parseEntry(v4).network;
      const hex = `${(value >> BigInt(16)).toString(16)}:${(value & BigInt(0xffff)).toString(16)}`;
      [
        `::ffff:${v4}`,
        `::${v4}`,
        `::ffff:0:${v4}`,
        `64:ff9b::${v4}`,
        `64:ff9b:1::${v4}`,
        `2002:${hex}::1`,
        `2001:0:${hex}::1`,
        `fd00::${v4}`,
      ].forEach(add);
    }

    // A coarse sweep, so a rule nothing above names is still met: the first
    // and last address of every IPv4 /16, every value of the first IPv6 group,
    // and every value of the second behind the prefixes that wrap or refuse.
    // Coarse is the limit: a rule narrower than this (an IPv4 /17 or longer,
    // an IPv6 /17 or longer behind any other first group) that no literal in
    // the source names and no probe above reaches still escapes. Checked with
    // a canary — `if (groups[0] === 0x3fff && groups[1] === 0x12)` stays
    // green — so review owns that case.
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const base = BigInt((a << 24) >>> 0) | BigInt(b << 16);
        out.push([base, false], [base | BigInt(0xffff), false]);
      }
    }
    for (let g = 0; g < 0x10000; g++) {
      out.push([(BigInt(g) << BigInt(112)) | BigInt(1), true]);
      for (const g0 of [0x0, 0x64, 0x2001]) {
        out.push([(BigInt(g0) << BigInt(112)) | (BigInt(g) << BigInt(96)) | BigInt(1), true]);
      }
    }
    return out;
  }

  it("documents every address the classifier does not call public", () => {
    const undocumented = new Set<string>();
    for (const [value, v6] of probes()) {
      const address = format(value, v6);
      const verdict = classifyIpAddress(address);
      if (verdict === null) throw new Error(`probe ${address} is not an address`);
      if (verdict === "public") continue;
      if (!isCovered(value, v6, verdict)) undocumented.add(`${address}: ${verdict}`);
    }
    expect([...undocumented]).toEqual([]);
  });
});
