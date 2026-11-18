// @vitest-environment node
import { describe, it, expect } from "vitest";
import { canonicalizeIpAddress, classifyIpAddress } from "./ip-address.js";

describe("classifyIpAddress (the table web_fetch and the web app share)", () => {
  it.each([
    // Loopback / unspecified / link-local / private: the original set.
    ["127.0.0.1", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["169.254.169.254", "link-local"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.10", "private"],
    // CGNAT 100.64.0.0/10. Tailscale lives here, so it is "private" (an
    // operator can opt in for their own Odoo/mail host) -- except the one
    // address that is a cloud metadata service and never a real server.
    ["100.64.0.1", "private"],
    ["100.100.100.100", "private"],
    ["100.127.255.255", "private"],
    ["100.100.100.200", "link-local"],
    // Azure's WireServer / host agent (168.63.129.16). Public-looking,
    // Microsoft-owned, and reachable only from inside an Azure VM: it serves
    // DHCP, DNS, the health probe and the extension configuration --
    // certificates included. A metadata endpoint in all but name, so it gets
    // the class no opt-in opens. Only the one address: its neighbours are
    // ordinary public space.
    ["168.63.129.16", "link-local"],
    ["168.63.129.15", "public"],
    ["168.63.129.17", "public"],
    // 198.18.0.0/15 (RFC 2544 benchmarking). Used to be "reserved" -- blocked
    // with no opt-in -- but operators number internal lab/transit networks
    // from it and fake-IP DNS (Clash, Mihomo, Surge) hands it out for every
    // name, so on such a host an ordinary Odoo or mail server resolves here.
    // That is the profile of a private network, not of a never-a-server
    // range: corrected to "private", which web_fetch still blocks and the
    // admin opt-ins open.
    ["198.18.0.1", "private"],
    ["198.19.255.255", "private"],
    // Never a real server, whatever the operator opts into.
    ["192.0.0.1", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.51.100.7", "reserved"],
    ["203.0.113.9", "reserved"],
    ["224.0.0.1", "reserved"],
    ["239.255.255.250", "reserved"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.254", "reserved"],
    ["255.255.255.255", "reserved"],
    // Boundaries just outside each range, and ordinary public addresses.
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    ["172.32.0.1", "public"],
    ["198.17.255.255", "public"],
    ["198.20.0.1", "public"],
    ["192.0.1.1", "public"],
    ["192.0.3.1", "public"],
    ["223.255.255.255", "public"],
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
  ] as const)("classifies IPv4 %s as %s", (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
  });

  it.each([
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::", "unspecified"],
    // fe80::/10 spans fe80 through febf.
    ["fe80::1", "link-local"],
    ["fe90::1", "link-local"],
    ["feb0::1", "link-local"],
    ["febf:ffff::1", "link-local"],
    ["fc00::1", "private"],
    // fec0::/10 deprecated site-local: fec0 through feff.
    ["fec0::1", "private"],
    ["feff:ffff::1", "private"],
    ["fd12:3456:789a::1", "private"],
    // EC2's IPv6 instance-metadata endpoint sits inside fc00::/7, but it is a
    // metadata service, not a server -- like 100.100.100.200 inside CGNAT, it
    // must not open up when an operator opts into their private network.
    ["fd00:ec2::254", "link-local"],
    ["fd00:ec2:0:0:0:0:0:254", "link-local"],
    ["FD00:EC2::254", "link-local"],
    ["fd00:ec2::0.0.2.84", "link-local"],
    ["fd00:ec2::253", "private"],
    // The other cloud metadata / credential endpoints that live inside ULA,
    // each in every spelling an attacker can write: compressed, fully
    // expanded and zero-padded, upper case, and (where the tail reads as an
    // IPv4 address) the dotted-quad tail form. A neighbour of each stays
    // "private", so only the one address is carved out.
    //   EKS Pod Identity Agent (IPv6 twin of 169.254.170.23): hands out the
    //   pod's IAM credentials.
    ["fd00:ec2::23", "link-local"],
    ["fd00:0ec2:0000:0000:0000:0000:0000:0023", "link-local"],
    ["FD00:EC2::23", "link-local"],
    ["fd00:ec2::0.0.0.35", "link-local"],
    ["fd00:ec2::24", "private"],
    //   Google Cloud metadata server on IPv6 (metadata.google.internal).
    ["fd20:ce::254", "link-local"],
    ["fd20:00ce:0000:0000:0000:0000:0000:0254", "link-local"],
    ["FD20:CE::254", "link-local"],
    ["fd20:ce::0.0.2.84", "link-local"],
    ["fd20:ce::253", "private"],
    //   Oracle Cloud (OCI) instance metadata on IPv6 -- 169.254.169.254 in the
    //   low 32 bits, which is also how it is usually written.
    ["fd00:c1::a9fe:a9fe", "link-local"],
    ["fd00:00c1:0000:0000:0000:0000:a9fe:a9fe", "link-local"],
    ["FD00:C1::A9FE:A9FE", "link-local"],
    ["fd00:c1::169.254.169.254", "link-local"],
    ["fd00:c1::a9fe:a9ff", "private"],
    ["ff00::1", "reserved"],
    ["ff02::1", "reserved"],
    ["ffff::1", "reserved"],
    ["2001:db8::1", "reserved"],
    // Teredo 2001:0::/32 tunnels to an IPv4 address (obfuscated in the low
    // groups). Never a server of its own: refuse it rather than decode it.
    ["2001:0:a9fe:a9fe::1", "reserved"],
    ["2001::1", "reserved"],
    ["2001:0:ffff:ffff:ffff:ffff:ffff:ffff", "reserved"],
    // Only 2001:0000::/32 -- its neighbours are ordinary public space.
    ["2001:1::1", "public"],
    ["2606:4700:4700::1111", "public"],
    ["2001:4860:4860::8888", "public"],
    // IPv4-mapped, both spellings.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:100.64.0.1", "private"],
    ["::ffff:6464:64c8", "link-local"],
    ["::ffff:192.168.1.10", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["::ffff:168.63.129.16", "link-local"],
    ["::ffff:a83f:8110", "link-local"],
    ["::ffff:a83f:810f", "public"],
    // SIIT IPv4-translated (::ffff:0:0:0/96, RFC 2765): a stateless translator
    // forwards it to the embedded IPv4. Refused outright, never public.
    ["::ffff:0:7f00:1", "reserved"],
    ["::ffff:0:a9fe:a9fe", "reserved"],
    ["::ffff:0:808:808", "reserved"],
    // IPv4-compatible (deprecated).
    ["::127.0.0.1", "loopback"],
    ["::7f00:1", "loopback"],
    ["::100.100.100.200", "link-local"],
    ["::169.254.169.254", "link-local"],
    ["::168.63.129.16", "link-local"],
    // NAT64 64:ff9b::/96: classify the IPv4 it translates to.
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["64:ff9b::6464:64c8", "link-local"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::808:808", "public"],
    ["64:ff9b::a83f:8110", "link-local"],
    ["64:ff9b::168.63.129.16", "link-local"],
    ["64:ff9b::a83f:8111", "public"],
    // Local-use NAT64 64:ff9b:1::/48 (RFC 8215). Corrected expectation: this
    // was filed as `reserved` ("never a public destination"), but it is the
    // prefix an operator's own translator uses on an IPv6-only network, so a
    // host there can legitimately be your Odoo or mail server. The mapping is
    // operator-defined, so the embedded IPv4 cannot be read off — which makes it
    // `private`: the admin opt-ins open it, web_fetch still refuses it.
    ["64:ff9b:1::a00:1", "private"],
    ["64:ff9b:1::808:808", "private"],
    ["64:ff9b:1:ffff:ffff:ffff:ffff:ffff", "private"],
    // Just outside the /48 on either side: 64:ff9b:2:: and 64:ff9b:0:1:: are
    // neither NAT64 prefix, so ordinary (public) IPv6 space.
    ["64:ff9b:2::1", "public"],
    ["64:ff9b:0:1::1", "public"],
    // 6to4 (2002::/16) embeds the IPv4 in groups 1-2.
    ["2002:7f00:1::1", "loopback"],
    ["2002:a9fe:a9fe::1", "link-local"],
    ["2002:808:808::1", "public"],
    ["2002:a83f:8110::1", "link-local"],
    ["2002:a83f:810f::1", "public"],
  ] as const)("classifies IPv6 %s as %s", (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
  });

  it("strips brackets and zone identifiers", () => {
    expect(classifyIpAddress("[fe80::1]")).toBe("link-local");
    expect(classifyIpAddress("fe80::1%eth0")).toBe("link-local");
    expect(classifyIpAddress("[::ffff:100.64.0.1]")).toBe("private");
    // The bracketed form is how every metadata address arrives from `URL`.
    expect(classifyIpAddress("[fd00:ec2::254]")).toBe("link-local");
    expect(classifyIpAddress("[fd00:ec2::23]")).toBe("link-local");
    expect(classifyIpAddress("[fd20:ce::254]")).toBe("link-local");
    expect(classifyIpAddress("[fd00:c1::a9fe:a9fe]")).toBe("link-local");
  });

  it.each([
    ["imap.example.com"],
    ["localhost"],
    [""],
    ["999.1.1.1"],
    ["1.2.3"],
    ["not:an:address"],
  ])("returns null for %s, which is not an IP literal", (value) => {
    expect(classifyIpAddress(value)).toBeNull();
  });
});

describe("canonicalizeIpAddress", () => {
  it("keeps IPv4 dotted-quad and expands IPv6 to eight padded groups", () => {
    expect(canonicalizeIpAddress("10.0.0.1")).toBe("10.0.0.1");
    expect(canonicalizeIpAddress("fd00:ec2::254")).toBe("fd00:0ec2:0000:0000:0000:0000:0000:0254");
    expect(canonicalizeIpAddress("nope")).toBeNull();
  });
});
