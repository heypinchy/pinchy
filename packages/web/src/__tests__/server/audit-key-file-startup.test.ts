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

describe("the host-run E2E server has somewhere to write the audit key file", () => {
  // playwright.config.ts starts server.ts on the host with AUDIT_HMAC_SECRET
  // set. Without ENCRYPTION_KEY_DIR the key directory defaults to /app/secrets,
  // which does not exist on a developer machine or a CI runner, so every E2E
  // start logged "Could not write the AUDIT_HMAC_SECRET value": a warning that
  // is real in production, trained away as noise in the suite.
  const command = (() => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../playwright.config.ts"),
      "utf8"
    );
    const match = source.match(/command:\s*"([^"]+)"/);
    if (!match) throw new Error("playwright.config.ts: webServer command not found");
    return match[1];
  })();

  it("sets ENCRYPTION_KEY_DIR to a directory it creates, alongside AUDIT_HMAC_SECRET", () => {
    expect(command).toMatch(/\bAUDIT_HMAC_SECRET=/);
    const dir = command.match(/\bENCRYPTION_KEY_DIR=(\S+)/)?.[1];
    expect(dir).toBeDefined();
    expect(dir).not.toBe("/app/secrets");
    // The directory has to exist before server.ts runs, or the write fails the
    // same way. The command creates it itself rather than relying on setup order.
    expect(command).toContain(`mkdir -p ${dir}`);
    expect(command.indexOf(`mkdir -p ${dir}`)).toBeLessThan(command.indexOf("server.ts"));
  });
});
