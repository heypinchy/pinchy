// @vitest-environment node
/**
 * DNS rebinding against pinchy-email, end to end through the real imapflow
 * and nodemailer.
 *
 * Pinchy checked `imap.rebind.test` / `smtp.rebind.test` and saw a public
 * address — here played by 127.0.0.1, where a fake mail server listens. When
 * the plugin connects, the name resolves again and a rebinding resolver now
 * answers a private address. The connection must still reach the address
 * Pinchy checked, and the TLS handshake must still name the host (SNI), so
 * the certificate is checked against what the admin typed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { ImapAdapter } from "../imap-adapter";
import type { PinnedTarget } from "../pinned-target";

const dns = createRequire(import.meta.url)("node:dns") as typeof import("node:dns");

interface Seen {
  remoteAddress: string | undefined;
  /** The first bytes after STARTTLS — the TLS ClientHello, SNI in clear. */
  clientHello: Buffer;
}

/**
 * A fake IMAP or SMTP server that offers STARTTLS and records the ClientHello
 * the client sends after it. It never completes the handshake: the test is
 * about where the client connected and which name it asked for, not about
 * finishing a mail session, so the adapter call itself is expected to fail.
 */
function fakeMailServer(protocol: "imap" | "smtp") {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const entry: Seen = { remoteAddress: socket.remoteAddress, clientHello: Buffer.alloc(0) };
    seen.push(entry);
    let tls = false;
    let buffered = "";
    socket.on("error", () => {});
    socket.write(
      protocol === "imap"
        ? "* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready\r\n"
        : "220 fake.smtp ESMTP\r\n"
    );
    socket.on("data", (chunk: Buffer) => {
      if (tls) {
        entry.clientHello = Buffer.concat([entry.clientHello, chunk]);
        if (entry.clientHello.length > 64) socket.destroy();
        return;
      }
      buffered += chunk.toString("latin1");
      let nl: number;
      while ((nl = buffered.indexOf("\r\n")) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 2);
        if (protocol === "imap") {
          const [tag, command = ""] = line.split(" ");
          if (command.toUpperCase() === "STARTTLS") {
            tls = true;
            socket.write(`${tag} OK go\r\n`);
          } else if (command.toUpperCase() === "CAPABILITY") {
            socket.write(`* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n${tag} OK\r\n`);
          } else {
            socket.write(`${tag} BAD\r\n`);
          }
        } else {
          const verb = line.split(" ")[0].toUpperCase();
          if (verb === "EHLO") socket.write("250-fake.smtp\r\n250 STARTTLS\r\n");
          else if (verb === "STARTTLS") {
            tls = true;
            socket.write("220 go\r\n");
          } else socket.write("500 no\r\n");
        }
      }
    });
  });
  return { server, seen, sockets };
}

/** The second resolution — the plugin's own — answers a private address. */
function rebindResolverToPrivate() {
  const rebound = vi.fn((_host: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error | null,
      address: unknown,
      family?: number
    ) => void;
    const all = typeof options === "object" && options !== null && "all" in options;
    if (all) cb(null, [{ address: "10.66.66.66", family: 4 }]);
    else cb(null, "10.66.66.66", 4);
  });
  vi.spyOn(dns, "lookup").mockImplementation(rebound as never);
  vi.spyOn(dns.promises, "lookup").mockResolvedValue([
    { address: "10.66.66.66", family: 4 },
  ] as never);
  // nodemailer resolves with resolve4/resolve6 before it falls back to lookup.
  vi.spyOn(dns, "resolve4").mockImplementation(((_h: string, ...rest: unknown[]) =>
    (rest[rest.length - 1] as (e: null, a: string[]) => void)(null, ["10.66.66.66"])) as never);
  vi.spyOn(dns.Resolver.prototype, "resolve4").mockImplementation(((
    _h: string,
    ...rest: unknown[]
  ) => (rest[rest.length - 1] as (e: null, a: string[]) => void)(null, ["10.66.66.66"])) as never);
  return rebound;
}

const checked: PinnedTarget = [{ address: "127.0.0.1", family: 4 }];
const v6First: PinnedTarget = [
  { address: "::1", family: 6 },
  { address: "127.0.0.1", family: 4 },
];

let fake: ReturnType<typeof fakeMailServer>;
let port: number;

