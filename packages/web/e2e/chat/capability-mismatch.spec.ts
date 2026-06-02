/**
 * Capability-mismatch E2E test — Task 24.
 *
 * Verifies the full block + recovery flow when a user attaches an image to a
 * composer that is backed by a text-only model (vision: false):
 *
 *   1. Login as admin
 *   2. Navigate to the chat page; mock WS makes the agent "ready"
 *   3. Mock /api/models/capabilities so the current agent model reports
 *      vision: false — this is what drives the send-block logic in Composer
 *   4. Attach a PNG to the composer via Playwright's file input API
 *   5. Try to send → verify RecoveryPanel appears ("Attachment can't be sent")
 *   6. Use the embedded ModelPicker to select a vision-capable model
 *   7. Click "Update agent" — mock /api/agents/:id PATCH returns 200
 *   8. Verify RecoveryPanel dismisses
 *   9. Send the message successfully (mock WS acks + completes)
 *
 * Mock WebSocket strategy:
 *   - Uses page.addInitScript() to inject a MockWebSocket before page loads
 *   - On receiving "history", sends openclaw_status + history with sessionKnown
 *     so the chat transitions to "ready" without a live OpenClaw connection
 *   - On receiving "message", acks the message and sends a chunk + complete
 *
 * Mock fetch strategy:
 *   - Uses page.addInitScript() to intercept fetch() calls to
 *     /api/models/capabilities — returns a map where the current agent model
 *     has vision: false and a second model (vision-model/gpt-4o) has
 *     vision: true.  The real route is not hit.
 *   - /api/agents/:id PATCH is intercepted and returns 200 {} so the
 *     onUpdateAgent callback resolves and the recovery panel dismisses.
 *
 * Note on file attachment:
 *   - Playwright's setInputFiles() targets the hidden <input type="file">
 *     rendered by @assistant-ui ComposerPrimitive.AddAttachment. The selector
 *     `input[type="file"]` inside the composer area is used.
 *   - The test creates a minimal 1×1 PNG buffer in-process so no fixture file
 *     is needed.
 *
 * MockWebSocket is intentionally not shared from a helper module —
 * page.addInitScript() serialises the function to a string for injection into
 * the browser context, so imports and outer-scope references are unavailable.
 */

import { test, expect } from "@playwright/test";
import { seedProviderConfig } from "../helpers";

// The mocked /api/models/capabilities lies about the seeded agent's actual
// model (claims vision: false), so the composer's hard-block logic kicks
// in even when the real provider's default model is vision-capable. The
// model key is resolved per-test from the seeded agent (see `seededModel`
// below), not hardcoded — this keeps the test robust against upstream
// changes to PROVIDERS[*].defaultModel.
const VISION_MODEL = "vision-provider/gpt-4o";
const PNG_FILENAME = "test-image.png";

