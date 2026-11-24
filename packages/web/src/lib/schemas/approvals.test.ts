import { describe, it, expect } from "vitest";
import { gateCheckSchema } from "./approvals";

/**
 * zod's `z.record` rebuilds the object by assignment, and `out["__proto__"] = …`
 * hits the prototype setter: the key silently disappears. The digest and the card
 * would then describe a call without it, while the tool — which got the raw JSON
 * — could still read it.
 */
describe("gateCheckSchema params", () => {
  const body = (params: string) =>
    JSON.parse(`{"agentId":"a1","toolName":"email_send","params":${params}}`);

  it("keeps a top-level __proto__ key as an own key", () => {
    const parsed = gateCheckSchema.parse(body('{"to":"a@x.at","__proto__":{"bcc":"e@x.com"}}'));
    expect(Object.keys(parsed.params)).toEqual(["to", "__proto__"]);
    expect(Object.getOwnPropertyDescriptor(parsed.params, "__proto__")?.value).toEqual({
      bcc: "e@x.com",
    });
  });

  it("still defaults to an empty object and refuses a non-object", () => {
    expect(gateCheckSchema.parse({ agentId: "a1", toolName: "t" }).params).toEqual({});
    for (const bad of ["[1]", '"x"', "3", "null"]) {
      expect(gateCheckSchema.safeParse(body(bad)).success, bad).toBe(false);
    }
  });
});
