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

// Microsoft Graph v1.0 message-listing endpoints require every property named
// in $orderby to also appear in $filter, in the same order, ahead of any other
// filter properties. Violating this returns HTTP 400 InefficientFilter ("The
// restriction or sort order is too complex for this operation"). Real Graph
// enforces this; this mock didn't, so a client bug that violates the rule
// stayed invisible in E2E. Reproduce the rejection here (string-based checks
// are sufficient for a mock — this is not a full OData parser).
function checkInefficientFilter(req, res) {
  const filter = req.query.$filter;
  const orderby = req.query.$orderby;
  if (!filter || !orderby) return true;
  const orderbyProps = String(orderby)
    .split(",")
    .map((clause) => clause.trim().split(/\s+/)[0]);
  const filterStr = String(filter);
  const firstProp = orderbyProps[0];
  const startsWithFirst = filterStr.trimStart().startsWith(firstProp);
  const allPropsPresent = orderbyProps.every((prop) =>
    filterStr.includes(prop),
  );
  if (!startsWithFirst || !allPropsPresent) {
    res.status(400).json({
      error: {
        code: "InefficientFilter",
        message:
          "The restriction or sort order is too complex for this operation.",
      },
    });
    return false;
  }
  return true;
}

function resetState() {
  messages = [
    {
      id: generateId(),
      subject: "Test Email 1",
      from: { emailAddress: { address: "sender@contoso.com", name: "Sender" } },
      toRecipients: [
        { emailAddress: { address: "test@contoso.com", name: "Test User" } },
      ],
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
    res.status(401).json({
      error: {
        code: "InvalidAuthenticationToken",
        message: "Access token is empty.",
      },
    });
    return false;
  }
  return true;
}

// ---- Microsoft OAuth endpoints ----
// Tenant-scoped token endpoint (/:tenant/oauth2/v2.0/token)
app.post("/:tenant/oauth2/v2.0/token", (req, res) => {
  const { grant_type, code, refresh_token } = req.body;
  requestLog.push({
    endpoint: "/oauth2/v2.0/token",
    grant_type,
    hasCode: !!code,
    hasRefreshToken: !!refresh_token,
  });

  if (refresh_token === "invalid-refresh-token" || code === "invalid-code") {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "The provided value is invalid.",
    });
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

// OIDC discovery — pre-flight tenant existence check. 400 + AADSTS90002 for the
// designated bad tenant, 200 with a minimal discovery doc otherwise.
app.get("/:tenant/v2.0/.well-known/openid-configuration", (req, res) => {
  const bad = "00000000-0000-0000-0000-000000000000"; // E2E "wrong tenant" marker
  if (req.params.tenant === bad) {
    return res.status(400).json({
      error: "invalid_tenant",
      error_description: `AADSTS90002: Tenant '${bad}' not found.`,
      error_codes: [90002],
    });
  }
  res.json({
    issuer: `http://graph-mock:9005/${req.params.tenant}/v2.0`,
    authorization_endpoint: `http://graph-mock:9005/${req.params.tenant}/oauth2/v2.0/authorize`,
    token_endpoint: `http://graph-mock:9005/${req.params.tenant}/oauth2/v2.0/token`,
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
  if (!checkInefficientFilter(req, res)) return;
  requestLog.push({ endpoint: "/v1.0/me/messages", query: req.query });
  res.json({ value: messages, "@odata.count": messages.length });
});

// GET /v1.0/me/mailFolders/:folderId/messages — list messages scoped to a
// well-known folder (inbox, sentitems, drafts, ...). This is the path the
// adapter uses whenever a folder is set — including the INBOX default when
// email_list is called without one. Seeded messages carry no folder
// assignment; like gmail-mock (which treats every seeded message as INBOX),
// the folder segment only affects the logged endpoint.
app.get("/v1.0/me/mailFolders/:folderId/messages", (req, res) => {
  if (!requireBearer(req, res)) return;
  if (!checkInefficientFilter(req, res)) return;
  requestLog.push({
    endpoint: `/v1.0/me/mailFolders/${req.params.folderId}/messages`,
    query: req.query,
  });
  res.json({ value: messages, "@odata.count": messages.length });
});

// GET /v1.0/me/messages/:id — get a message by id
app.get("/v1.0/me/messages/:id", (req, res) => {
  if (!requireBearer(req, res)) return;
  const msg = messages.find((m) => m.id === req.params.id);
  if (!msg)
    return res.status(404).json({
      error: {
        code: "ErrorItemNotFound",
        message: "The specified object was not found in the store.",
      },
    });
  res.json(msg);
});

// GET /v1.0/me/messages/:id/attachments — list attachment metadata (no contentBytes)
app.get("/v1.0/me/messages/:id/attachments", (req, res) => {
  if (!requireBearer(req, res)) return;
  requestLog.push({
    endpoint: `/v1.0/me/messages/${req.params.id}/attachments`,
    messageId: req.params.id,
    method: "GET",
  });
  const msg = messages.find((m) => m.id === req.params.id);
  if (!msg)
    return res.status(404).json({
      error: {
        code: "ErrorItemNotFound",
        message: "The specified object was not found in the store.",
      },
    });
  const value = (msg.attachments ?? []).map((a) => ({
    "@odata.type": a["@odata.type"],
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    isInline: a.isInline,
  }));
  res.json({ value });
});

// GET /v1.0/me/messages/:id/attachments/:attachmentId — single attachment, including contentBytes
app.get("/v1.0/me/messages/:id/attachments/:attachmentId", (req, res) => {
  if (!requireBearer(req, res)) return;
  requestLog.push({
    endpoint: `/v1.0/me/messages/${req.params.id}/attachments/${req.params.attachmentId}`,
    messageId: req.params.id,
    attachmentId: req.params.attachmentId,
    method: "GET",
  });
  const msg = messages.find((m) => m.id === req.params.id);
  const attachment = msg?.attachments?.find(
    (a) => a.id === req.params.attachmentId,
  );
  if (!attachment)
    return res.status(404).json({
      error: {
        code: "ErrorItemNotFound",
        message: "The specified object was not found in the store.",
      },
    });
  res.json(attachment);
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
  requestLog.push({
    endpoint: "/v1.0/me/messages",
    method: "POST",
    draftId: draft.id,
  });
  res.status(201).json(draft);
});

// PATCH /v1.0/me/messages/:id — update a draft
app.patch("/v1.0/me/messages/:id", (req, res) => {
  if (!requireBearer(req, res)) return;
  const idx = messages.findIndex((m) => m.id === req.params.id);
  if (idx === -1)
    return res.status(404).json({
      error: {
        code: "ErrorItemNotFound",
        message: "The specified object was not found in the store.",
      },
    });
  messages[idx] = { ...messages[idx], ...req.body };
  requestLog.push({
    endpoint: `/v1.0/me/messages/${req.params.id}`,
    method: "PATCH",
  });
  res.json(messages[idx]);
});

// POST /v1.0/me/messages/:id/send — send a draft
app.post("/v1.0/me/messages/:id/send", (req, res) => {
  if (!requireBearer(req, res)) return;
  const idx = messages.findIndex((m) => m.id === req.params.id);
  if (idx !== -1) {
    messages[idx] = {
      ...messages[idx],
      isDraft: false,
      sentDateTime: new Date().toISOString(),
    };
  }
  requestLog.push({
    endpoint: `/v1.0/me/messages/${req.params.id}/send`,
    method: "POST",
  });
  res.status(202).end();
});

// POST /v1.0/me/sendMail — send a direct message
app.post("/v1.0/me/sendMail", (req, res) => {
  if (!requireBearer(req, res)) return;
  requestLog.push({
    endpoint: "/v1.0/me/sendMail",
    method: "POST",
    subject: req.body?.message?.subject,
  });
  res.status(202).end();
});

// POST /v1.0/me/messages/:id/createReply — create a reply draft
app.post("/v1.0/me/messages/:id/createReply", (req, res) => {
  if (!requireBearer(req, res)) return;
  const original = messages.find((m) => m.id === req.params.id);
  if (!original)
    return res.status(404).json({
      error: {
        code: "ErrorItemNotFound",
        message: "The specified object was not found in the store.",
      },
    });
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
  requestLog.push({
    endpoint: `/v1.0/me/messages/${req.params.id}/createReply`,
    method: "POST",
    replyId: reply.id,
  });
  res.status(201).json(reply);
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
