import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import { toPinnedTarget } from "@/lib/pinned-connection";

// Real nodemailer, real sockets. The guard hands back two checked addresses:
// ::1 (nothing listens) first, 127.0.0.1 (the server) second. Before the
// connect was pinned, nodemailer's own Happy Eyeballs reached the second one;
// pinning to addresses[0] alone made this fail.
vi.mock("@/lib/integrations/mail-host-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/mail-host-guard")>()),
  resolveAllowedMailHost: vi.fn(async () => toPinnedTarget(["::1", "127.0.0.1"])),
}));

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
  });
});
