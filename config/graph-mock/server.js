import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// State
let messages = [];
const requestLog = [];

function generateId() {
  return crypto.randomBytes(16).toString("hex").toUpperCase();
}

function resetState() {
  messages = [
    {
      id: generateId(),
      subject: "Test Email 1",
      from: { emailAddress: { address: "sender@contoso.com", name: "Sender" } },
      toRecipients: [{ emailAddress: { address: "test@contoso.com", name: "Test User" } }],
      body: { contentType: "text", content: "Hello from seed!" },
      receivedDateTime: new Date().toISOString(),
      isRead: false,
      parentFolderId: "inbox",
    },
  ];
  requestLog.length = 0;
}
resetState();

// ---- Auth helper ----
function requireBearer(req, res) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ") || auth.trim() === "Bearer") {
    res.status(401).json({ error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } });
    return false;
  }
  return true;
}

// ---- Microsoft OAuth endpoints ----
// Tenant-scoped token endpoint (/:tenant/oauth2/v2.0/token)
app.post("/:tenant/oauth2/v2.0/token", (req, res) => {
  const { grant_type, code, refresh_token } = req.body;
  requestLog.push({ endpoint: "/oauth2/v2.0/token", grant_type, hasCode: !!code, hasRefreshToken: !!refresh_token });

  if (refresh_token === "invalid-refresh-token" || code === "invalid-code") {
    return res.status(400).json({ error: "invalid_grant", error_description: "The provided value is invalid." });
  }

  const ts = Date.now();
  res.json({
    access_token: `fake-access-${ts}`,
    refresh_token: `fake-refresh-${ts}`,
    expires_in: 3600,
    token_type: "Bearer",
    scope: "Mail.ReadWrite Mail.Send offline_access",
  });
});

// ---- Microsoft Graph API surface ----

// GET /v1.0/me — user profile
app.get("/v1.0/me", (req, res) => {
  if (!requireBearer(req, res)) return;
  res.json({
    mail: "test@contoso.com",
    userPrincipalName: "test@contoso.com",
    displayName: "Test User",
  });
});

// GET /v1.0/me/messages — list messages
app.get("/v1.0/me/messages", (req, res) => {
  if (!requireBearer(req, res)) return;
  requestLog.push({ endpoint: "/v1.0/me/messages", query: req.query });
  res.json({ value: messages, "@odata.count": messages.length });
});

// GET /v1.0/me/messages/:id — get a message by id
app.get("/v1.0/me/messages/:id", (req, res) => {
  if (!requireBearer(req, res)) return;
  const msg = messages.find((m) => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
  res.json(msg);
});

// POST /v1.0/me/messages — create a draft
app.post("/v1.0/me/messages", (req, res) => {
  if (!requireBearer(req, res)) return;
  const draft = {
    id: `draft-${generateId()}`,
    isDraft: true,
    parentFolderId: "drafts",
    receivedDateTime: new Date().toISOString(),
    ...req.body,
  };
  messages.push(draft);
  requestLog.push({ endpoint: "/v1.0/me/messages", method: "POST", draftId: draft.id });
  res.status(201).json(draft);
});

// PATCH /v1.0/me/messages/:id — update a draft
app.patch("/v1.0/me/messages/:id", (req, res) => {
  if (!requireBearer(req, res)) return;
  const idx = messages.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
  messages[idx] = { ...messages[idx], ...req.body };
  requestLog.push({ endpoint: `/v1.0/me/messages/${req.params.id}`, method: "PATCH" });
  res.json(messages[idx]);
});

// POST /v1.0/me/messages/:id/send — send a draft
app.post("/v1.0/me/messages/:id/send", (req, res) => {
  if (!requireBearer(req, res)) return;
  const idx = messages.findIndex((m) => m.id === req.params.id);
  if (idx !== -1) {
    messages[idx] = { ...messages[idx], isDraft: false, sentDateTime: new Date().toISOString() };
  }
  requestLog.push({ endpoint: `/v1.0/me/messages/${req.params.id}/send`, method: "POST" });
  res.status(202).end();
});

// POST /v1.0/me/sendMail — send a direct message
app.post("/v1.0/me/sendMail", (req, res) => {
  if (!requireBearer(req, res)) return;
  requestLog.push({ endpoint: "/v1.0/me/sendMail", method: "POST", subject: req.body?.message?.subject });
  res.status(202).end();
});

// POST /v1.0/me/messages/:id/createReply — create a reply draft
app.post("/v1.0/me/messages/:id/createReply", (req, res) => {
  if (!requireBearer(req, res)) return;
  const original = messages.find((m) => m.id === req.params.id);
  if (!original) return res.status(404).json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } });
  const reply = {
    id: `draft-${generateId()}`,
    isDraft: true,
    parentFolderId: "drafts",
    receivedDateTime: new Date().toISOString(),
    subject: `RE: ${original.subject || ""}`,
    from: original.toRecipients?.[0] ?? undefined,
    toRecipients: [original.from].filter(Boolean),
    body: { contentType: "text", content: "" },
  };
  messages.push(reply);
  requestLog.push({ endpoint: `/v1.0/me/messages/${req.params.id}/createReply`, method: "POST", replyId: reply.id });
  res.status(201).json(reply);
});

// GET /v1.0/me/mailFolders/:wellKnown/messages — folder-scoped message list
app.get("/v1.0/me/mailFolders/:wellKnown/messages", (req, res) => {
  if (!requireBearer(req, res)) return;
  const folder = req.params.wellKnown.toLowerCase();
  requestLog.push({ endpoint: `/v1.0/me/mailFolders/${req.params.wellKnown}/messages`, query: req.query });
  const filtered = messages.filter((m) => {
    if (!m.parentFolderId) return true;
    return m.parentFolderId.toLowerCase() === folder;
  });
  res.json({ value: filtered, "@odata.count": filtered.length });
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
app.get("/control/requests", (_req, res) => res.json(requestLog));

const port = Number(process.env.PORT ?? 9005);
app.listen(port, () => console.log(`graph-mock listening on ${port}`));
