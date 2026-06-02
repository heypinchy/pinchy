// Real-DB integration test for GET /api/invite/[token].
//
// The /invite/[token] page serves two distinct flows — initial invite claim
// and admin-triggered password reset — but historically rendered the same UI
// for both (issue #436). This loader endpoint lets the page tell the two
// apart before it renders, so the reset flow can drop the display-name field
// (which would otherwise silently overwrite the user's name on submit).
//
// Exercised against a freshly migrated Postgres test DB (global-setup.ts),
// truncated between cases (setup.ts).

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

import { db } from "@/db";
import { invites } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createInvite } from "@/lib/invites";
import { auth } from "@/lib/auth";
import { GET } from "@/app/api/invite/[token]/route";

function makeRequest(token: string) {
  return new NextRequest(`http://localhost:7777/api/invite/${token}`, { method: "GET" });
}

function makeContext(token: string) {
  return { params: Promise.resolve({ token }) };
}

async function seedAdmin() {
  const result = await auth.api.signUpEmail({
    body: { name: "Admin", email: "admin@test.local", password: "adminpassword123" },
  });
  return result.user.id;
}

describe("GET /api/invite/[token] (integration)", () => {
  it("returns { type: 'invite' } for a fresh invite token", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      email: "newcomer@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    const response = await GET(makeRequest(token), makeContext(token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "invite" });
  });

  it("returns { type: 'invite' } for an open invite that has no email", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    const response = await GET(makeRequest(token), makeContext(token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "invite" });
  });

  it("returns { type: 'reset' } for a password-reset token of an existing user", async () => {
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Existing User", email: "existing@test.local", password: "originalpassword1" },
    });
    const { token } = await createInvite({
      email: "existing@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    const response = await GET(makeRequest(token), makeContext(token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "reset" });
  });

  it("returns 410 for an unknown token", async () => {
    const response = await GET(makeRequest("bogus-token"), makeContext("bogus-token"));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "Invalid or expired invite link" });
  });

  it("returns 410 for an already-claimed token", async () => {
    const adminId = await seedAdmin();
    const { token, tokenHash } = await createInvite({
      email: "claimed@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });
    await db
      .update(invites)
      .set({ claimedAt: new Date(), claimedByUserId: adminId })
      .where(eq(invites.tokenHash, tokenHash));

    const response = await GET(makeRequest(token), makeContext(token));
    expect(response.status).toBe(410);
  });

  it("returns 410 for an expired token", async () => {
    const adminId = await seedAdmin();
    const { token, tokenHash } = await createInvite({
      email: "expired@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(invites.tokenHash, tokenHash));

    const response = await GET(makeRequest(token), makeContext(token));
    expect(response.status).toBe(410);
  });

  it("returns 404 for a reset token whose target user no longer exists", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      email: "gone@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    const response = await GET(makeRequest(token), makeContext(token));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "User not found" });
  });
});
