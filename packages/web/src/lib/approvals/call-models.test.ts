import { describe, it, expect, beforeAll } from "vitest";
import { createCipheriv, randomBytes } from "crypto";
import { collectCallModels, makeRefResolver } from "./call-models";
// The pinchy-odoo encoder, imported across the package boundary on purpose:
// this file is the drift guard for the ref format. `call-models.ts` reimplements
// the decode half (the plugin's copy reads a container path for its key, which
// pinchy-web has no business touching), and a textual comparison would not
// notice a changed IV length or cipher. A round trip does, immediately.
import { encodeRef, _resetKeyCacheForTest } from "../../../../plugins/pinchy-odoo/integration-ref";

const KEY = "a".repeat(64);

beforeAll(() => {
  process.env.PINCHY_REF_TOKEN_KEY = KEY;
  _resetKeyCacheForTest();
});

const ref = (model: string, id = 42) =>
  encodeRef({ integrationType: "odoo", connectionId: "c1", model, id, label: `${model}/${id}` });

describe("collectCallModels", () => {
  it("reads an explicit model parameter", () => {
    expect(collectCallModels({ model: "account.move", ids: [1] }, KEY)).toEqual(["account.move"]);
  });

  it("returns nothing for a call that names no resource", () => {
    expect(collectCallModels({ to: "ada@example.com" }, KEY)).toEqual([]);
    expect(collectCallModels({}, KEY)).toEqual([]);
    expect(collectCallModels(undefined, KEY)).toEqual([]);
  });

  it("reads the model out of an opaque ref", () => {
    expect(collectCallModels({ target: ref("sale.order") }, KEY)).toEqual(["sale.order"]);
  });

  // odoo_reconcile takes two refs and touches both models. Reading only the
  // first would let a grant for the payment satisfy a gated invoice.
  it("reads every ref in a multi-ref call", () => {
    const params = { moveRef: ref("account.move"), counterpartRef: ref("account.payment") };
    expect(collectCallModels(params, KEY).sort()).toEqual(["account.move", "account.payment"]);
  });

  it("finds refs nested in objects and arrays", () => {
    const params = {
      batch: [{ target: ref("stock.picking") }],
      meta: { other: ref("mrp.production") },
    };
    expect(collectCallModels(params, KEY).sort()).toEqual(["mrp.production", "stock.picking"]);
  });

  // A model garbles a ref often enough that pinchy-odoo has a dedicated error
  // class for it. The gate must not read "no model in play" out of that — the
  // call still touches SOMETHING. `null` is a resource we cannot name, which
  // `resolveConfirmation` resolves to the tool-level setting rather than allow.
  it("reports an undecodable ref as an unnamed resource, not as none", () => {
    expect(collectCallModels({ target: "pinchy_ref:v1:garbled" }, KEY)).toEqual([null]);
  });

  it("reports every resource when only some refs decode", () => {
    const params = { a: ref("account.move"), b: "pinchy_ref:v1:garbled" };
    expect(collectCallModels(params, KEY)).toEqual(["account.move", null]);
  });

  // Not a ref, not a model — a plain string must not be mistaken for either.
  it("ignores strings that are not refs", () => {
    expect(collectCallModels({ note: "pinchy_ref is a thing we use" }, KEY)).toEqual([]);
  });

  it("reports refs as unnamed when no key is configured", () => {
    expect(collectCallModels({ target: ref("sale.order") }, null)).toEqual([null]);
  });

  it("combines an explicit model with a ref in the same call", () => {
    const params = { model: "ir.attachment", targetRef: ref("account.move") };
    expect(collectCallModels(params, KEY).sort()).toEqual(["account.move", "ir.attachment"]);
  });
});

describe("makeRefResolver", () => {
  it("names the model, id and label a ref points at, so the card can say what it acts on", () => {
    expect(makeRefResolver(KEY)(ref("account.move"))).toEqual({
      model: "account.move",
      id: 42,
      label: "account.move/42",
    });
  });

  it("tells two records of the same model apart", () => {
    const resolve = makeRefResolver(KEY);
    expect(resolve(ref("account.move", 42))).not.toEqual(resolve(ref("account.move", 43)));
  });

  it("answers null for a garbled ref or a missing key, rather than guessing", () => {
    expect(makeRefResolver(KEY)("pinchy_ref:v1:garbled")).toBeNull();
    expect(makeRefResolver(null)(ref("account.move"))).toBeNull();
  });

  // pinchy-odoo refuses a payload whose id is not a positive integer, so the
  // tool would not run on it — naming a record for it would describe nothing.
  it("answers null for a payload the plugin itself would refuse", () => {
    // encodeRef validates, so a payload it would refuse is sealed by hand —
    // in the same layout (iv | tag | ciphertext) the round trip above pins.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
    const body = JSON.stringify({ integrationType: "odoo", model: "account.move", id: 1.5 });
    const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    const bad = `pinchy_ref:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
    // The gate still reads the model out of it — a resource is involved.
    expect(collectCallModels({ target: bad }, KEY)).toEqual(["account.move"]);
    expect(makeRefResolver(KEY)(bad)).toBeNull();
  });
});
