import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import { toPinnedTarget } from "@/lib/pinned-connection";

// Real nodemailer, real sockets. The guard hands back two checked addresses:
// ::1 (nothing listens) first, 127.0.0.1 (the server) second, and the name
// resolves to neither. The only way to the server is the pinned socket, so a
// transport built without it fails here (nodemailer would resolve the name
// itself, or fall back to localhost). The createTransport spy also pins the
// shape of what it was handed.
vi.mock("nodemailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nodemailer")>();
  const createTransport = vi.fn(actual.default.createTransport.bind(actual.default));
  return { ...actual, default: { ...actual.default, createTransport } };
});

vi.mock("@/lib/integrations/mail-host-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/mail-host-guard")>()),
  resolveAllowedMailHost: vi.fn(async () => toPinnedTarget(["::1", "127.0.0.1"])),
}));

import nodemailer from "nodemailer";
import { verifySystemMail } from "@/lib/system-mail/transport";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("system mailer connect fallback", () => {
  it("reaches the second checked address when the first refuses", async () => {
    server = createServer((socket) => {
      socket.write("220 mail.pinned.test ESMTP\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        if (/^EHLO/i.test(text)) socket.write("250 ok\r\n");
        if (/^QUIT/i.test(text)) socket.end("221 bye\r\n");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    await expect(
      verifySystemMail({
        host: "mail.pinned.test",
        port,
        security: "none",
        username: undefined,
        password: undefined,
        fromAddress: "pinchy@example.com",
      })
    ).resolves.toBeUndefined();

    // Named host for SNI and the certificate, plus the pinned socket supplier.
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "mail.pinned.test", getSocket: expect.any(Function) })
    );
  });
});
