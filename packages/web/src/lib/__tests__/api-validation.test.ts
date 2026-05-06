import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { parseRequestBody } from "../api-validation";

function makeRequest(body: string | object | undefined, contentType = "application/json") {
  const init: RequestInit = { method: "POST", headers: { "content-type": contentType } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new NextRequest("http://localhost/api/test", init);
}

describe("parseRequestBody", () => {
  const schema = z.object({ name: z.string().min(1), count: z.number().int() });

  it("returns parsed data on valid input", async () => {
    const req = makeRequest({ name: "Pinchy", count: 5 });
    const result = await parseRequestBody(schema, req);
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data).toEqual({ name: "Pinchy", count: 5 });
    }
  });

  it("strips unknown fields by default (zod object behavior)", async () => {
    const req = makeRequest({ name: "Pinchy", count: 5, evil: "<script>" });
    const result = await parseRequestBody(schema, req);
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data).toEqual({ name: "Pinchy", count: 5 });
    }
  });

  it("returns 400 with details on schema mismatch", async () => {
    const req = makeRequest({ name: "", count: "not a number" });
    const result = await parseRequestBody(schema, req);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(400);
      const json = await result.error.json();
      expect(json.error).toBe("Validation failed");
      expect(json.details).toBeDefined();
      expect(json.details.fieldErrors).toBeDefined();
    }
  });

  it("returns 400 on missing required fields", async () => {
    const req = makeRequest({});
    const result = await parseRequestBody(schema, req);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(400);
    }
  });

  it("returns 400 on malformed JSON instead of throwing 500", async () => {
    const req = makeRequest("{not valid json");
    const result = await parseRequestBody(schema, req);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(400);
      const json = await result.error.json();
      expect(json.error).toBe("Invalid JSON body");
    }
  });

  it("returns 400 on non-object body when schema expects object", async () => {
    const req = makeRequest('"just a string"');
    const result = await parseRequestBody(schema, req);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(400);
    }
  });

  it("returns 400 on empty body", async () => {
    const req = makeRequest(undefined);
    const result = await parseRequestBody(schema, req);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(400);
      const json = await result.error.json();
      expect(json.error).toBe("Invalid JSON body");
    }
  });
});
