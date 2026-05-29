import { test } from "@playwright/test";
import { resetStack, runProviderSmokeTest } from "./helpers";

test.describe("Setup wizard → first chat with Ollama (Local)", () => {
  test.beforeAll(resetStack);

  test("fresh install: wizard → Ollama Local → first Smithers message succeeds", async ({
    page,
  }) => {
    // Ollama-Local is URL-based, not API-key-based — the wizard renders a URL
    // input field instead of a "Bearer ..." form. The same runProviderSmokeTest
    // helper handles both because both end up as a single text input that the
    // placeholder selector matches.
    //
    // The URL points at the `fake-ollama` sibling service in
    // docker-compose.setup-wizard-test.yml: it's the same fake-ollama-server.ts
    // the integration tests use as a subprocess, containerised here so
    // setup-wizard tests reach it from inside the Docker network. The
    // `fake-ollama.local` alias is what makes both Pinchy's SSRF allowlist
    // (validateProviderUrl) and OpenClaw's isLocalBaseUrl accept the URL —
    // both accept any hostname ending in `.local`.
    await runProviderSmokeTest(page, {
      provider: "ollama-local",
      // Provider button label from PROVIDERS["ollama-local"].name in
      // packages/web/src/lib/providers.ts ("Ollama (Local)"). Specific
      // enough not to collide with "Ollama Cloud".
      buttonName: /ollama \(local\)/i,
      // Placeholder from PROVIDERS["ollama-local"].placeholder
      // ("http://host.docker.internal:11434"). Matching on the docker host
      // alias keeps the regex stable if the example port changes.
      placeholderRegex: /host\.docker\.internal/i,
      // Real URL Pinchy receives. Port 11435 is fake-ollama's listener
      // (FAKE_OLLAMA_PORT in fake-ollama-server.ts).
      keyValue: "http://fake-ollama.local:11435",
    });
  });
});
