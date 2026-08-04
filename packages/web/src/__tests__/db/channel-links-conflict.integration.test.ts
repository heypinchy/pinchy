// Real-DB integration test for `isChannelUserIdConflictError`, the predicate
// `POST /api/settings/telegram` uses to turn "this Telegram account already
// belongs to someone else" into a 409 instead of a raw 500.
//
// It exists because the unit tests structurally cannot prove the thing that
// matters. They build the error object by hand from the same assumption the
// predicate encodes, so they agree with it no matter what Postgres and drizzle
// actually throw — and the first version of the predicate was wrong in exactly
// the gap that leaves: it read `code` / `constraint_name` off the thrown error,
// while drizzle-orm 0.45 re-throws every driver error as `DrizzleQueryError`
// with postgres.js's `PostgresError` hidden on `.cause`. Every unit test was
// green; the 409 branch was unreachable in production.
//
// Same lesson as the X-Frame-Options gate in AGENTS.md: assert what a concrete
// request resolves to, not what the code asked for.

import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { users, channelLinks } from "@/db/schema";
import { isChannelUserIdConflictError } from "@/lib/telegram-pairing-security";

const suffix = Math.random().toString(36).slice(2);
let userCounter = 0;

async function insertUser() {
  const [row] = await db
    .insert(users)
    .values({
      email: `channel-links-${suffix}-${userCounter++}@test.local`,
      name: "Channel Links User",
    })
    .returning();
  return row;
}

async function linkTelegram(userId: string, channelUserId: string) {
  await db.insert(channelLinks).values({ userId, channel: "telegram", channelUserId });
}

/** Whatever the insert rejects with — the test never says what shape it is. */
async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    throw new Error("expected the insert to be rejected, but it succeeded");
  } catch (err) {
    return err;
  }
}

describe("isChannelUserIdConflictError against a real Postgres", () => {
  it("recognizes a second user claiming an already-linked Telegram account", async () => {
    const [owner, intruder] = [await insertUser(), await insertUser()];
    const telegramUserId = `87546977${userCounter}`;

    await linkTelegram(owner.id, telegramUserId);
    const err = await captureRejection(() => linkTelegram(intruder.id, telegramUserId));

    expect(isChannelUserIdConflictError(err)).toBe(true);
  });

  // The other unique index on channel_links. It is the `onConflictDoUpdate`
  // target the route already handles, so the predicate must NOT claim it — a
  // 409 saying "already linked to a different Pinchy user" would be a lie.
  it("does not recognize a violation of the (user, channel) index", async () => {
    const user = await insertUser();

    await linkTelegram(user.id, `11111111${userCounter}`);
    const err = await captureRejection(() => linkTelegram(user.id, `22222222${userCounter}`));

    expect(isChannelUserIdConflictError(err)).toBe(false);
  });

  it("does not recognize an unrelated failure", async () => {
    const err = await captureRejection(() => linkTelegram("no-such-user", "33333333"));

    expect(isChannelUserIdConflictError(err)).toBe(false);
  });
});
