import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import { toPinnedTarget } from "@/lib/pinned-connection";

// Real sockets. The guard hands back two checked addresses: ::1 (nothing
// listens) first, 127.0.0.1 (the server) second. The hostname resolves to
// neither, so only the pinned lookup can reach it.
vi.mock("@/lib/integrations/mail-host-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/mail-host-guard")>()),
  resolveAllowedMailHost: vi.fn(async () => toPinnedTarget(["::1", "127.0.0.1"])),
}));

import { probeSmtpPorts } from "@/lib/integrations/imap-probe";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("probeSmtpPorts with several checked addresses", () => {
  it("reports a port reachable when only the second address accepts", async () => {
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    await expect(probeSmtpPorts("mail.pinned.test", [port])).resolves.toEqual([
      { port, reachable: true },
    ]);
  });
});
