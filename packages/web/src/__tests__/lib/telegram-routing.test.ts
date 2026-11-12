import { describe, expect, it } from "vitest";
import { personalAgentsByOwner, telegramDirectTarget } from "@/lib/telegram-routing";

describe("telegram-routing", () => {
  const agents = [
    { id: "smithers-owner", isPersonal: true, ownerId: "owner-1" },
    { id: "smithers-alice", isPersonal: true, ownerId: "alice" },
    { id: "shared-1", isPersonal: false, ownerId: "owner-1" },
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

  it("sends a linked user's messages to a personal-agent bot to their own agent", () => {
    expect(
      telegramDirectTarget({ id: "smithers-owner", isPersonal: true }, "alice", personal)
    ).toBe("smithers-alice");
  });

  it("falls back to the bot's own agent for a user without a personal agent", () => {
    expect(telegramDirectTarget({ id: "smithers-owner", isPersonal: true }, "bob", personal)).toBe(
      "smithers-owner"
    );
  });

  it("sends everyone writing to a shared agent's bot to that agent", () => {
    expect(telegramDirectTarget({ id: "shared-1", isPersonal: false }, "alice", personal)).toBe(
      "shared-1"
    );
  });
});