test.describe("capability-mismatch — block + recovery", () => {
  test("attaching image to text-only agent blocks send and recovery panel allows model switch", async ({
    page,
    request,
  }) => {
    // ── 1. Setup: register admin + seed provider config (idempotent) ──────────
    const setupRes = await request.post("/api/setup", {
      data: {
        name: "Test Admin",
        email: "admin@test.local",
        password: "test-password-123",
      },
    });
    expect([201, 403]).toContain(setupRes.status());

    await seedProviderConfig();

    // ── 2. Log in via UI to get a session cookie, then extract agentId ────────
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@test.local");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15000 });

    const chatUrl = page.url();
    const agentIdMatch = chatUrl.match(/\/chat\/([^/?#]+)/);
    expect(agentIdMatch).toBeTruthy();
    const agentId = agentIdMatch![1];

    // Earlier tests in the suite share the test DB and can rename, replace,
    // or remodel the default agent. Resolve the seeded agent's actual name
    // AND model from the API so the capability-map mock keys off the model
    // the Composer will actually see — not a constant that drifts when the
    // default model anchor changes upstream.
    const agentRes = await page.request.get(`/api/agents/${agentId}`);
    expect(agentRes.ok()).toBe(true);
    const agentBody = (await agentRes.json()) as { name: string; model: string };
    const agentName = agentBody.name;
    const seededModel = agentBody.model;

    // ── 3. Inject mock fetch (capabilities + PATCH) before navigation ─────────
    //    addInitScript serialises the closure; constants must be inlined via the
    //    params object (same pattern as 15-model-error-ux.spec.ts).
    await page.addInitScript(
      ({
        textOnlyModel,
        visionModel,
        targetAgentId,
      }: {
        textOnlyModel: string;
        visionModel: string;
        targetAgentId: string;
      }) => {
        const realFetch = window.fetch.bind(window);

        // Tracks what model the agent should appear to have after a mocked
        // PATCH. The Composer's refreshAgents() then sees the new model and
        // stops re-blocking the next send. Starts as null = pass through to
        // the real /api/agents response.
        let patchedAgentModel: string | null = null;

        window.fetch = async function (
          input: RequestInfo | URL,
          init?: RequestInit
        ): Promise<Response> {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

          // Intercept /api/models/capabilities — return a map with one
          // text-only model and one vision-capable model.
          if (url.includes("/api/models/capabilities")) {
            const body: Record<string, unknown> = {
              [textOnlyModel]: {
                vision: false,
                documents: false,
                audio: false,
                video: false,
                longContext: false,
                tools: true,
              },
              [visionModel]: {
                vision: true,
                documents: false,
                audio: false,
                video: false,
                longContext: false,
                tools: true,
              },
            };
            return new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          // Intercept PATCH /api/agents/:id — record the new model so the
          // /api/agents list reflects the change on the next refresh, and
          // return 200 so onUpdateAgent resolves.
          if (
            url.includes(`/api/agents/${targetAgentId}`) &&
            init?.method?.toUpperCase() === "PATCH"
          ) {
            try {
              const body = init?.body ? JSON.parse(String(init.body)) : {};
              if (typeof body?.model === "string") {
                patchedAgentModel = body.model;
              }
            } catch {
              // Ignore malformed body — test only sends well-formed JSON.
            }
            return new Response(JSON.stringify({ id: targetAgentId }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          // After a PATCH, the Composer calls refreshAgents() which hits
          // GET /api/agents. Lie about the target agent's model so the
          // refreshed local state lets the next send go through.
          if (
            patchedAgentModel &&
            url.endsWith("/api/agents") &&
            (init?.method ?? "GET").toUpperCase() === "GET"
          ) {
            const realRes = await realFetch(input, init);
            try {
              const list = (await realRes.clone().json()) as Array<{
                id: string;
                model: string;
              }>;
              const patched = list.map((a) =>
                a.id === targetAgentId ? { ...a, model: patchedAgentModel } : a
              );
              return new Response(JSON.stringify(patched), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            } catch {
              return realRes;
            }
          }

          return realFetch(input, init);
        };
      },
      {
        textOnlyModel: seededModel,
        visionModel: VISION_MODEL,
        targetAgentId: agentId,
      }
    );

    // ── 4. Inject mock WebSocket before navigation ────────────────────────────
    await page.addInitScript(
      ({ targetAgentId, agentName }: { targetAgentId: string; agentName: string }) => {
        type ClientMessage = {
          type?: string;
          clientMessageId?: string;
        };

        const RealWebSocket = window.WebSocket;

        class MockWebSocket {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;

          CONNECTING = 0;
          OPEN = 1;
          CLOSING = 2;
          CLOSED = 3;

          onopen: (() => void) | null = null;
          onmessage: ((event: { data: string }) => void) | null = null;
          onclose: (() => void) | null = null;
          onerror: (() => void) | null = null;
          readyState = 1;
          binaryType: string = "blob";

          constructor(url: string) {
            // Forward Next.js HMR/dev sockets to the real WebSocket
            if (url.includes("/_next/")) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            // Forward connections to any agent other than the one under test
            if (!url.includes(targetAgentId)) {
              return new RealWebSocket(url) as unknown as MockWebSocket;
            }
            queueMicrotask(() => this.onopen?.());
          }

          addEventListener() {
            // No-op: avoids TypeErrors from dev-tooling code that subscribes
            // via addEventListener rather than the onXxx properties.
          }

          removeEventListener() {
            // No-op
          }

          send(raw: string) {
            const message = JSON.parse(raw) as ClientMessage;

            if (message.type === "history") {
              // openclaw_status must arrive before history so chatStatus → ready
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "openclaw_status",
                    connected: true,
                  }),
                });
              }, 0);
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "history",
                    messages: [
                      {
                        role: "assistant",
                        content: `Hello! I'm ${agentName}. How can I help you?`,
                      },
                    ],
                    sessionKnown: true,
                  }),
                });
              }, 5);
              return;
            }

            if (message.type === "message") {
              const clientMessageId = message.clientMessageId;

              // Ack the user message
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({ type: "ack", clientMessageId }),
                });
              }, 0);

              // Deliver a minimal assistant reply
              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "chunk",
                    content: "I can see your image!",
                    messageId: "m-e2e-1",
                  }),
                });
              }, 20);

              setTimeout(() => {
                this.onmessage?.({
                  data: JSON.stringify({ type: "complete" }),
                });
              }, 30);
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
      },
      {
        targetAgentId: agentId,
        agentName,
      }
    );

    // ── 5. Navigate to the chat page (mocks are now installed) ────────────────
    await page.goto(`/chat/${agentId}`);
    await expect(page).toHaveURL(`/chat/${agentId}`, { timeout: 10000 });

    // Wait for the composer to be ready — confirms the chat is mounted
    const input = page.getByLabel("Message input");
    await expect(input).toBeVisible({ timeout: 10000 });

    // Wait for the greeting from mock history to confirm ready state
    await expect(page.getByText(/How can I help you/)).toBeVisible({ timeout: 10000 });

    // ── 6. Type a message in the composer ────────────────────────────────────
    await input.fill("Can you describe this image?");

    // ── 7. Attach a PNG via the AddAttachment button ──────────────────────────
    //    ComposerPrimitive.AddAttachment creates a hidden <input type="file">
    //    on click (not at mount), so there is no element in the DOM for
    //    setInputFiles() to target ahead of time. Playwright's filechooser
    //    event is the right primitive here — wait for the chooser, click the
    //    button, then deliver the file. We create a minimal 1×1 PNG from a
    //    base64 literal — no fixture files.
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add Attachment" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: PNG_FILENAME,
      mimeType: "image/png",
      buffer: pngBuffer,
    });

    // Confirm the attachment chip is visible in the composer. Pinchy's two-phase
    // upload renders an UploadChip (identified by the filename label) rather
    // than the assistant-ui "Image attachment" button.
    await expect(page.getByText(PNG_FILENAME)).toBeVisible({ timeout: 5000 });

    // ── 8. Try to send — handleSubmit blocks because vision: false ────────────
    await page.getByRole("button", { name: "Send message" }).click();

    // ── 9. RecoveryPanel must appear ─────────────────────────────────────────
    const recoveryPanel = page.getByRole("region", { name: "Can't be sent" });
    await expect(recoveryPanel).toBeVisible({ timeout: 5000 });
    await expect(recoveryPanel).toContainText("Attachment can't be sent");
    await expect(recoveryPanel).toContainText(agentName);
    await expect(recoveryPanel).toContainText(PNG_FILENAME);

    // ── 10. Select a vision-capable model via the embedded ModelPicker ────────
    //    The ModelPicker renders a shadcn/ui <Select> with a "Select a model"
    //    placeholder. We click the trigger and then pick the vision model.
    const selectTrigger = recoveryPanel.getByRole("combobox");
    await expect(selectTrigger).toBeVisible({ timeout: 5000 });
    await selectTrigger.click();

    // The SelectContent portal renders outside the region — search globally
    // for the vision model option (the model id's last segment after /).
    const visionModelLabel = VISION_MODEL.split("/")[1]; // "gpt-4o"
    await page.getByRole("option", { name: new RegExp(visionModelLabel, "i") }).click();

    // ── 11. Click "Update agent" ──────────────────────────────────────────────
    const updateButton = recoveryPanel.getByRole("button", { name: /update agent/i });
    await expect(updateButton).toBeEnabled({ timeout: 3000 });
    await updateButton.click();

    // ── 12. RecoveryPanel must dismiss after the PATCH resolves ───────────────
    await expect(recoveryPanel).not.toBeVisible({ timeout: 5000 });

    // ── 13. Send the message — mock WS acks + completes ──────────────────────
    await page.getByRole("button", { name: "Send message" }).click();

    // The assistant reply must appear in the thread
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
      "I can see your image!",
      { timeout: 10000 }
    );
  });
});
