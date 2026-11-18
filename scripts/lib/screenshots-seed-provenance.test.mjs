import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  findUnexplainedSeedUsers,
  parseInserts,
} from "./screenshots-seed-provenance.mjs";

const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../screenshots/seed.sh",
);

// ─── the real seed ───────────────────────────────────────────────────────────

test("every user screenshots/seed.sh inserts directly has a claimed invite", () => {
  // Otherwise Settings → Users flags them as accounts nobody invited, and the
  // release capture photographs that banner into user-management.png.
  const { users, unexplained } = findUnexplainedSeedUsers(
    readFileSync(SEED, "utf8"),
  );
  assert.ok(
    users.length >= 3,
    `expected the seed's demo team, found ${users.length} direct user inserts — has the parser stopped reading seed.sh?`,
  );
  assert.deepEqual(unexplained, []);
});

// ─── the parser ──────────────────────────────────────────────────────────────

const USERS = `
INSERT INTO "user" (id, name, email, role, created_at) VALUES
  ('usr_a', 'A', 'a@x', 'admin', NOW() - interval '1 day'),
  ('usr_b', 'B', 'b@x', 'member', NOW())
ON CONFLICT (email) DO NOTHING;
`;

function invites(rows) {
  return `
-- comment line with (parens, and 'quotes
INSERT INTO invites (id, token_hash, type, created_by, claimed_at, claimed_by_user_id) VALUES
${rows.join(",\n")}
ON CONFLICT DO NOTHING;
`;
}

test("flags a seeded user with no claimed invite", () => {
  const { unexplained } = findUnexplainedSeedUsers(
    USERS +
      invites([
        `('i1', 'h1', 'invite', (SELECT id FROM "user" WHERE email = 'm@x'), NOW(), 'usr_a')`,
      ]),
  );
  assert.deepEqual(unexplained, ["usr_b"]);
});

test("does not count a claimed reset invite as an origin", () => {
  const { unexplained } = findUnexplainedSeedUsers(
    USERS +
      invites([
        `('i1', 'h1', 'invite', 'm', NOW(), 'usr_a')`,
        `('i2', 'h2', 'reset', 'm', NOW(), 'usr_b')`,
      ]),
  );
  assert.deepEqual(unexplained, ["usr_b"]);
});

test("does not count an unclaimed invite as an origin", () => {
  const { unexplained } = findUnexplainedSeedUsers(
    USERS +
      invites([
        `('i1', 'h1', 'invite', 'm', NOW(), 'usr_a')`,
        `('i2', 'h2', 'invite', 'm', NULL, 'usr_b')`,
      ]),
  );
  assert.deepEqual(unexplained, ["usr_b"]);
});

test("passes when every seeded user claimed an invite", () => {
  const { users, unexplained } = findUnexplainedSeedUsers(
    USERS +
      invites([
        `('i1', 'h1', 'invite', 'm', NOW() - interval '2 days', 'usr_a')`,
        `('i2', 'h2', 'invite', 'm', NOW(), 'usr_b')`,
      ]),
  );
  assert.deepEqual(users, ["usr_a", "usr_b"]);
  assert.deepEqual(unexplained, []);
});

test("reads a sub-select value as one column, not as the end of the row", () => {
  const rows = parseInserts(
    invites([
      `('i1', 'h1', 'invite', (SELECT id FROM "user" WHERE email = 'm@x'), NOW(), 'usr_a')`,
    ]),
    "invites",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claimed_by_user_id, "'usr_a'");
});

test("throws on a row whose value count does not match its columns", () => {
  assert.throws(
    () => parseInserts(invites([`('i1', 'h1', 'invite')`]), "invites"),
    /6 columns but 3 values/,
  );
});
