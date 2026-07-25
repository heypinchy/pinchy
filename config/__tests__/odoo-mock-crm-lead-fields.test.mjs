import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// server.js is CommonJS and only auto-boots on the published Docker ports
// when run as a CLI (guarded by `require.main === module`). Importing it and
// calling `start()` with port 0 spins both servers up on ephemeral ports, so
// this runs hermetically under `node --test` without touching docker-compose.
const require = createRequire(import.meta.url);
const { start } = require("../odoo-mock/server.js");

// Defaults from the mock's authConfig (see /control/reset).
const DB = "testdb";
const UID = 2;
const API_KEY = "test-api-key";

async function jsonRpc(port, model, method, positionalArgs, kwArgs = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "call",
      params: {
        service: "object",
        method: "execute_kw",
        args: [DB, UID, API_KEY, model, method, positionalArgs, kwArgs],
      },
    }),
  });
  const body = await res.json();
  assert.equal(
    body.error,
    undefined,
    `unexpected JSON-RPC error: ${body.error?.message}`,
  );
  return body.result;
}

// The four crm.lead contact/revenue fields the Eval-v2 CRM scenarios write
// and grade (#803).
const CRM_LEAD_EXTRA_FIELDS = {
  email_from: "char",
  phone: "char",
  description: "text",
  expected_revenue: "float",
};

test("crm.lead contact and revenue fields round-trip and are listed by fields_get", async () => {
  const server = await start({
    jsonRpcPort: 0,
    controlPort: 0,
    host: "127.0.0.1",
  });
  const { jsonRpcPort, controlPort } = server;
  try {
    await fetch(`http://127.0.0.1:${controlPort}/control/reset`, {
      method: "POST",
    });

    // Seed a lead carrying all four fields.
    const seeded = {
      id: 501,
      name: "Seeded lead — Acme AG",
      type: "lead",
      email_from: "buyer@acme.example",
      phone: "+49 30 1234567",
      description: "Wants a quote for 40 seats by Friday.",
      expected_revenue: 12500.5,
    };
    const seedRes = await fetch(
      `http://127.0.0.1:${controlPort}/control/seed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "crm.lead", records: [seeded] }),
      },
    );
    assert.equal(seedRes.status, 200);

    // Create a lead with the same fields through the JSON-RPC path the
    // pinchy-odoo plugin uses.
    const created = {
      name: "Created lead — Beta GmbH",
      type: "opportunity",
      email_from: "cto@beta.example",
      phone: "+43 1 7654321",
      description: "Follow-up after the webinar.",
      expected_revenue: 8000,
    };
    const newId = await jsonRpc(jsonRpcPort, "crm.lead", "create", [created]);
    assert.equal(typeof newId, "number");

    // All fields round-trip via the control read-back used by the eval grader.
    const records = await (
      await fetch(
        `http://127.0.0.1:${controlPort}/control/records?model=crm.lead`,
      )
    ).json();
    const seededBack = records.find((r) => r.id === seeded.id);
    const createdBack = records.find((r) => r.id === newId);
    assert.ok(seededBack, "seeded crm.lead not found in read-back");
    assert.ok(createdBack, "created crm.lead not found in read-back");
    for (const field of Object.keys(CRM_LEAD_EXTRA_FIELDS)) {
      assert.equal(seededBack[field], seeded[field], `seeded ${field}`);
      assert.equal(createdBack[field], created[field], `created ${field}`);
    }

    // fields_get lists all four with the right types.
    const schema = await jsonRpc(jsonRpcPort, "crm.lead", "fields_get", []);
    for (const [field, type] of Object.entries(CRM_LEAD_EXTRA_FIELDS)) {
      assert.ok(field in schema, `fields_get missing ${field}`);
      assert.equal(schema[field].type, type, `fields_get type of ${field}`);
      assert.equal(typeof schema[field].string, "string");
    }
  } finally {
    await server.stop();
  }
});

// `/control/clear` is the mock's only way to reach an EMPTY model that has
// demo defaults (`/control/seed` appends, `/control/reset` restores them). The
// eval harness depends on it to keep its graded read-back free of demo rows
// (pinchy#803, eval/run-eval.ts `EVAL_CLEARED_READBACK_MODELS`), so the
// endpoint's own contract is pinned here, next to the mock it belongs to.
test("POST /control/clear empties exactly one model and rejects a bodyless call", async () => {
  const server = await start({
    jsonRpcPort: 0,
    controlPort: 0,
    host: "127.0.0.1",
  });
  const { controlPort } = server;
  const records = async (model) =>
    (
      await fetch(
        `http://127.0.0.1:${controlPort}/control/records?model=${model}`,
      )
    ).json();
  try {
    await fetch(`http://127.0.0.1:${controlPort}/control/reset`, {
      method: "POST",
    });

    // The default catalog ships demo crm.lead rows — the very leak the eval
    // reset exists to close. Assert they are really there first, so a future
    // catalog change that drops them turns this test red rather than making
    // the clear assertion below pass vacuously.
    assert.ok(
      (await records("crm.lead")).length > 0,
      "expected demo crm.lead defaults",
    );
    const otherBefore = await records("sale.order");
    assert.ok(otherBefore.length > 0, "expected demo sale.order defaults");

    const clearRes = await fetch(
      `http://127.0.0.1:${controlPort}/control/clear`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "crm.lead" }),
      },
    );
    assert.equal(clearRes.status, 200);
    assert.deepEqual(await clearRes.json(), {
      status: "cleared",
      model: "crm.lead",
    });
    assert.deepEqual(await records("crm.lead"), []);
    // Scoped to the named model — other suites' defaults are untouched.
    assert.deepEqual(await records("sale.order"), otherBefore);

    // Clearing a model the store has never seen is a no-op, not a crash.
    const unknownRes = await fetch(
      `http://127.0.0.1:${controlPort}/control/clear`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "x.never.seen" }),
      },
    );
    assert.equal(unknownRes.status, 200);
    assert.deepEqual(await records("x.never.seen"), []);

    // A missing model is a client error, not a silent full wipe.
    const badRes = await fetch(
      `http://127.0.0.1:${controlPort}/control/clear`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(badRes.status, 400);
    assert.deepEqual(await records("sale.order"), otherBefore);

    // `/control/reset` restores the defaults a clear removed — the clear is
    // per-run state, not a permanent mutation of the catalog.
    await fetch(`http://127.0.0.1:${controlPort}/control/reset`, {
      method: "POST",
    });
    assert.ok(
      (await records("crm.lead")).length > 0,
      "reset must restore the demo defaults",
    );
  } finally {
    await server.stop();
  }
});
