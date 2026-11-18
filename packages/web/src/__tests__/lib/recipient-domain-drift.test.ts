/**
 * Drift guard for "is this a domain name".
 *
 * Two places answer it: pinchy-email refuses a recipient whose domain Node's
 * `domainToASCII` rejects, and the approval summary notes such a domain as
 * "not a valid domain name" and names it as written, because it has no
 * resolved form. Plugins cannot import the web package, so each asks Node on
 * its own; this pins the two answers together, so a recipient the mail tool
 * accepts always has a host the card and the prompt name, and one the card
 * cannot resolve never reaches a mail library.
 */
import { describe, it, expect } from "vitest";
import { summarizeCall } from "@/lib/approvals/summary";
import { readNode } from "@/lib/approvals/display";
import { parseSingleRecipient } from "../../../../plugins/pinchy-email/recipient";

const DOMAINS = [
  "firma.at",
  "FIRMA.AT",
  "fіrma.at",
  "xn--frma-l9d.at",
  "bücher.de",
  "straße.de",
  "xn--zca.at",
  "a_b.at",
  "-a.at",
  "a-.at",
  "1.2.3.4",
  "١.at",
  "aא.at",
  "אב.co.il",
  "xn--",
  "xn--a",
  "xn---",
  "xn--ab-cd",
  "XN--A",
  "Xn--a",
  "xn--a.evil.com",
  "firma.at.xn--ab-cd.evil.com",
];

/** Does the card say the recipient's domain is no domain name? */
function notADomain(to: unknown): boolean {
  const node = readNode(to);
  if (node === null || node === "unreadable" || node["@"] !== "noted") return false;
  return node.notes.some((note) => note.kind === "not-a-domain");
}

describe("recipient domain drift guard", () => {
  it.each(DOMAINS)("the mail tool and the card agree on %j", (domain) => {
    const to = `boss@${domain}`;
    const { summary, hosts } = summarizeCall({ to });
    expect(parseSingleRecipient(to).ok).toBe(!notADomain(summary.to));
    expect(hosts).toHaveLength(1);
  });

  it("covers both answers", () => {
    const refused = DOMAINS.filter((domain) => !parseSingleRecipient(`boss@${domain}`).ok);
    expect(refused.length).toBeGreaterThan(5);
    expect(refused.length).toBeLessThan(DOMAINS.length - 5);
  });
});
