import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("server.ts writes a variable-only audit key to the key file at startup", () => {
  // persistEnvSecretToKeyFile is what makes a later switch of AUDIT_HMAC_SECRET
  // keep the old key as the earlier key. Unit tests prove the function; this
  // proves it runs. Without the call, the docs promise ("handled after one
  // boot of this version") would be true of a function nobody invokes.
  const serverSource = fs.readFileSync(path.resolve(__dirname, "../../../server.ts"), "utf8");

  it("calls persistEnvSecretToKeyFile for the audit secret and logs the outcome", () => {
    expect(serverSource).toContain('persistEnvSecretToKeyFile("audit_hmac_secret")');
    expect(serverSource).toContain("describeAuditKeyFilePersist(");
  });

  it("runs before the key-switch notice, which reads the same file", () => {
    const persistAt = serverSource.indexOf('persistEnvSecretToKeyFile("audit_hmac_secret")');
    const rotationAt = serverSource.indexOf("evaluateAuditSecretRotation({");
    expect(persistAt).toBeGreaterThan(-1);
    expect(rotationAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(rotationAt);
  });
});