async function listen(protocol: "imap" | "smtp") {
  fake = fakeMailServer(protocol);
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  port = (fake.server.address() as AddressInfo).port;
}

beforeEach(() => {
  delete process.env.IMAP_MOCK_HOST;
  delete process.env.SMTP_MOCK_HOST;
  delete process.env.PINCHY_INSECURE_MAIL_MOCK;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A client still in session (the mock-seam case never upgrades) would hold
  // close() open until its socket timeout.
  for (const socket of fake.sockets) socket.destroy();
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

function adapter(overrides: Partial<ConstructorParameters<typeof ImapAdapter>[0]> = {}) {
  return new ImapAdapter({
    imapHost: "imap.rebind.test",
    imapPort: port,
    smtpHost: "smtp.rebind.test",
    smtpPort: port,
    username: "agent@rebind.test",
    password: "secret",
    security: "starttls",
    imapTarget: checked,
    smtpTarget: checked,
    ...overrides,
  });
}

async function waitForClientHello() {
  await vi.waitFor(() => expect(fake.seen[0]?.clientHello.length ?? 0).toBeGreaterThan(0), {
    timeout: 5_000,
  });
}

describe("IMAP connection pinning", () => {
  it("connects to the address Pinchy checked, and still names the host in TLS", async () => {
    await listen("imap");
    const rebound = rebindResolverToPrivate();

    await adapter()
      .list({ folder: "INBOX" })
      .catch(() => undefined);
    await waitForClientHello();

    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0].remoteAddress).toBe("127.0.0.1");
    expect(fake.seen[0].clientHello.includes("imap.rebind.test")).toBe(true);
    expect(rebound).not.toHaveBeenCalled();
  });

  it("falls back to the next checked address when the first refuses", async () => {
    await listen("imap");
    rebindResolverToPrivate();

    await adapter({ imapTarget: v6First })
      .list({ folder: "INBOX" })
      .catch(() => undefined);
    await waitForClientHello();

    expect(fake.seen[0].remoteAddress).toBe("127.0.0.1");
  });

  it("refuses to connect when Pinchy checked no address for the host", async () => {
    await listen("imap");
    await expect(adapter({ imapTarget: undefined }).list({ folder: "INBOX" })).rejects.toThrow(
      /could not check where/
    );
    expect(fake.seen).toHaveLength(0);
  });
});

describe("SMTP connection pinning", () => {
  it("connects to the address Pinchy checked, and still names the host in TLS", async () => {
    await listen("smtp");
    const rebound = rebindResolverToPrivate();

    await adapter()
      .send({ to: "someone@example.com", subject: "s", body: "b" })
      .catch(() => undefined);
    await waitForClientHello();

    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0].remoteAddress).toBe("127.0.0.1");
    expect(fake.seen[0].clientHello.includes("smtp.rebind.test")).toBe(true);
    expect(rebound).not.toHaveBeenCalled();
  });

  it("falls back to the next checked address when the first refuses", async () => {
    await listen("smtp");
    rebindResolverToPrivate();

    await adapter({ smtpTarget: v6First })
      .send({ to: "someone@example.com", subject: "s", body: "b" })
      .catch(() => undefined);
    await waitForClientHello();

    expect(fake.seen[0].remoteAddress).toBe("127.0.0.1");
  });

  it("refuses to connect when Pinchy checked no address for the host", async () => {
    await listen("smtp");
    await expect(
      adapter({ smtpTarget: undefined }).send({
        to: "someone@example.com",
        subject: "s",
        body: "b",
      })
    ).rejects.toThrow(/could not check where/);
    expect(fake.seen).toHaveLength(0);
  });
});

describe("the mail-mock seam", () => {
  it("connects to the mock host unpinned — the stored host is not where it goes", async () => {
    await listen("imap");
    process.env.IMAP_MOCK_HOST = "127.0.0.1";
    process.env.IMAP_MOCK_PORT = String(port);
    process.env.PINCHY_INSECURE_MAIL_MOCK = "1";
    try {
      await adapter({ imapTarget: undefined })
        .list({ folder: "INBOX" })
        .catch(() => undefined);
      await vi.waitFor(() => expect(fake.seen).toHaveLength(1));
    } finally {
      delete process.env.IMAP_MOCK_PORT;
    }
  });
});
