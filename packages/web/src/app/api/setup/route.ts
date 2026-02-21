import { NextRequest, NextResponse } from "next/server";
import { createAdmin } from "@/lib/setup";
import { validatePassword } from "@/lib/validate-password";

export async function POST(request: NextRequest) {
  try {
    const { name, email, password } = await request.json();

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const user = await createAdmin(name.trim(), email, password);
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Setup already complete") {
      return NextResponse.json({ error: "Setup already complete" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
