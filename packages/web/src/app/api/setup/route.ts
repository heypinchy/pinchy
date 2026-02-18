import { NextRequest, NextResponse } from "next/server";
import { createAdmin } from "@/lib/setup";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return NextResponse.json(
        { error: "A valid email address is required" },
        { status: 400 }
      );
    }
    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const user = await createAdmin(email, password);
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Setup already complete") {
      return NextResponse.json(
        { error: "Setup already complete" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
