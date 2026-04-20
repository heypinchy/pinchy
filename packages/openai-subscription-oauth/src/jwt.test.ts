import { describe, it, expect } from "vitest";
import { extractAccountInfo } from "./jwt";

function makeJwt(payload: unknown): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
}

describe("extractAccountInfo", () => {
  it("extracts accountId and email from OpenAI-shaped id_token", () => {
    const jwt = makeJwt({ email: "x@y.com", "https://openai.com/auth": { user_id: "acc-9" } });
    expect(extractAccountInfo(jwt)).toEqual({ accountId: "acc-9", accountEmail: "x@y.com" });
  });

  it("throws when payload segment is missing", () => {
    expect(() => extractAccountInfo("only-one-segment")).toThrow(/invalid JWT/);
  });

  it("throws when custom auth claim is missing", () => {
    const jwt = makeJwt({ email: "x@y.com" });
    expect(() => extractAccountInfo(jwt)).toThrow(/missing expected claims/);
  });

  it("throws when email is missing", () => {
    const jwt = makeJwt({ "https://openai.com/auth": { user_id: "acc-9" } });
    expect(() => extractAccountInfo(jwt)).toThrow(/missing expected claims/);
  });
});
