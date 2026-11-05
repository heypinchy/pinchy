import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, { value: string; encrypted: boolean }>();

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async (key: string) => store.get(key)?.value ?? null),
  setSetting: vi.fn(async (key: string, value: string, encrypted = false) => {
    store.set(key, { value, encrypted });
  }),
  deleteSetting: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import {
  SYSTEM_MAIL_SETTING_KEY,
  getSystemMailConfig,
  saveSystemMailConfig,
  deleteSystemMailConfig,
  toPublicConfig,
  mergeWithStoredPassword,
} from "@/lib/system-mail/config";

const config = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls" as const,
  username: "pinchy@example.com",
  password: "s3cret",
  fromAddress: "pinchy@example.com",
};

describe("system mail config storage", () => {
  beforeEach(() => store.clear());

  it("is off when nothing is stored", async () => {
    expect(await getSystemMailConfig()).toBeNull();
  });

  it("stores the whole config as ONE encrypted setting", async () => {
    await saveSystemMailConfig(config);
    const row = store.get(SYSTEM_MAIL_SETTING_KEY);
    expect(row?.encrypted).toBe(true);
    expect(await getSystemMailConfig()).toEqual(config);
  });

  it("turning it off removes the row", async () => {
    await saveSystemMailConfig(config);
    await deleteSystemMailConfig();
    expect(await getSystemMailConfig()).toBeNull();
  });

  it("treats an unreadable stored value as off rather than throwing", async () => {
    store.set(SYSTEM_MAIL_SETTING_KEY, { value: "{not json", encrypted: true });
    expect(await getSystemMailConfig()).toBeNull();
  });

  it("treats a stored value that no longer matches the schema as off", async () => {
    store.set(SYSTEM_MAIL_SETTING_KEY, {
      value: JSON.stringify({ host: "x" }),
      encrypted: true,
    });
    expect(await getSystemMailConfig()).toBeNull();
  });
});

describe("toPublicConfig", () => {
  it("never carries the password, only whether one is stored", () => {
    const pub = toPublicConfig(config);
    expect(pub).not.toHaveProperty("password");
    expect(pub.hasPassword).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("s3cret");
  });

  it("reports hasPassword false for a relay without AUTH", () => {
    expect(toPublicConfig({ ...config, password: undefined }).hasPassword).toBe(false);
  });
});

describe("mergeWithStoredPassword", () => {
  it("keeps the stored password when the update omits it", () => {
    const merged = mergeWithStoredPassword({ ...config, password: undefined }, config);
    expect(merged.password).toBe("s3cret");
  });

  it("replaces it when the update carries a new one", () => {
    expect(mergeWithStoredPassword({ ...config, password: "new" }, config).password).toBe("new");
  });

  it("clears it together with the username — no AUTH without a user", () => {
    const merged = mergeWithStoredPassword(
      { ...config, username: undefined, password: undefined },
      config
    );
    expect(merged.username).toBeUndefined();
    expect(merged.password).toBeUndefined();
  });

  it("does not inherit a password when the host changes", () => {
    // A stored password belongs to the server it was typed for. Keeping it
    // across a host change would send it to a server nobody typed it for.
    const merged = mergeWithStoredPassword(
      { ...config, host: "evil.example.com", password: undefined },
      config
    );
    expect(merged.password).toBeUndefined();
  });

  it("works without anything stored", () => {
    expect(mergeWithStoredPassword({ ...config, password: undefined }, null).password).toBe(
      undefined
    );
  });
});
