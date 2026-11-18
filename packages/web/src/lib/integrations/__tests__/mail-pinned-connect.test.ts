import { describe, it, expect, afterEach } from "vitest";
import { createServer, connect, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import {
  connectPinned,
  pinnedImapOptions,
  pinnedSmtpOptions,
} from "@/lib/integrations/mail-host-guard";
import { toPinnedTarget } from "@/lib/pinned-connection";

// Real sockets: the point is what the connector does when the FIRST checked
// address does not answer. ::1 refuses (nothing listens on it), 127.0.0.1 has
// the server, and the name resolves to neither — only the pinned lookup knows.
const TARGET = toPinnedTarget(["::1", "127.0.0.1"]);

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function listenOnIPv4(): Promise<number> {
  server = createServer((socket) => {
    // The client destroys its end while the greeting may still be unread,
    // which resets this side; without a listener that reset is an uncaught
    // ECONNRESET that fails the whole run, not this file.
    socket.on("error", () => {});
    socket.end("220 hello\r\n");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("pinned mail connections keep the connector's address fallback", () => {
  it("connectPinned reaches the second address when the first refuses", async () => {
    const port = await listenOnIPv4();
    const socket = await connectPinned("mail.pinned.test", port, TARGET, 5_000);
    expect(socket.remoteAddress).toBe("127.0.0.1");
    socket.destroy();
  });

  it("connectPinned rejects when no checked address answers", async () => {
    await expect(
      connectPinned("mail.pinned.test", 1, toPinnedTarget(["127.0.0.1"]), 2_000)
    ).rejects.toThrow();
  });

  it("pinnedImapOptions keeps the hostname and hands imapflow a lookup over every address", async () => {
    const options = pinnedImapOptions("mail.pinned.test", TARGET);
    expect(options.host).toBe("mail.pinned.test");
    expect(options).not.toHaveProperty("servername");

    // imapflow connects with Object.assign({ host, servername, port }, tls).
    const port = await listenOnIPv4();
    const socket = connect({ host: options.host, port, ...options.tls });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    expect(socket.remoteAddress).toBe("127.0.0.1");
    socket.destroy();
  });

  it("pinnedSmtpOptions keeps the hostname (SNI and certificate) and supplies the socket", async () => {
    const options = pinnedSmtpOptions("mail.pinned.test", 0, TARGET, 5_000);
    expect(options.host).toBe("mail.pinned.test");
    expect(options).not.toHaveProperty("servername");
    expect(typeof options.getSocket).toBe("function");
  });

  it("an IP-literal host is passed through and gets no servername", () => {
    const literal = toPinnedTarget(["203.0.113.7"]);
    expect(pinnedImapOptions("203.0.113.7", literal)).not.toHaveProperty("servername");
    expect(pinnedSmtpOptions("203.0.113.7", 587, literal, 5_000)).not.toHaveProperty("servername");
    expect(pinnedSmtpOptions("203.0.113.7", 587, literal, 5_000).host).toBe("203.0.113.7");
  });
});
