import { describe, expect, it } from "vitest";
import { personalAgentsByOwner, telegramDirectTarget } from "@/lib/telegram-routing";

describe("telegram-routing", () => {
  const at = (iso: string) => new Date(iso);
  const agents = [
    { id: "smithers-owner", isPersonal: true, ownerId: "owner-1", createdAt: at("2026-01-01") },
    { id: "smithers-alice", isPersonal: true, ownerId: "alice", createdAt: at("2026-02-01") },
    { id: "shared-1", isPersonal: false, ownerId: "owner-1", createdAt: at("2026-03-01") },
  ];
  const personal = personalAgentsByOwner(agents);

  it("maps each owner to their personal agent and ignores shared agents", () => {
    expect(personal).toEqual(
      new Map([
        ["owner-1", "smithers-owner"],
        ["alice", "smithers-alice"],
      ])
    );
  });

  // Nothing in the schema stops an owner from having two personal agents (two
  // concurrent seedPersonalAgent runs both find none). The config builder and
  // the allow store read the agents in separate, unordered queries; picked by
  // order, they could disagree, and the allow store would hold the user back
  // for good. The oldest one wins, whichever order the rows come in.
  it("picks an owner's oldest personal agent, whatever order the rows come in", () => {
    const original = {
      id: "smithers-b",
      isPersonal: true,
      ownerId: "alice",
      createdAt: at("2026-02-01"),
    };
    const duplicate = {
      id: "smithers-a",
      isPersonal: true,
      ownerId: "alice",
      createdAt: at("2026-02-02"),
    };

    expect(personalAgentsByOwner([original, duplicate]).get("alice")).toBe("smithers-b");
    expect(personalAgentsByOwner([duplicate, original]).get("alice")).toBe("smithers-b");
  });

  it("sends a linked user's messages to a personal-agent bot to their own agent", () => {
    expect(
      telegramDirectTarget({ id: "smithers-owner", isPersonal: true }, "alice", personal)
    ).toBe("smithers-alice");
  });

  // The bot's own agent is its owner's private one. Handing it to someone
  // without a personal agent of their own would let them talk to it.
  it("gives a user without a personal agent no route on a personal-agent bot", () => {
    expect(telegramDirectTarget({ id: "smithers-owner", isPersonal: true }, "bob", personal)).toBe(
      null
    );
  });

  it("routes the bot's owner to the bot's own agent", () => {
    expect(
      telegramDirectTarget({ id: "smithers-owner", isPersonal: true }, "owner-1", personal)
    ).toBe("smithers-owner");
  });

  it("sends everyone writing to a shared agent's bot to that agent", () => {
    expect(telegramDirectTarget({ id: "shared-1", isPersonal: false }, "alice", personal)).toBe(
      "shared-1"
    );
  });
});
