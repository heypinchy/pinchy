import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { systemMailTestSchema } from "@/lib/schemas/system-mail";
import { getSystemMailConfig } from "@/lib/system-mail/config";
import { deliverTestEmail } from "@/lib/system-mail/deliver";

/**
 * Sends a test email to the signed-in admin with the SAVED config. Saving
 * already proved the server accepts the login; this proves it accepts the
 * sender address and delivers, which relays refuse far more often.
 *
 * The recipient is always the caller's own address — never a field in the
 * body — so the button cannot be used to send mail to someone else.
 */
// audit-exempt: deliverTestEmail writes the mail.sent row for every attempt, success or failure
export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const parsed = await parseRequestBody(systemMailTestSchema, request);
  if ("error" in parsed) return parsed.error;

  const config = await getSystemMailConfig();
  if (!config) {
    return NextResponse.json({ error: "Email delivery isn't set up." }, { status: 409 });
  }

  const to = session.user.email;
  const result = await deliverTestEmail({ config, request, to, actorId: session.user.id });
  if (!result.sent) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json({ sent: true, to });
}
