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
    // Never a real server, whatever the operator opts into.
    ["198.18.0.1", "reserved"],
    ["198.19.255.255", "reserved"],
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
    ["fd00:ec2::253", "private"],
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
    // NAT64 64:ff9b::/96: classify the IPv4 it translates to.
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["64:ff9b::6464:64c8", "link-local"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::808:808", "public"],
    // 6to4 (2002::/16) embeds the IPv4 in groups 1-2.
    ["2002:7f00:1::1", "loopback"],
    ["2002:a9fe:a9fe::1", "link-local"],
    ["2002:808:808::1", "public"],
  ] as const)("classifies IPv6 %s as %s", (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
  });

  it("strips brackets and zone identifiers", () => {
    expect(classifyIpAddress("[fe80::1]")).toBe("link-local");
    expect(classifyIpAddress("fe80::1%eth0")).toBe("link-local");
    expect(classifyIpAddress("[::ffff:100.64.0.1]")).toBe("private");
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
