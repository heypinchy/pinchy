import { getSession } from "@/lib/auth";

export async function validateWsSession(
  cookieHeader: string | undefined
): Promise<{ userId: string; userRole: string } | null> {
  if (!cookieHeader) return null;

  try {
    const session = await getSession({
      headers: new Headers({ cookie: cookieHeader }),
    });

    if (!session?.user) return null;

    return {
      userId: session.user.id,
      userRole: session.user.role ?? "user",
    };
  } catch {
    return null;
  }
}
