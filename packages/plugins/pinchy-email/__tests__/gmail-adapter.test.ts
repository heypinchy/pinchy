import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock googleapis before importing the adapter
const mockList = vi.fn();
const mockGet = vi.fn();
const mockDraftsCreate = vi.fn();
const mockSend = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockList,
          get: mockGet,
          send: mockSend,
        },
        drafts: {
          create: mockDraftsCreate,
        },
      },
    })),
    auth: {
      OAuth2: vi.fn(() => ({
        setCredentials: vi.fn(),
      })),
    },
  },
}));

import { GmailAdapter } from "../gmail-adapter.js";

// Helper: base64url encode a string
function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

describe("GmailAdapter", () => {
  let adapter: GmailAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GmailAdapter({ accessToken: "test-token" });
  });

  describe("list", () => {
    it("returns email summaries from Gmail API", async () => {
      mockList.mockResolvedValue({
        data: {
          messages: [{ id: "msg1" }, { id: "msg2" }],
        },
      });

      mockGet
        .mockResolvedValueOnce({
          data: {
            id: "msg1",
            snippet: "Hello there",
            labelIds: ["UNREAD", "INBOX"],
            payload: {
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Test email" },
                { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: "msg2",
            snippet: "Another one",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "charlie@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Second email" },
                { name: "Date", value: "Mon, 7 Apr 2026 11:00:00 +0000" },
              ],
            },
          },
        });

      const result = await adapter.list({ limit: 10 });

      expect(result).toEqual([
        {
          id: "msg1",
          from: "alice@example.com",
          to: "bob@example.com",
          subject: "Test email",
          date: "Mon, 7 Apr 2026 10:00:00 +0000",
          snippet: "Hello there",
          unread: true,
        },
        {
          id: "msg2",
          from: "charlie@example.com",
          to: "bob@example.com",
          subject: "Second email",
          date: "Mon, 7 Apr 2026 11:00:00 +0000",
          snippet: "Another one",
          unread: false,
        },
      ]);

      expect(mockList).toHaveBeenCalledWith({
        userId: "me",
        maxResults: 10,
        q: undefined,
        labelIds: undefined,
      });

      expect(mockGet).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
    });

    it("filters by folder using labelIds", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.list({ folder: "INBOX" });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ labelIds: ["INBOX"] }),
      );
    });

    it("filters unread only", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.list({ unreadOnly: true });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ q: "is:unread" }),
      );
    });

    it("returns empty array when no messages", async () => {
      mockList.mockResolvedValue({ data: {} });

      const result = await adapter.list({});

      expect(result).toEqual([]);
    });

    it("defaults limit to 20", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.list({});

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 20 }),
      );
    });
  });

  describe("read", () => {
    it("returns full email with plain text body from single-part message", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg1",
          snippet: "Hello there",
          labelIds: ["UNREAD", "INBOX"],
          payload: {
            mimeType: "text/plain",
            body: { data: base64url("Hello, this is the body.") },
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Cc", value: "charlie@example.com" },
              { name: "Subject", value: "Test email" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg1");

      expect(result).toEqual({
        id: "msg1",
        from: "alice@example.com",
        to: "bob@example.com",
        cc: "charlie@example.com",
        subject: "Test email",
        date: "Mon, 7 Apr 2026 10:00:00 +0000",
        snippet: "Hello there",
        unread: true,
        body: "Hello, this is the body.",
      });

      expect(mockGet).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        format: "full",
      });
    });

    it("extracts text/plain from multipart message", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg2",
          snippet: "Multi",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: base64url("Plain text body") },
              },
              {
                mimeType: "text/html",
                body: { data: base64url("<b>HTML body</b>") },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "Multipart" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg2");

      expect(result.body).toBe("Plain text body");
    });

    it("falls back to text/html when no text/plain", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg3",
          snippet: "HTML only",
          labelIds: [],
          payload: {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/html",
                body: { data: base64url("<b>HTML only</b>") },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "HTML only" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg3");

      expect(result.body).toBe("<b>HTML only</b>");
    });

    it("handles nested multipart/mixed with multipart/alternative", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg4",
          snippet: "Nested",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "multipart/alternative",
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { data: base64url("Nested plain") },
                  },
                  {
                    mimeType: "text/html",
                    body: { data: base64url("<b>Nested HTML</b>") },
                  },
                ],
              },
              {
                mimeType: "application/pdf",
                filename: "doc.pdf",
                body: { attachmentId: "att1" },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "Nested" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg4");

      expect(result.body).toBe("Nested plain");
    });

    it("returns empty body when no text parts found", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg5",
          snippet: "No body",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "application/pdf",
                filename: "doc.pdf",
                body: { attachmentId: "att1" },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "No body" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg5");

      expect(result.body).toBe("");
    });
  });

  describe("search", () => {
    it("passes query to Gmail list API", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.search({ query: "from:alice subject:meeting" });

      expect(mockList).toHaveBeenCalledWith({
        userId: "me",
        maxResults: 20,
        q: "from:alice subject:meeting",
        labelIds: undefined,
      });
    });

    it("respects limit parameter", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.search({ query: "test", limit: 5 });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 5 }),
      );
    });
  });

  describe("draft", () => {
    it("creates a draft email", async () => {
      mockDraftsCreate.mockResolvedValue({
        data: { id: "draft-123" },
      });

      const result = await adapter.draft({
        to: "bob@example.com",
        subject: "Draft subject",
        body: "Draft body",
      });

      expect(result).toEqual({ draftId: "draft-123" });

      expect(mockDraftsCreate).toHaveBeenCalledWith({
        userId: "me",
        requestBody: {
          message: {
            raw: expect.any(String),
          },
        },
      });

      // Verify the raw message content
      const call = mockDraftsCreate.mock.calls[0][0];
      const raw = Buffer.from(call.requestBody.message.raw, "base64url").toString("utf-8");
      expect(raw).toContain("To: bob@example.com");
      expect(raw).toContain("Subject: Draft subject");
      expect(raw).toContain("Draft body");
    });

    it("includes In-Reply-To header when replyTo is provided", async () => {
      mockDraftsCreate.mockResolvedValue({
        data: { id: "draft-reply" },
      });

      await adapter.draft({
        to: "bob@example.com",
        subject: "Re: Original",
        body: "Reply body",
        replyTo: "<original-msg-id@example.com>",
      });

      const call = mockDraftsCreate.mock.calls[0][0];
      const raw = Buffer.from(call.requestBody.message.raw, "base64url").toString("utf-8");
      expect(raw).toContain("In-Reply-To: <original-msg-id@example.com>");
    });
  });

  describe("send", () => {
    it("sends an email and returns messageId", async () => {
      mockSend.mockResolvedValue({
        data: { id: "sent-456" },
      });

      const result = await adapter.send({
        to: "bob@example.com",
        subject: "Sent subject",
        body: "Sent body",
      });

      expect(result).toEqual({ messageId: "sent-456" });

      expect(mockSend).toHaveBeenCalledWith({
        userId: "me",
        requestBody: {
          raw: expect.any(String),
        },
      });

      // Verify the raw message content
      const call = mockSend.mock.calls[0][0];
      const raw = Buffer.from(call.requestBody.raw, "base64url").toString("utf-8");
      expect(raw).toContain("To: bob@example.com");
      expect(raw).toContain("Subject: Sent subject");
      expect(raw).toContain("Sent body");
    });

    it("includes In-Reply-To header when replyTo is provided", async () => {
      mockSend.mockResolvedValue({
        data: { id: "sent-reply" },
      });

      await adapter.send({
        to: "bob@example.com",
        subject: "Re: Thread",
        body: "Reply",
        replyTo: "<thread-id@example.com>",
      });

      const call = mockSend.mock.calls[0][0];
      const raw = Buffer.from(call.requestBody.raw, "base64url").toString("utf-8");
      expect(raw).toContain("In-Reply-To: <thread-id@example.com>");
    });
  });

  describe("MIME header injection prevention", () => {
    beforeEach(() => {
      mockDraftsCreate.mockResolvedValue({ data: { id: "draft-safe" } });
    });

    function getRawLines(mockFn: ReturnType<typeof vi.fn>): string[] {
      const call = mockFn.mock.calls[0][0];
      const raw = Buffer.from(call.requestBody.message.raw, "base64url").toString("utf-8");
      return raw.split("\r\n");
    }

    it("strips CRLF from the to field to prevent header injection", async () => {
      await adapter.draft({
        to: "victim@example.com\r\nBcc: attacker@evil.com",
        subject: "Hello",
        body: "Body",
      });

      const lines = getRawLines(mockDraftsCreate);
      // No standalone Bcc header line should exist
      expect(lines.every((line) => !line.startsWith("Bcc:"))).toBe(true);
    });

    it("strips CRLF from the subject field to prevent header injection", async () => {
      await adapter.draft({
        to: "bob@example.com",
        subject: "Innocent\r\nBcc: attacker@evil.com",
        body: "Body",
      });

      const lines = getRawLines(mockDraftsCreate);
      expect(lines.every((line) => !line.startsWith("Bcc:"))).toBe(true);
    });

    it("strips CRLF from the replyTo field to prevent header injection", async () => {
      await adapter.draft({
        to: "bob@example.com",
        subject: "Re: Test",
        body: "Body",
        replyTo: "<msg-id@example.com>\r\nBcc: attacker@evil.com",
      });

      const lines = getRawLines(mockDraftsCreate);
      expect(lines.every((line) => !line.startsWith("Bcc:"))).toBe(true);
    });

    it("strips lone LF from header fields", async () => {
      await adapter.draft({
        to: "victim@example.com\nX-Injected: yes",
        subject: "Hello",
        body: "Body",
      });

      const lines = getRawLines(mockDraftsCreate);
      expect(lines.every((line) => !line.startsWith("X-Injected:"))).toBe(true);
    });
  });

  describe("base64url encoding/decoding", () => {
    it("correctly decodes base64url body with special characters", async () => {
      const originalText = "Hello! Special chars: +/= and umlauts: äöü";
      mockGet.mockResolvedValue({
        data: {
          id: "msg-special",
          snippet: "Special",
          labelIds: [],
          payload: {
            mimeType: "text/plain",
            body: { data: base64url(originalText) },
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "Special" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg-special");

      expect(result.body).toBe(originalText);
    });
  });
});
