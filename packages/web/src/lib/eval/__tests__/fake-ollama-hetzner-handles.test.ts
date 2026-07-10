import { describe, expect, it } from "vitest";
import {
  FAKE_OLLAMA_HETZNER_ATTACHMENT_HANDLE,
  FAKE_OLLAMA_HETZNER_MSG_HANDLE,
} from "../../../../e2e/shared/fake-ollama/fake-ollama-server";
import {
  HETZNER_ISSUED_ATT_HANDLE,
  HETZNER_ISSUED_MSG_HANDLE,
} from "../../../../eval/scenarios/hetzner-invoice";

// fake-ollama-server.ts is COPY'd into a standalone container by its own
// Dockerfile (which copies ONLY fake-ollama-server.ts + fake-ollama-process.ts),
// so it must not import the eval scenario — it hardcodes the Hetzner handle
// literals instead (importing the scenario made the container exit 1 at start,
// CI "Setup Wizard E2E"). This guard locks those literals to the scenario's
// computed handles, which handle-parity.test.ts in turn locks to pinchy-email's
// real handleFor. So changing HETZNER_SEEDED_*_ID can't silently desync the
// self-test's scripted email_read / email_get_attachment arguments.
describe("fake-ollama Hetzner handles stay in sync with the eval scenario", () => {
  it("message handle matches the scenario's issued message handle", () => {
    expect(FAKE_OLLAMA_HETZNER_MSG_HANDLE).toBe(HETZNER_ISSUED_MSG_HANDLE);
  });

  it("attachment handle matches the scenario's issued attachment handle", () => {
    expect(FAKE_OLLAMA_HETZNER_ATTACHMENT_HANDLE).toBe(HETZNER_ISSUED_ATT_HANDLE);
  });
});
