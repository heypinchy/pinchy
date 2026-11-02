import { describe, it, expect, vi, afterEach } from "vitest";
import { assertMailHostAllowed, MailHostBlockedError } from "../mail-host-guard";

// Every test injects its own resolver, so no test in this file ever touches
// real DNS — the guard's decision table is what's under test, not getaddrinfo.
function resolvesTo(...addresses: string[]) {
  return async () => addresses;
}

describe("assertMailHostAllowed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("always blocked, regardless of ALLOW_PRIVATE_MAIL_HOSTS", () => {
    const alwaysBlocked: Array<[string, string]> = [
      ["IPv4 loopback", "127.0.0.1"],
      ["IPv4 loopback, non-canonical", "127.99.42.7"],
      ["IPv4 unspecified", "0.0.0.0"],
      ["IPv6 loopback", "::1"],
      ["IPv6 unspecified", "::"],
      ["IPv4 link-local", "169.254.1.1"],
      ["AWS/GCP/Azure IMDS", "169.254.169.254"],
      ["IPv6 IMDS", "fd00:ec2::254"],
      ["IPv6 IMDS, expanded", "fd00:ec2:0:0:0:0:0:254"],
      ["EKS Pod Identity Agent, IPv6", "fd00:ec2::23"],
      ["GCP metadata, IPv6", "fd20:ce::254"],
      ["GCP metadata, IPv6 expanded", "fd20:00ce:0000:0000:0000:0000:0000:0254"],
      ["OCI metadata, IPv6", "fd00:c1::a9fe:a9fe"],
      ["OCI metadata, IPv6 with dotted tail", "fd00:c1::169.254.169.254"],
      ["IPv6 link-local", "fe80::1"],
      ["IPv6 link-local, upper half of fe80::/10", "feb0::1"],
      ["IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1"],
      ["IPv4-compatible IPv6 loopback", "::7f00:1"],
      ["Alibaba Cloud metadata", "100.100.100.200"],
      ["IPv4-mapped Alibaba Cloud metadata", "::ffff:100.100.100.200"],
      ["Azure WireServer", "168.63.129.16"],
      ["IPv4-mapped Azure WireServer", "::ffff:168.63.129.16"],
      ["NAT64-wrapped IMDS", "64:ff9b::a9fe:a9fe"],
      ["TEST-NET-3", "203.0.113.50"],
      ["reserved 240.0.0.0/4", "240.0.0.1"],
      ["IPv4 multicast", "224.0.0.1"],
      ["limited broadcast", "255.255.255.255"],
      ["IPv6 multicast", "ff02::1"],
      // `ollama.local` on OrbStack: its `host-gateway` answer sits inside
      // 0.0.0.0/8, so a mail host pointed at the Docker host that way is refused
      // whatever is set. (Docker on Linux answers 172.17.0.1 — private, below.)
      ["OrbStack host-gateway (ollama.local)", "0.250.250.254"],
    ];

    it.each(alwaysBlocked)("blocks a host resolving to %s (%s)", async (_label, address) => {
      await expect(assertMailHostAllowed("mail.evil.test", resolvesTo(address))).rejects.toThrow(
        MailHostBlockedError
      );
    });

    it.each(alwaysBlocked)(
      "still blocks %s (%s) with ALLOW_PRIVATE_MAIL_HOSTS=1",
      async (_label, address) => {
        vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "1");

        await expect(assertMailHostAllowed("mail.evil.test", resolvesTo(address))).rejects.toThrow(
          MailHostBlockedError
        );
      }
    );

    it("does not name the escape hatch for an always-blocked address", async () => {
      // The flag genuinely does not help here — advertising it would send an
      // admin chasing a config change that cannot fix their problem.
      const error = await assertMailHostAllowed("mail.evil.test", resolvesTo("127.0.0.1")).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(MailHostBlockedError);
      expect((error as Error).message).not.toContain("ALLOW_PRIVATE_MAIL_HOSTS");
    });
  });

  describe("private ranges, gated behind ALLOW_PRIVATE_MAIL_HOSTS", () => {
    const privateAddresses: Array<[string, string]> = [
      ["10.0.0.0/8", "10.1.2.3"],
      ["172.16.0.0/12 lower bound", "172.16.0.1"],
      ["172.16.0.0/12 upper bound", "172.31.255.255"],
      ["192.168.0.0/16", "192.168.1.10"],
      ["IPv6 unique-local", "fd12:3456:789a::1"],
      // CGNAT is where Tailscale puts every node: an on-premise mail server
      // reached over a tailnet is a legitimate deployment, so it is opt-in
      // like RFC-1918 rather than blocked outright.
      ["CGNAT 100.64.0.0/10 (Tailscale)", "100.64.0.1"],
      ["IPv4-mapped CGNAT", "::ffff:100.64.0.1"],
      // 198.18.0.0/15 (benchmarking) moved here from the always-blocked list:
      // operators number internal networks from it and fake-IP DNS
      // (Clash/Mihomo/Surge) answers with it, so an on-premise mail server
      // can genuinely resolve there.
      ["benchmarking 198.18.0.0/15", "198.18.0.1"],
      ["benchmarking 198.18.0.0/15, top", "198.19.255.254"],
      // Local-use NAT64 (RFC 8215): an IPv6-only network's own translator, so
      // the mail server behind it is an ordinary internal host.
      ["local-use NAT64 64:ff9b:1::/48", "64:ff9b:1::a00:5"],
      // `ollama.local` as Docker on Linux answers it through the compose
      // `host-gateway` mapping, which Pinchy now carries like OpenClaw does.
      ["Linux host-gateway (ollama.local)", "172.17.0.1"],
    ];

    it.each(privateAddresses)("blocks %s (%s) by default", async (_label, address) => {
      await expect(
        assertMailHostAllowed("mail.internal.test", resolvesTo(address))
      ).rejects.toThrow(MailHostBlockedError);
    });

    it.each(privateAddresses)(
      "allows %s (%s) when ALLOW_PRIVATE_MAIL_HOSTS=1",
      async (_label, address) => {
        vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "1");

        await expect(
          assertMailHostAllowed("mail.internal.test", resolvesTo(address))
        ).resolves.toBeUndefined();
      }
    );

    it("names the escape hatch so an on-premise admin knows the fix", async () => {
      await expect(
        assertMailHostAllowed("mail.internal.test", resolvesTo("192.168.1.10"))
      ).rejects.toThrow(/ALLOW_PRIVATE_MAIL_HOSTS/);
    });
  });

  describe("public hosts", () => {
    it.each([
      ["IPv4", "93.184.216.34"],
      ["IPv4 just outside 172.16.0.0/12", "172.32.0.1"],
      ["IPv6", "2606:4700:4700::1111"],
    ])("allows a host resolving to a public %s (%s)", async (_label, address) => {
      await expect(
        assertMailHostAllowed("imap.example.com", resolvesTo(address))
      ).resolves.toBeUndefined();
    });
  });

  describe("multi-address hosts", () => {
    it("blocks when ANY resolved address is internal", async () => {
      // A split-horizon or attacker-controlled zone can answer with a public
      // address alongside an internal one; the connect() picks whichever the
      // OS prefers, so one bad answer has to fail the whole host.
      await expect(
        assertMailHostAllowed("mail.evil.test", resolvesTo("93.184.216.34", "127.0.0.1"))
      ).rejects.toThrow(MailHostBlockedError);
    });

    it("allows when every resolved address is public", async () => {
      await expect(
        assertMailHostAllowed("imap.example.com", resolvesTo("93.184.216.34", "8.8.8.8"))
      ).resolves.toBeUndefined();
    });
  });

  describe("resolution failures", () => {
    it("allows the probe to proceed when the host does not resolve", async () => {
      // No address means no connection, so there is no oracle to protect
      // against — and letting the probe run keeps the far more common typo
      // case reporting "could not resolve the host" instead of a security
      // error the admin cannot act on.
      const failing = async () => {
        throw new Error("getaddrinfo ENOTFOUND imap.example.com");
      };

      await expect(assertMailHostAllowed("imap.example.com", failing)).resolves.toBeUndefined();
    });

    it("allows the probe to proceed when the resolver returns no addresses", async () => {
      await expect(
        assertMailHostAllowed("imap.example.com", resolvesTo())
      ).resolves.toBeUndefined();
    });
  });

  describe("host input handling", () => {
    it("rejects an empty host without resolving", async () => {
      const resolver = vi.fn(resolvesTo("93.184.216.34"));

      await expect(assertMailHostAllowed("   ", resolver)).rejects.toThrow(MailHostBlockedError);
      expect(resolver).not.toHaveBeenCalled();
    });

    it("strips brackets from an IPv6 literal before resolving", async () => {
      const resolver = vi.fn(resolvesTo("2606:4700:4700::1111"));

      await assertMailHostAllowed("[2606:4700:4700::1111]", resolver);

      expect(resolver).toHaveBeenCalledWith("2606:4700:4700::1111");
    });

    it("blocks a bracketed IPv6 loopback literal", async () => {
      await expect(assertMailHostAllowed("[::1]", resolvesTo("::1"))).rejects.toThrow(
        MailHostBlockedError
      );
    });
  });
});
