/**
 * Gate decision service — exercised against a real PostgreSQL (no @/db mock)
 * so the consume-once / fail-closed guarantees are proven against actual SQL
 * semantics (FOR UPDATE SKIP LOCKED), not a faked query builder.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, agents, toolApproval } from "@/db/schema";
import {
  decideGate,
  resolveDecision,
  expireStale,
  linkApproval,
  awaitApprovalLink,
  recordResolution,
  MAX_PENDING_PER_REQUESTER,
} from "./service";

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `u${Math.round(performance.now() * 1000)}@example.com`,
      emailVerified: true,
      role: "admin",
      ...overrides,
    })
    .returning();
  return row;
}

async function seedAgent(ownerId: string) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hello!",
      ownerId,
    })
    .returning();
  return row;
}

describe("approvals gate decision service", () => {
  let agentId: string;
  let requesterId: string;
  const base = () => ({
    agentId,
    requesterId,
    sessionKey: "agent:a:direct:u",
    toolName: "odoo_write",
    argsDigest: "digest-1",
  });

  beforeEach(async () => {
    const u = await seedUser();
    requesterId = u.id;
    const a = await seedAgent(u.id);
    agentId = a.id;
  });

  it("blocks and creates a pending confirm request when no ticket exists", async () => {
    const r = await decideGate(base());
    expect(r.decision).toBe("block");
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("pending");
    expect(row.tier).toBe("confirm");
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reuses the same pending request on re-issue (no duplicate rows)", async () => {
    const r1 = await decideGate(base());
    const r2 = await decideGate(base());
    expect(r2.requestId).toBe(r1.requestId);
    expect(await db.select().from(toolApproval)).toHaveLength(1);
  });

  // #1132. OpenClaw keys the approval it broadcasts on the toolCallId, so this
  // is the only field that says WHICH suspended call a confirmation resumes.
  it("records the toolCallId of the call that is waiting", async () => {
    const r = await decideGate({ ...base(), toolCallId: "call_1" });
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.toolCallId).toBe("call_1");
  });

  // #1132. OpenClaw announces the approval it created with its own id. Storing
  // it is what makes the card resolvable — and storing it in the ROW rather
  // than in process memory is what makes it survive a Pinchy restart: OpenClaw
  // keeps an accepted approval pending until its timeout, and `operator.admin`
  // may resolve it from any connection, so a reconnected Pinchy still can.
  describe("linkApproval", () => {
    it("records OpenClaw's approval id on the waiting row", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_9" });
      const linked = await linkApproval({ approvalId: "plugin:xyz", toolCallId: "call_9" });

      expect(linked?.id).toBe(r.requestId);
      const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
      expect(row.openclawApprovalId).toBe("plugin:xyz");
    });

    // The gateway carries OpenClaw's own approvals too (skill workshop, exec).
    // Those name a call Pinchy never opened a row for, and must pass through
    // without touching anything.
    it("links nothing when no confirmation is waiting for that call", async () => {
      await decideGate({ ...base(), toolCallId: "call_ours" });
      const linked = await linkApproval({
        approvalId: "plugin:someone-else",
        toolCallId: "call_theirs",
      });

      expect(linked).toBeNull();
      const rows = await db.select().from(toolApproval);
      expect(rows.every((r) => r.openclawApprovalId === null)).toBe(true);
    });

    // A tool call id is only as unique as the model provider makes it, and
    // Pinchy explicitly supports self-hosted OpenAI-compatible servers — several
    // of which number tool calls per response (`call_0`, `call_1`). Two people
    // can then hold pending confirmations under one id at the same moment, and
    // matching on the id alone would arm BOTH rows with one approval: the second
    // person's Approve resumes the first person's call, which nobody confirmed.
    // The session is what OpenClaw already carries to tell them apart.
    it("arms only the confirmation from the session the approval names", async () => {
      const mine = await decideGate({ ...base(), toolCallId: "call_0" });
      const theirs = await decideGate({
        ...base(),
        sessionKey: "agent:a:direct:someone-else",
        toolCallId: "call_0",
      });

      const linked = await linkApproval({
        approvalId: "plugin:mine",
        toolCallId: "call_0",
        sessionKey: "agent:a:direct:u",
      });

      expect(linked?.id).toBe(mine.requestId);
      const [other] = await db
        .select()
        .from(toolApproval)
        .where(eq(toolApproval.id, theirs.requestId));
      expect(other.openclawApprovalId).toBeNull();
    });

    // Narrowing must never cost a link that works today: a broadcast without a
    // session still resolves by call id alone.
    it("still links when the broadcast names no session", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_9" });
      const linked = await linkApproval({ approvalId: "plugin:xyz", toolCallId: "call_9" });
      expect(linked?.id).toBe(r.requestId);
    });

    /**
     * A broadcast that arrives AFTER the user decided still has to be recorded,
     * and this is the case that made the approvals E2E flake: the decision
     * route flips the row before it resolves, so by the time the broadcast
     * lands the row is already `approved`. Rejecting it there does not merely
     * lose a race — it makes the link permanently impossible, and the user is
     * told "the agent is no longer waiting" about a run that is still parked.
     *
     * Recording the id is not re-arming anything: the inbox lists on
     * `status = pending`, so a decided confirmation stays gone from it whether
     * or not it carries an approval id. What the id buys is the ability to
     * deliver the decision that was already made.
     */
    it("records the id on a confirmation the user just decided, without reopening it", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_done" });
      await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "deny" });

      const linked = await linkApproval({ approvalId: "plugin:late", toolCallId: "call_done" });

      expect(linked?.id).toBe(r.requestId);
      const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
      expect(row.openclawApprovalId).toBe("plugin:late");
      // The decision itself is untouched — this adds an address, not a state.
      expect(row.status).toBe("denied");
    });

    // Two approvals for one call cannot both be live, and the first one is the
    // one the run is actually waiting on. Overwriting it would point the
    // decision at an approval OpenClaw has already discarded.
    it("never overwrites an approval id already on the row", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_two" });
      await linkApproval({ approvalId: "plugin:first", toolCallId: "call_two" });

      expect(
        await linkApproval({ approvalId: "plugin:second", toolCallId: "call_two" })
      ).toBeNull();
      const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
      expect(row.openclawApprovalId).toBe("plugin:first");
    });

    // A finished confirmation has nothing left to deliver, so an id on it would
    // be an address nobody will ever write to.
    it("ignores a confirmation that is already finished", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_gone" });
      await recordResolution({ toolCallId: "call_gone", decision: "timeout" });

      expect(await linkApproval({ approvalId: "plugin:late", toolCallId: "call_gone" })).toBeNull();
      const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
      expect(row.openclawApprovalId).toBeNull();
    });
  });

  /**
   * The decision route reads the approval id once, and a decision made in the
   * first moments of a confirmation gets there before the broadcast does — the
   * gate writes `approval.requested` inside gate-check, so the card is
   * actionable a full `plugin.approval.request` round trip before Pinchy learns
   * the id. Reporting "nothing is waiting" there is simply wrong: the run IS
   * parked, Pinchy just does not know its address yet.
   */
  describe("awaitApprovalLink", () => {
    it("returns the id the moment the broadcast records it", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_slow" });
      setTimeout(() => {
        void linkApproval({ approvalId: "plugin:late-but-real", toolCallId: "call_slow" });
      }, 60);

      expect(await awaitApprovalLink(r.requestId, { timeoutMs: 3000 })).toBe(
        "plugin:late-but-real"
      );
    });

    // The broadcast may genuinely never come — the bridge was down, Pinchy
    // restarted, or the row predates #1132. Waiting has to end in an honest
    // "no", not in a hung request.
    it("gives up rather than hanging when no broadcast ever arrives", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_never" });
      expect(await awaitApprovalLink(r.requestId, { timeoutMs: 150 })).toBeNull();
    });

    it("returns immediately when the id is already there", async () => {
      const r = await decideGate({ ...base(), toolCallId: "call_fast" });
      await linkApproval({ approvalId: "plugin:early", toolCallId: "call_fast" });
      expect(await awaitApprovalLink(r.requestId, { timeoutMs: 50 })).toBe("plugin:early");
    });
  });

  // A reused row must point at the call that is waiting NOW, not the one that
  // opened it. The same tool with the same arguments gets a fresh toolCallId on
  // every attempt, so a stale value would resolve an approval OpenClaw has
  // already discarded — the user clicks approve, sees a success toast, and the
  // run stays stuck on the attempt nobody resolved.
  it("re-points a reused pending request at the newest call", async () => {
    const r1 = await decideGate({ ...base(), toolCallId: "call_1" });
    const r2 = await decideGate({ ...base(), toolCallId: "call_2" });
    expect(r2.requestId).toBe(r1.requestId);
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r1.requestId));
    expect(row.toolCallId).toBe("call_2");
  });

  // The approval id has to move with the call id, for exactly the reason above.
  // OpenClaw mints one approval per attempt and discards the one before it, so
  // an id left over from the attempt that OPENED the row addresses an approval
  // that no longer exists — and `linkApproval` refuses to overwrite an id, so
  // the dead one would be permanent. Clearing it is what lets the next
  // broadcast land: it is not "the first approval wins", it is "the approval
  // for the call this row is pointing at wins".
  it("drops the previous attempt's approval id when a reused row is re-pointed", async () => {
    const r1 = await decideGate({ ...base(), toolCallId: "call_1" });
    await linkApproval({ approvalId: "plugin:1", toolCallId: "call_1" });

    await decideGate({ ...base(), toolCallId: "call_2" });

    const relinked = await linkApproval({ approvalId: "plugin:2", toolCallId: "call_2" });
    expect(relinked?.id).toBe(r1.requestId);
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r1.requestId));
    expect(row.openclawApprovalId).toBe("plugin:2");
  });

  it("allows and consumes exactly once after approval, then re-gates", async () => {
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });

    const allow = await decideGate(base());
    expect(allow.decision).toBe("allow");
    expect(allow.requestId).toBe(r.requestId);
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("consumed");
    expect(row.consumedAt).not.toBeNull();

    // Consumed ticket cannot be reused — the next call is gated afresh.
    const again = await decideGate(base());
    expect(again.decision).toBe("block");
    expect(again.requestId).not.toBe(r.requestId);
  });

  it("an approval for one tool is not consumable by a different tool with the same digest", async () => {
    // Two gated tools can legitimately receive identical params (e.g. the
    // odoo record-action family all take `{ target: <ref> }`), so the digest
    // alone must not be the binding — "one confirmation, one action" includes
    // the tool name.
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });

    const cross = await decideGate({ ...base(), toolName: "odoo_unlink" });
    expect(cross.decision).toBe("block");
    const [grant] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(grant.status).toBe("approved");

    // The original tool still consumes its own grant.
    const own = await decideGate(base());
    expect(own.decision).toBe("allow");
    expect(own.requestId).toBe(r.requestId);
  });

  it("pending requests are tool-specific even with identical args", async () => {
    const a = await decideGate(base());
    const b = await decideGate({ ...base(), toolName: "odoo_unlink" });
    expect(b.requestId).not.toBe(a.requestId);
    expect(await db.select().from(toolApproval)).toHaveLength(2);
  });

  it("changed args produce a different digest → a new confirmation", async () => {
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    const other = await decideGate({ ...base(), argsDigest: "digest-2" });
    expect(other.decision).toBe("block");
    expect(other.requestId).not.toBe(r.requestId);
  });

  it("fails closed on an expired approved ticket (does not consume it)", async () => {
    // Approve a live request, then let the grant expire before the agent
    // re-issues the call. (resolveDecision itself refuses already-expired
    // requests — see the not_pending test below — so expiry is injected
    // after the approval here.)
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    await db
      .update(toolApproval)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(toolApproval.id, r.requestId));
    const res = await decideGate(base());
    expect(res.decision).toBe("block");
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("approved");
  });

  it("consumes at most one ticket under concurrent retries", async () => {
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    const [a, b] = await Promise.all([decideGate(base()), decideGate(base())]);
    expect([a, b].filter((x) => x.decision === "allow")).toHaveLength(1);
  });

  it("resolveDecision forbids a non-requester under self-confirm", async () => {
    const r = await decideGate(base());
    const other = await seedUser();
    const res = await resolveDecision({
      id: r.requestId,
      approverId: other.id,
      decision: "approve",
      selfConfirmOnly: true,
    });
    expect(res).toEqual({ ok: false, reason: "forbidden" });
  });

  it("resolveDecision deny records reason + approver", async () => {
    const r = await decideGate(base());
    const res = await resolveDecision({
      id: r.requestId,
      approverId: requesterId,
      decision: "deny",
      reason: "not now",
    });
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("denied");
    expect(row.decisionReason).toBe("not now");
    expect(row.approverId).toBe(requesterId);
    expect(row.decidedAt).not.toBeNull();
  });

  it("resolveDecision reports not_found and not_pending", async () => {
    const nf = await resolveDecision({
      id: "00000000-0000-4000-8000-000000000000",
      approverId: requesterId,
      decision: "approve",
    });
    expect(nf).toEqual({ ok: false, reason: "not_found" });

    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    const np = await resolveDecision({
      id: r.requestId,
      approverId: requesterId,
      decision: "approve",
    });
    expect(np).toEqual({ ok: false, reason: "not_pending" });
  });

  it("resolveDecision refuses an expired pending request (fail-closed, sweep owns the flip)", async () => {
    // Approving an expired request would produce a dead grant (consume checks
    // expires_at) plus a success toast — refuse it up front instead.
    const r = await decideGate({ ...base(), ttlMs: -1000 });
    const res = await resolveDecision({
      id: r.requestId,
      approverId: requesterId,
      decision: "approve",
    });
    expect(res).toEqual({ ok: false, reason: "not_pending" });
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("pending");
    expect(row.approverId).toBeNull();
  });

  // Each distinct argsDigest mints its own row, and the block reason is a
  // prompt, not a schranke: a model that retries with a changed argument opens
  // one confirmation per attempt. That lands twice — a wall of cards in the
  // requester's inbox now, and one approval.expired audit row per request at
  // the next sweep, each of which takes the audit log's single advisory lock
  // (AGENTS.md §"An audit row … needs a bound").
  it("stops opening new confirmations once the requester is at the pending cap", async () => {
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
      await decideGate({ ...base(), argsDigest: `digest-${i}` });
    }
    const over = await decideGate({ ...base(), argsDigest: "one-too-many" });

    expect(over.decision).toBe("block");
    expect(over.limited).toBe(true);
    expect(over.created).toBe(false);
    expect(await db.select().from(toolApproval)).toHaveLength(MAX_PENDING_PER_REQUESTER);
  });

  it("still spends an approved ticket while the requester is at the cap", async () => {
    // The cap is backpressure on OPENING confirmations. Refusing to consume a
    // ticket the user already approved would strand the action they said yes
    // to — the one outcome worse than the wall of cards.
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
      await decideGate({ ...base(), argsDigest: `digest-${i}` });
    }
    const first = await decideGate({ ...base(), argsDigest: "digest-0" });
    await resolveDecision({ id: first.requestId, approverId: requesterId, decision: "approve" });
    // Back to the cap: approving moved digest-0 out of `pending`.
    await decideGate({ ...base(), argsDigest: "refill" });

    const allow = await decideGate({ ...base(), argsDigest: "digest-0" });
    expect(allow.decision).toBe("allow");
  });

  it("counts the cap per requester, not per agent", async () => {
    // Two people sharing an agent must not exhaust each other's budget — the
    // same reason a grant is never shared across them.
    const other = await seedUser();
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
      await decideGate({ ...base(), argsDigest: `digest-${i}` });
    }
    const theirs = await decideGate({
      ...base(),
      requesterId: other.id,
      argsDigest: "their-first",
    });
    expect(theirs.decision).toBe("block");
    expect(theirs.limited).toBeFalsy();
    expect(theirs.created).toBe(true);
  });

  it("expireStale flips overdue pending requests to expired and returns them", async () => {
    const r = await decideGate({ ...base(), ttlMs: -1000 });
    const flipped = await expireStale();
    expect(flipped.map((f) => f.id)).toContain(r.requestId);
    expect(flipped.find((f) => f.id === r.requestId)).toMatchObject({
      agentId,
      requesterId,
      toolName: "odoo_write",
      argsDigest: "digest-1",
    });
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("expired");
  });

  /**
   * #1132. The decision route covers the button. `onResolution` covers what the
   * runtime actually DID — including the outcomes no button produces, which is
   * where a confirmation would otherwise sit `pending` until the hourly sweep.
   */
  describe("recordResolution", () => {
    async function parked(toolCallId = "call_7") {
      const r = await decideGate({ ...base(), toolCallId });
      return r.requestId;
    }

    it("spends the grant when OpenClaw lets the call through", async () => {
      const id = await parked();
      await resolveDecision({ id, approverId: requesterId, decision: "approve" });

      const settled = await recordResolution({ toolCallId: "call_7", decision: "allow-once" });

      expect(settled).toMatchObject({ id, status: "consumed" });
      const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, id));
      expect(row.status).toBe("consumed");
      expect(row.consumedAt).toBeInstanceOf(Date);
    });

    // Nobody clicks a timeout, so without this the row stays pending and the
    // card stays in the inbox over a call that is already gone.
    it("closes a confirmation the run stopped waiting for", async () => {
      const id = await parked();

      const settled = await recordResolution({ toolCallId: "call_7", decision: "timeout" });

      expect(settled).toMatchObject({ id, status: "expired" });
    });

    it("closes a confirmation whose run was cancelled", async () => {
      const id = await parked();
      await recordResolution({ toolCallId: "call_7", decision: "cancelled" });
      const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, id));
      expect(row.status).toBe("expired");
    });

    // The decision route already flipped and audited this one. Reporting it a
    // second time must not produce a second audit row, so nothing comes back.
    it("does not re-settle a confirmation the user already decided", async () => {
      const id = await parked();
      await resolveDecision({ id, approverId: requesterId, decision: "deny" });

      expect(await recordResolution({ toolCallId: "call_7", decision: "deny" })).toBeNull();
      const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, id));
      expect(row.status).toBe("denied");
    });

    // The same broadcast carries OpenClaw's own approvals (skill workshop,
    // exec). Those name calls Pinchy never opened a row for.
    it("settles nothing for a call nobody was waiting on", async () => {
      expect(
        await recordResolution({ toolCallId: "call_not_ours", decision: "allow-once" })
      ).toBeNull();
    });

    // Same reason as `linkApproval` above: a provider that numbers tool calls
    // per response lets two sessions share an id, and settling on the id alone
    // would spend BOTH grants — writing `approval.consumed` for an action that
    // never ran, on a row the runtime said nothing about.
    it("spends only the grant from the session the runtime reported on", async () => {
      const mine = await parked("call_0");
      const theirs = await decideGate({
        ...base(),
        sessionKey: "agent:a:direct:someone-else",
        toolCallId: "call_0",
      });

      const settled = await recordResolution({
        toolCallId: "call_0",
        sessionKey: "agent:a:direct:u",
        decision: "allow-once",
      });

      expect(settled?.id).toBe(mine);
      const [other] = await db
        .select()
        .from(toolApproval)
        .where(eq(toolApproval.id, theirs.requestId));
      expect(other.status).toBe("pending");
    });

    it("still settles when the report names no session", async () => {
      const id = await parked("call_9");
      expect(await recordResolution({ toolCallId: "call_9", decision: "timeout" })).toMatchObject({
        id,
      });
    });
  });
});
