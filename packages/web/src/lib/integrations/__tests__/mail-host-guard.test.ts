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
      ["IPv6 link-local", "fe80::1"],
      ["IPv6 link-local, upper half of fe80::/10", "feb0::1"],
      ["IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1"],
      ["IPv4-compatible IPv6 loopback", "::7f00:1"],
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
      ["IPv4", "203.0.113.50"],
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
        assertMailHostAllowed("mail.evil.test", resolvesTo("203.0.113.50", "127.0.0.1"))
      ).rejects.toThrow(MailHostBlockedError);
    });

    it("allows when every resolved address is public", async () => {
      await expect(
        assertMailHostAllowed("imap.example.com", resolvesTo("203.0.113.50", "198.51.100.7"))
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
      const resolver = vi.fn(resolvesTo("203.0.113.50"));

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
