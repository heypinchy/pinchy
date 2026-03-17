import { describe, expect, it } from "vitest";
import { sanitizeDetail } from "@/lib/audit-sanitize";

describe("sanitizeDetail", () => {
  describe("key-name redaction", () => {
    it("redacts values for known sensitive key names", () => {
      const input = {
        password: "my-secret-pass",
        apiKey: "sk-abc123",
        token: "tok-xyz",
        normal: "visible",
      };

      const result = sanitizeDetail(input);

      expect(result).toEqual({
        password: "[REDACTED]",
        apiKey: "[REDACTED]",
        token: "[REDACTED]",
        normal: "visible",
      });
    });

    it("matches key names case-insensitively", () => {
      const input = { PASSWORD: "secret", ApiKey: "key123" };
      const result = sanitizeDetail(input);
      expect(result).toEqual({
        PASSWORD: "[REDACTED]",
        ApiKey: "[REDACTED]",
      });
    });

    it("matches key names as substrings", () => {
      const input = {
        myApiKey: "key123",
        db_password_hash: "hash",
        x_authorization_header: "Bearer xyz",
      };
      const result = sanitizeDetail(input);
      expect(result).toEqual({
        myApiKey: "[REDACTED]",
        db_password_hash: "[REDACTED]",
        x_authorization_header: "[REDACTED]",
      });
    });

    it("redacts all known sensitive key names", () => {
      const keys = [
        "password",
        "secret",
        "token",
        "apiKey",
        "api_key",
        "authorization",
        "credential",
        "private_key",
        "privateKey",
        "passphrase",
        "access_key",
        "accessKey",
        "client_secret",
        "clientSecret",
      ];

      for (const key of keys) {
        const input = { [key]: "sensitive-value" };
        const result = sanitizeDetail(input);
        expect(result[key]).toBe("[REDACTED]");
      }
    });

    it("redacts nested objects recursively", () => {
      const input = {
        toolName: "browser",
        params: {
          headers: { authorization: "Bearer secret-token" },
          url: "https://example.com",
        },
      };

      const result = sanitizeDetail(input) as any;

      expect(result.toolName).toBe("browser");
      expect(result.params.headers.authorization).toBe("[REDACTED]");
      expect(result.params.url).toBe("https://example.com");
    });

    it("redacts values inside arrays", () => {
      const input = {
        items: [
          { name: "safe", token: "secret123" },
          { name: "also-safe", password: "pass" },
        ],
      };

      const result = sanitizeDetail(input) as any;

      expect(result.items[0].token).toBe("[REDACTED]");
      expect(result.items[1].password).toBe("[REDACTED]");
      expect(result.items[0].name).toBe("safe");
    });

    it("does not mutate the original object", () => {
      const input = { password: "secret", nested: { token: "tok" } };
      const original = JSON.parse(JSON.stringify(input));

      sanitizeDetail(input);

      expect(input).toEqual(original);
    });

    it("handles null and undefined gracefully", () => {
      expect(sanitizeDetail(null as any)).toBeNull();
      expect(sanitizeDetail(undefined as any)).toBeUndefined();
    });

    it("passes through non-string primitives unchanged", () => {
      const input = { count: 42, active: true, password: "secret" };
      const result = sanitizeDetail(input);
      expect(result).toEqual({ count: 42, active: true, password: "[REDACTED]" });
    });

    it("stops recursion at max depth", () => {
      // Build a 12-level deep object: depth 0 is outermost, password lives at depth 12
      let obj: any = { password: "deep-secret" };
      for (let i = 0; i < 12; i++) {
        obj = { nested: obj };
      }

      const result = sanitizeDetail(obj) as any;

      // Should not throw. The password key at depth 12 is beyond the limit
      // of 10, so it must NOT be redacted.
      let level = result;
      for (let i = 0; i < 12; i++) {
        level = level.nested;
      }
      expect(level.password).toBe("deep-secret");
    });
  });

  describe("pattern redaction", () => {
    it("redacts OpenAI API keys", () => {
      const input = { result: "Key is sk-abc123def456ghi789jkl012mno" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).not.toContain("sk-abc123def456ghi789jkl012mno");
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts Anthropic API keys", () => {
      const input = { result: "Using sk-ant-api03-abcdefghijklmnopqrstuvwxyz" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts GitHub personal access tokens", () => {
      const input = { result: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).not.toContain("ghp_");
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts GitHub OAuth tokens", () => {
      const input = { result: "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts GitHub fine-grained PATs", () => {
      const input = { result: "github_pat_aBcDeFgHiJkLmNoPqRsT" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts Slack bot tokens", () => {
      const input = { result: "xoxb-123456789-abcdef" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts Slack user tokens", () => {
      const input = { result: "xoxp-123456789-abcdef" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts Bearer tokens", () => {
      const input = {
        result: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def",
      };
      const result = sanitizeDetail(input) as any;
      expect(result.result).not.toContain("eyJhbGciOiJ");
      expect(result.result).toContain("[REDACTED]");
    });

    it("redacts Telegram bot tokens", () => {
      const input = { result: "Bot token: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz_12345678" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("[REDACTED]");
      expect(result.result).not.toContain("ABCdefGHI");
    });

    it("redacts Meta/Facebook access tokens", () => {
      const input = { result: "Token: EAABsbCS1iZABAbcdefghijklmnopqrst" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("[REDACTED]");
      expect(result.result).not.toContain("EAABsbCS1iZAB");
    });

    it("redacts multiple patterns in a single string", () => {
      const input = {
        result:
          "Keys: sk-abcdefghijklmnopqrstuvwxyz and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl",
      };
      const result = sanitizeDetail(input) as any;
      expect(result.result).not.toContain("sk-abc");
      expect(result.result).not.toContain("ghp_");
    });

    it("does not redact short strings that partially match", () => {
      const input = { result: "sk-short" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toBe("sk-short");
    });

    it("preserves surrounding text when redacting patterns", () => {
      const input = { result: "Found key sk-abcdefghijklmnopqrstuvwxyz in file" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("Found key");
      expect(result.result).toContain("in file");
      expect(result.result).toContain("[REDACTED]");
    });

    it("does not re-process already redacted strings", () => {
      const input = { result: "[REDACTED]" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toBe("[REDACTED]");
    });
  });

  describe("env-file line redaction", () => {
    it("redacts values in SECRET_KEY=value lines", () => {
      const input = { result: "SECRET_KEY=my-super-secret-value" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("SECRET_KEY=");
      expect(result.result).toContain("[REDACTED]");
      expect(result.result).not.toContain("my-super-secret-value");
    });

    it("redacts values in multiline env file content", () => {
      const input = {
        result:
          "APP_NAME=pinchy\nAPI_KEY=sk-shortkey\nDATABASE_URL=postgres://localhost\nSECRET_TOKEN=abc123\nDEBUG=true",
      };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("APP_NAME=pinchy");
      expect(result.result).toContain("API_KEY=[REDACTED]");
      expect(result.result).toContain("DATABASE_URL=postgres://localhost");
      expect(result.result).toContain("SECRET_TOKEN=[REDACTED]");
      expect(result.result).toContain("DEBUG=true");
    });

    it("handles PASSWORD=value lines", () => {
      const input = { result: "DB_PASSWORD=hunter2" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toBe("DB_PASSWORD=[REDACTED]");
    });

    it("handles CREDENTIAL=value lines", () => {
      const input = { result: "AWS_CREDENTIAL=AKIA1234" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toContain("AWS_CREDENTIAL=[REDACTED]");
    });

    it("does not redact non-sensitive env lines", () => {
      const input = { result: "APP_NAME=pinchy\nDEBUG=true\nPORT=3000" };
      const result = sanitizeDetail(input) as any;
      expect(result.result).toBe("APP_NAME=pinchy\nDEBUG=true\nPORT=3000");
    });
  });
});
