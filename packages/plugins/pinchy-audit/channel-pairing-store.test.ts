// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPairingFindByCodeMethod,
  createPairingRemoveRequestsMethod,
  createPairingSetAllowFromMethod,
  findPairingRequestByCode,
  removePairingRequests,
  setPairingAllowFrom,
} from "./channel-pairing-store";

// The two tables as OpenClaw 2026.9.2 creates them in
// `<stateDir>/state/openclaw.sqlite` (copied from its OPENCLAW_STATE_SCHEMA_SQL).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS channel_pairing_requests (
    channel_key TEXT NOT NULL,
    account_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    meta_json TEXT,
    PRIMARY KEY (channel_key, account_id, request_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS channel_pairing_allow_entries (
    channel_key TEXT NOT NULL,
    account_id TEXT NOT NULL,
    entry TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (channel_key, account_id, entry)
  ) STRICT;
`;

let stateDir: string;

function dbPath(): string {
  return join(stateDir, "state", "openclaw.sqlite");
}

function seed(fn: (db: DatabaseSync) => void): void {
  mkdirSync(join(stateDir, "state"), { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec(SCHEMA);
  fn(db);
  db.close();
}

function addRequest(
  db: DatabaseSync,
  channel: string,
  accountId: string,
  requestId: string,
  code: string,
  createdAt = "2026-11-12T10:00:00.000Z",
  lastSeenAt = createdAt
): void {
  db.prepare(
    "insert into channel_pairing_requests (channel_key, account_id, request_id, code, created_at, last_seen_at, meta_json) values (?, ?, ?, ?, ?, ?, ?)"
  ).run(channel, accountId, requestId, code, createdAt, lastSeenAt, JSON.stringify({ accountId }));
}

function addAllow(db: DatabaseSync, channel: string, accountId: string, entries: string[]): void {
  entries.forEach((entry, i) =>
    db
      .prepare(
        "insert into channel_pairing_allow_entries (channel_key, account_id, entry, sort_order, updated_at) values (?, ?, ?, ?, 0)"
      )
      .run(channel, accountId, entry, i)
  );
}

function allowRows(): Array<{ channel_key: string; account_id: string; entry: string }> {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return db
      .prepare(
        "select channel_key, account_id, entry from channel_pairing_allow_entries order by channel_key, account_id, sort_order"
      )
      .all() as Array<{ channel_key: string; account_id: string; entry: string }>;
  } finally {
    db.close();
  }
}

function requestIds(): string[] {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return (
      db
        .prepare("select request_id from channel_pairing_requests order by request_id")
        .all() as Array<{ request_id: string }>
    ).map((r) => r.request_id);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pinchy-audit-pairing-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("findPairingRequestByCode", () => {
  it("finds the request a code belongs to, ignoring the code's case", () => {
    seed((db) => {
      addRequest(db, "telegram", "bot-a", "111", "ABCD1234", "2026-11-12T10:00:00.000Z");
      addRequest(db, "telegram", "bot-a", "222", "WXYZ9876");
    });

    expect(findPairingRequestByCode({ stateDir, channel: "telegram", code: "abcd1234" })).toEqual({
      id: "111",
      code: "ABCD1234",
      accountId: "bot-a",
      createdAt: "2026-11-12T10:00:00.000Z",
      lastSeenAt: "2026-11-12T10:00:00.000Z",
    });
  });

  it("does not answer with another channel's request", () => {
    seed((db) => addRequest(db, "whatsapp", "default", "111", "ABCD1234"));

    expect(findPairingRequestByCode({ stateDir, channel: "telegram", code: "ABCD1234" })).toBe(
      null
    );
  });

  it("answers null when OpenClaw has not created its state database yet, without creating it", () => {
    expect(findPairingRequestByCode({ stateDir, channel: "telegram", code: "ABCD1234" })).toBe(
      null
    );
    expect(existsSync(dbPath())).toBe(false);
  });
});

describe("removePairingRequests", () => {
  it("removes the user's requests on every bot of the channel and keeps the rest", () => {
    seed((db) => {
      addRequest(db, "telegram", "bot-a", "111", "AAAA1111");
      addRequest(db, "telegram", "bot-b", "111", "BBBB2222");
      addRequest(db, "telegram", "bot-a", "222", "CCCC3333");
      addRequest(db, "whatsapp", "default", "111", "DDDD4444");
    });

    expect(removePairingRequests({ stateDir, channel: "telegram", requestId: "111" })).toBe(2);
    expect(requestIds()).toEqual(["111", "222"]);
  });

  it("removes nothing when OpenClaw has no state database", () => {
    expect(removePairingRequests({ stateDir, channel: "telegram", requestId: "111" })).toBe(0);
    expect(existsSync(dbPath())).toBe(false);
  });
});

describe("setPairingAllowFrom", () => {
  it("replaces the whole channel's allow list, lowercasing account ids the way OpenClaw reads them", () => {
    seed((db) => {
      addAllow(db, "telegram", "stale-bot", ["999"]);
      addAllow(db, "telegram", "bot-a", ["111"]);
      addAllow(db, "whatsapp", "default", ["+43"]);
    });

    setPairingAllowFrom({
      stateDir,
      channel: "telegram",
      allowFrom: { "Bot-A": ["111", "222"], "bot-b": [] },
      replaceAll: true,
    });

    expect(allowRows()).toEqual([
      { channel_key: "telegram", account_id: "bot-a", entry: "111" },
      { channel_key: "telegram", account_id: "bot-a", entry: "222" },
      { channel_key: "whatsapp", account_id: "default", entry: "+43" },
    ]);
  });

  it("replaces only the named accounts when not replacing the whole channel", () => {
    seed((db) => {
      addAllow(db, "telegram", "bot-a", ["111"]);
      addAllow(db, "telegram", "bot-b", ["222"]);
    });

    setPairingAllowFrom({
      stateDir,
      channel: "telegram",
      allowFrom: { "bot-a": [] },
      replaceAll: false,
    });

    expect(allowRows()).toEqual([{ channel_key: "telegram", account_id: "bot-b", entry: "222" }]);
  });

  it("drops blanks, duplicates and the wildcard, as OpenClaw does when it writes", () => {
    seed(() => {});

    setPairingAllowFrom({
      stateDir,
      channel: "telegram",
      allowFrom: { "bot-a": ["111", " 111 ", "", "*", "222"] },
      replaceAll: true,
    });

    expect(allowRows().map((r) => r.entry)).toEqual(["111", "222"]);
  });

  it("leaves the store untouched when a write fails partway", () => {
    seed((db) => addAllow(db, "telegram", "bot-a", ["111"]));

    expect(() =>
      setPairingAllowFrom({
        stateDir,
        channel: "telegram",
        allowFrom: { "bot-a": ["222"], "bot-b": [42 as unknown as string] },
        replaceAll: true,
      })
    ).toThrow();
    expect(allowRows()).toEqual([{ channel_key: "telegram", account_id: "bot-a", entry: "111" }]);
  });

  it("refuses to write when OpenClaw has not created its state database", () => {
    expect(() =>
      setPairingAllowFrom({ stateDir, channel: "telegram", allowFrom: {}, replaceAll: true })
    ).toThrow(/state database/);
    expect(existsSync(dbPath())).toBe(false);
  });
});

describe("gateway handlers", () => {
  function call(handler: (opts: never) => void, params: Record<string, unknown>) {
    const respond = vi.fn();
    handler({ params, respond } as never);
    return respond;
  }

  it("pinchy.pairing.findByCode answers with the request", () => {
    seed((db) => addRequest(db, "telegram", "bot-a", "111", "ABCD1234"));

    const respond = call(
      createPairingFindByCodeMethod(() => stateDir),
      {
        channel: "telegram",
        code: "ABCD1234",
      }
    );

    expect(respond).toHaveBeenCalledWith(true, {
      request: expect.objectContaining({ id: "111", accountId: "bot-a" }),
    });
  });

  it("pinchy.pairing.removeRequests answers with how many it removed", () => {
    seed((db) => addRequest(db, "telegram", "bot-a", "111", "ABCD1234"));

    const respond = call(
      createPairingRemoveRequestsMethod(() => stateDir),
      {
        channel: "telegram",
        requestId: "111",
      }
    );

    expect(respond).toHaveBeenCalledWith(true, { removed: 1 });
  });

  const noRoute = () => {
    throw new Error("no route expected in this test");
  };

  it("pinchy.pairing.setAllowFrom writes the map", () => {
    seed(() => {});

    const respond = call(
      createPairingSetAllowFromMethod(() => stateDir, noRoute),
      {
        channel: "telegram",
        allowFrom: { "bot-a": ["111"] },
        replaceAll: true,
      }
    );

    expect(respond).toHaveBeenCalledWith(true, { accounts: 1, withheld: [] });
    expect(allowRows()).toEqual([{ channel_key: "telegram", account_id: "bot-a", entry: "111" }]);
  });

  describe("pinchy.pairing.setAllowFrom with routeTo", () => {
    // OpenClaw's own answer for where a direct message from `peerId` to bot
    // `accountId` goes, as its routing would give it for the live config.
    function routes(table: Record<string, string>) {
      return vi.fn(({ accountId, peerId }: { accountId: string; peerId: string }) => {
        const agentId = table[`${accountId}/${peerId}`];
        if (!agentId) throw new Error(`No agent binding for ${accountId}/${peerId}`);
        return agentId;
      });
    }

    it("writes a sender only once OpenClaw routes them to the agent Pinchy meant", () => {
      seed(() => {});
      const resolveRoute = routes({ "bot-a/111": "agent-alice", "bot-a/222": "agent-owner" });

      const respond = call(
        createPairingSetAllowFromMethod(() => stateDir, resolveRoute),
        {
          channel: "telegram",
          allowFrom: { "bot-a": ["111", "222"] },
          routeTo: { "bot-a": { "111": "agent-alice", "222": "agent-bob" } },
          replaceAll: true,
        }
      );

      expect(resolveRoute).toHaveBeenCalledWith({
        channel: "telegram",
        accountId: "bot-a",
        peerId: "111",
      });
      expect(respond).toHaveBeenCalledWith(true, {
        accounts: 1,
        withheld: [{ accountId: "bot-a", peerId: "222" }],
      });
      expect(allowRows()).toEqual([{ channel_key: "telegram", account_id: "bot-a", entry: "111" }]);
    });

    it("withholds a sender OpenClaw cannot route at all", () => {
      seed(() => {});

      const respond = call(
        createPairingSetAllowFromMethod(() => stateDir, routes({})),
        {
          channel: "telegram",
          allowFrom: { "bot-a": ["111"] },
          routeTo: { "bot-a": { "111": "agent-alice" } },
          replaceAll: true,
        }
      );

      expect(respond).toHaveBeenCalledWith(true, {
        accounts: 1,
        withheld: [{ accountId: "bot-a", peerId: "111" }],
      });
      expect(allowRows()).toEqual([]);
    });

    it("compares agent ids the way OpenClaw normalises them", () => {
      seed(() => {});

      const respond = call(
        createPairingSetAllowFromMethod(() => stateDir, routes({ "Bot-A/111": "agent-alice" })),
        {
          channel: "telegram",
          allowFrom: { "Bot-A": [" 111 "] },
          routeTo: { "Bot-A": { "111": " Agent-Alice " } },
          replaceAll: true,
        }
      );

      expect(respond).toHaveBeenCalledWith(true, { accounts: 1, withheld: [] });
      expect(allowRows()).toEqual([{ channel_key: "telegram", account_id: "bot-a", entry: "111" }]);
    });

    it("writes senders without an expected route as they are", () => {
      seed(() => {});
      const resolveRoute = routes({});

      const respond = call(
        createPairingSetAllowFromMethod(() => stateDir, resolveRoute),
        {
          channel: "telegram",
          allowFrom: { "bot-a": ["111"] },
          routeTo: {},
          replaceAll: true,
        }
      );

      expect(resolveRoute).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(true, { accounts: 1, withheld: [] });
      expect(allowRows()).toEqual([{ channel_key: "telegram", account_id: "bot-a", entry: "111" }]);
    });

    it("refuses a routeTo that is not a map of maps of agent ids", () => {
      const respond = call(
        createPairingSetAllowFromMethod(() => stateDir, routes({})),
        {
          channel: "telegram",
          allowFrom: {},
          routeTo: { "bot-a": ["agent-alice"] },
          replaceAll: true,
        }
      );

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" })
      );
    });
  });

  it.each([
    ["findByCode without a code", createPairingFindByCodeMethod, { channel: "telegram" }],
    [
      "removeRequests without a requestId",
      createPairingRemoveRequestsMethod,
      { channel: "telegram" },
    ],
    [
      "setAllowFrom with a list that is not a map of string arrays",
      createPairingSetAllowFromMethod,
      { channel: "telegram", allowFrom: { "bot-a": "111" }, replaceAll: true },
    ],
    [
      "setAllowFrom without replaceAll",
      createPairingSetAllowFromMethod,
      { channel: "telegram", allowFrom: {} },
    ],
    ["a missing channel", createPairingFindByCodeMethod, { code: "ABCD1234" }],
  ])("refuses %s as an invalid request", (_label, factory, params) => {
    const respond = call(
      factory(() => stateDir, noRoute),
      params
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" })
    );
  });

  it("answers UNAVAILABLE when the store cannot be written", () => {
    const respond = call(
      createPairingSetAllowFromMethod(() => stateDir, noRoute),
      {
        channel: "telegram",
        allowFrom: {},
        replaceAll: true,
      }
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" })
    );
  });
});
