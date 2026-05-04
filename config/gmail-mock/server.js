import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// State
let messages = [];
let sentMessages = [];
const requestLog = [];

function resetState() {
  messages = [
    {
      id: "msg-001",
      threadId: "thread-001",
      payload: {
        headers: [
          { name: "Subject", value: "Test Email 1" },
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "test@example.com" },
          { name: "Date", value: new Date().toUTCString() },
        ],
        body: { data: Buffer.from("Hello from seed!").toString("base64url") },
      },
      snippet: "Hello from seed!",
      labelIds: ["INBOX", "UNREAD"],
    },
  ];
  sentMessages = [];
  requestLog.length = 0;
}
resetState();

// ---- OAuth endpoint ----
app.post("/token", (req, res) => {
  const { refresh_token, grant_type } = req.body;
  requestLog.push({ endpoint: "/token", grant_type, hasRefreshToken: !!refresh_token });
  if (refresh_token === "invalid-refresh-token") {
    return res.status(401).json({ error: "invalid_grant" });
  }
  res.json({
    access_token: `mock-access-token-${crypto.randomBytes(4).toString("hex")}`,
    expires_in: 3600,
    token_type: "Bearer",
    scope: "https://www.googleapis.com/auth/gmail.modify",
  });
});

// ---- Gmail API surface ----
app.get("/gmail/v1/users/me/profile", (req, res) => {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ") || auth === "Bearer expired-token") {
    return res.status(401).json({ error: { code: 401, message: "Invalid Credentials" } });
  }
  res.json({ emailAddress: "test@example.com", messagesTotal: messages.length });
});

app.get("/gmail/v1/users/me/messages", (req, res) => {
  requestLog.push({ endpoint: "/messages", query: req.query });
  res.json({
    messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })),
    resultSizeEstimate: messages.length,
  });
});

app.get("/gmail/v1/users/me/messages/:id", (req, res) => {
  const msg = messages.find((m) => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: { code: 404, message: "Not Found" } });
  res.json(msg);
});

app.post("/gmail/v1/users/me/messages/send", (req, res) => {
  const { raw } = req.body;
  sentMessages.push({ raw, sentAt: new Date().toISOString() });
  res.json({ id: `sent-${crypto.randomBytes(4).toString("hex")}` });
});

// ---- Control plane ----
app.get("/control/health", (_req, res) => res.json({ ok: true }));
app.post("/control/reset", (_req, res) => {
  resetState();
  res.json({ ok: true });
});
app.post("/control/seed", (req, res) => {
  if (Array.isArray(req.body?.messages)) messages = req.body.messages;
  res.json({ ok: true });
});
app.get("/control/sent", (_req, res) => res.json(sentMessages));
app.get("/control/requests", (_req, res) => res.json(requestLog));

const port = Number(process.env.PORT ?? 9004);
app.listen(port, () => console.log(`gmail-mock listening on ${port}`));
