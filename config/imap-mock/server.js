import express from "express";
import net from "net";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

// Thin Express control sidecar in front of a REAL GreenMail mail server
// (greenmail/standalone, a separate compose service — see
// docker-compose.imap-test.yml). IMAP/SMTP are raw TCP protocols, not HTTP
// APIs, so unlike gmail-mock/graph-mock (which fake the whole HTTP surface),
// this sidecar drives GreenMail over the SAME protocols a real client would
// use: nodemailer (SMTP) to seed mail, imapflow (IMAP) to list/purge it.
// This is deliberately more portable than GreenMail's REST API, whose exact
// JSON endpoint shape varies across versions/docs.
//
// GreenMail is started with GREENMAIL_OPTS including
// `-Dgreenmail.auth.disabled`, so any username/password pair authenticates
// and mailboxes are created on demand — the sidecar uses a single fixed
// mailbox (MOCK_USER) for all seeded/listed mail.

const app = express();
app.use(express.json());

const GREENMAIL_HOST = process.env.GREENMAIL_HOST ?? "greenmail";
const GREENMAIL_SMTP_PORT = Number(process.env.GREENMAIL_SMTP_PORT ?? 3025);
const GREENMAIL_IMAP_PORT = Number(process.env.GREENMAIL_IMAP_PORT ?? 3143);
const MOCK_USER = process.env.IMAP_MOCK_USER ?? "mock@example.com";
const MOCK_PASSWORD = process.env.IMAP_MOCK_PASSWORD ?? "mock-password";

const requestLog = [];

function logRequest(entry) {
  requestLog.push({ at: new Date().toISOString(), ...entry });
}

// Checks that a GreenMail port is accepting TCP connections. A full
// login round-trip isn't necessary for a liveness check and would be slower;
// this mirrors the shallow-but-sufficient health checks in gmail-mock/
// graph-mock (`GET /control/health` -> `{ ok: true }` if reachable).
function checkTcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onDone = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => onDone(true));
    socket.once("timeout", () => onDone(false));
    socket.once("error", () => onDone(false));
    socket.connect(port, host);
  });
}

async function withImapClient(fn) {
  const client = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAP_PORT,
    secure: false,
    logger: false,
    auth: { user: MOCK_USER, pass: MOCK_PASSWORD },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

// ---- Control plane ----

// Reports ready only when BOTH GreenMail listeners are bound: IMAP (used by
// /control/{reset,messages}) AND SMTP (used by /control/seed to deliver mail).
// GreenMail binds these ports independently, so gating on IMAP alone lets the
// readiness poll go green before the SMTP listener is up — the first
// seedImapMessage() then intermittently fails. Require both to be reachable.
app.get("/control/health", async (_req, res) => {
  const [imapOk, smtpOk] = await Promise.all([
    checkTcpReachable(GREENMAIL_HOST, GREENMAIL_IMAP_PORT),
    checkTcpReachable(GREENMAIL_HOST, GREENMAIL_SMTP_PORT),
  ]);
  if (!imapOk || !smtpOk) {
    return res.status(503).json({ ok: false, imap: imapOk, smtp: smtpOk });
  }
  res.json({ ok: true });
});

// Purges all mail from the mock mailbox by deleting every message in INBOX.
// GreenMail has no bulk "purge" IMAP verb, so this opens INBOX, marks every
// UID \Deleted, and expunges — the standard IMAP way to empty a mailbox.
app.post("/control/reset", async (req, res) => {
  try {
    await withImapClient(async (client) => {
      await client.mailboxOpen("INBOX");
      const uids = await client.search({ all: true }, { uid: true });
      if (uids && uids.length > 0) {
        await client.messageFlagsAdd(uids, ["\\Deleted"], { uid: true });
        await client.mailboxClose(); // CLOSE expunges \Deleted messages
      }
    });
    requestLog.length = 0;
    logRequest({ endpoint: "/control/reset", method: "POST" });
    res.json({ ok: true });
  } catch (err) {
    console.error("imap-mock: reset failed", err);
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Delivers a message into the mock mailbox by SMTP-sending it through
// GreenMail — the most realistic and portable way to seed IMAP-visible mail
// (it exercises the real SMTP-to-mailbox delivery path, same as production).
app.post("/control/seed", async (req, res) => {
  const { to, from, subject, body } = req.body ?? {};
  if (!to || !subject) {
    return res.status(400).json({ ok: false, error: "to and subject are required" });
  }
  try {
    const transport = nodemailer.createTransport({
      host: GREENMAIL_HOST,
      port: GREENMAIL_SMTP_PORT,
      secure: false,
      auth: { user: MOCK_USER, pass: MOCK_PASSWORD },
    });
    const info = await transport.sendMail({
      from: from ?? MOCK_USER,
      to,
      subject,
      text: body ?? "",
    });
    transport.close?.();
    logRequest({ endpoint: "/control/seed", method: "POST", to, subject });
    res.json({ ok: true, messageId: info.messageId ?? null });
  } catch (err) {
    console.error("imap-mock: seed failed", err);
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Lists delivered messages in the mock mailbox (INBOX) for test assertions.
app.get("/control/requests", async (_req, res) => {
  res.json(requestLog);
});

app.get("/control/messages", async (_req, res) => {
  try {
    const messages = await withImapClient(async (client) => {
      await client.mailboxOpen("INBOX");
      const uids = await client.search({ all: true }, { uid: true });
      if (!uids || uids.length === 0) return [];
      const result = [];
      for await (const msg of client.fetch(
        uids,
        { envelope: true, flags: true },
        { uid: true },
      )) {
        result.push({
          uid: msg.uid,
          from: msg.envelope?.from?.[0]?.address ?? "",
          to: msg.envelope?.to?.map((a) => a.address).join(", ") ?? "",
          subject: msg.envelope?.subject ?? "",
          date: msg.envelope?.date ?? null,
          seen: msg.flags?.has("\\Seen") ?? false,
        });
      }
      return result;
    });
    res.json(messages);
  } catch (err) {
    console.error("imap-mock: list messages failed", err);
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

const port = Number(process.env.PORT ?? 9006);
app.listen(port, () => console.log(`imap-mock listening on ${port}`));
