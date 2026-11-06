/**
 * The emails the system mailer sends (#1309). Plain text plus a simple HTML
 * alternative: no images, no remote assets, no tracking. Voice per
 * PERSONALITY.md — direct and warm, no exclamation marks.
 *
 * Two injection rules, because every interpolated value is a name or address
 * someone typed: the subject has CR/LF stripped (nodemailer encodes headers,
 * but a subject should never be able to start a new line), and the HTML body
 * escapes everything.
 */

export type EmailContent = { subject: string; text: string; html: string };

export type LinkEmailInput = {
  kind: "invite" | "reset";
  inviter: { name: string | null; email: string };
  instanceHost: string;
  link: string;
  expiresAt: Date;
  timeZone: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function formatExpiry(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  });
}

function html(paragraphs: string[], link: string): string {
  const body = paragraphs
    .map((p) =>
      p === link
        ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`
        : `<p>${escapeHtml(p)}</p>`
    )
    .join("\n");
  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a;">
${body}
</body></html>`;
}

export function buildLinkEmail(input: LinkEmailInput): EmailContent {
  const inviterName = oneLine(input.inviter.name ?? "") || input.inviter.email;
  const expires = formatExpiry(input.expiresAt, input.timeZone);
  const usage = `The link works once and expires on ${expires}.`;

  const paragraphs =
    input.kind === "invite"
      ? [
          "Hi,",
          `${inviterName} (${input.inviter.email}) invited you to Pinchy at ${input.instanceHost}.`,
          "Set your password and sign in here:",
          input.link,
          `${usage} If you weren't expecting this, you can ignore this email.`,
        ]
      : [
          "Hi,",
          `${inviterName} (${input.inviter.email}) created a link to reset your Pinchy password at ${input.instanceHost}.`,
          "Choose a new password here:",
          input.link,
          `${usage} If you didn't ask for this, you can ignore this email — your current password keeps working.`,
        ];

  const subject =
    input.kind === "invite"
      ? oneLine(`${inviterName} invited you to Pinchy`)
      : "Reset your Pinchy password";

  return { subject, text: paragraphs.join("\n\n") + "\n", html: html(paragraphs, input.link) };
}

export function buildTestEmail(input: { instanceHost: string }): EmailContent {
  const paragraphs = [
    "Hi,",
    `This is a test from Pinchy at ${input.instanceHost}. Email delivery works: invitations and password reset links will now arrive by email.`,
  ];
  return {
    subject: "Pinchy can send email",
    text: paragraphs.join("\n\n") + "\n",
    html: html(paragraphs, ""),
  };
}
