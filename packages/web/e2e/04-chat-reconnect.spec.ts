import { test, expect } from "@playwright/test";

const TEST_DB_URL = "postgresql://pinchy:pinchy_dev@localhost:5433/pinchy_test";

async function seedProviderConfig() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(TEST_DB_URL);
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('default_provider', 'anthropic', false)
    ON CONFLICT (key) DO UPDATE SET value = 'anthropic'
  `;
  await sql`
    INSERT INTO settings (key, value, encrypted)
    VALUES ('anthropic_api_key', 'sk-ant-fake-key', true)
    ON CONFLICT (key) DO UPDATE SET value = 'sk-ant-fake-key'
  `;
  await sql.end();
}

test.describe("chat reconnect recovery", () => {
  test("reconciles partial markdown with canonical history after reconnect", async ({
    page,
    request,
  }) => {
    const setupResponse = await request.post("/api/setup", {
      data: {
        name: "Test Admin",
        email: "admin@test.local",
        password: "test-password-123",
      },
    });
    expect([201, 403]).toContain(setupResponse.status());

    await seedProviderConfig();

    await page.addInitScript(() => {
      type ClientMessage = {
        type?: string;
      };

      const globalState: {
        historyRequests: number;
      } = { historyRequests: 0 };

      class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readyState = 1;

        constructor(_url: string) {
          queueMicrotask(() => this.onopen?.());
        }

        send(raw: string) {
          const message = JSON.parse(raw) as ClientMessage;

          if (message.type === "history") {
            globalState.historyRequests += 1;
            const payload =
              globalState.historyRequests === 1
                ? {
                    type: "history",
                    messages: [{ role: "assistant", content: "Hallo! Ich helfe dir." }],
                  }
                : {
                    type: "history",
                    messages: [
                      { role: "assistant", content: "Hallo! Ich helfe dir." },
                      { role: "user", content: "Wie ist die Vacation Policy?" },
                      {
                        role: "assistant",
                        content: "Ich schaue nach. **Urlaubsanspruch:** 25 Tage",
                      },
                    ],
                  };

            setTimeout(() => {
              this.onmessage?.({ data: JSON.stringify(payload) });
            }, 0);
            return;
          }

          if (message.type === "message") {
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({
                  type: "chunk",
                  content: "Ich schaue nach. Urlaub**: 25 Tage",
                  messageId: "assistant-reconnect-test",
                }),
              });
              this.readyState = 3;
              this.onclose?.();
            }, 20);
          }
        }

        close() {
          this.readyState = 3;
          this.onclose?.();
        }
      }

      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: MockWebSocket,
      });
    });

    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Desktop redirects directly to first agent chat
    await expect(page).toHaveURL(/\/chat\//, { timeout: 10000 });

    // Ensure the chat thread is ready and connected with initial history.
    await expect(page.getByText("Hallo! Ich helfe dir.")).toBeVisible();

    await page.getByLabel("Message input").fill("Wie ist die Vacation Policy?");
    await page.getByRole("button", { name: "Send message" }).click();

    // After a forced disconnect, reconnect history should replace the partial chunk.
    const assistantMessages = page.locator('[data-role="assistant"]');
    await expect(assistantMessages.last()).toContainText("Urlaubsanspruch:", { timeout: 10000 });
    await expect(assistantMessages.last()).not.toContainText("Urlaub**");
  });
});
