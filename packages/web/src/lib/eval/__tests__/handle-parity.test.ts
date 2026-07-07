import { describe, expect, it } from "vitest";
import {
  ATT_PREFIX,
  handleFor,
  MSG_PREFIX,
} from "../../../../../plugins/pinchy-email/id-handle-store";
import {
  HETZNER_ISSUED_ATT_HANDLE,
  HETZNER_ISSUED_MSG_HANDLE,
  HETZNER_SEEDED_ATTACHMENT_ID,
  HETZNER_SEEDED_MESSAGE_ID,
} from "../../../../eval/scenarios/hetzner-invoice";

// The eval harness re-implements pinchy-email's `handleFor` locally (in
// hetzner-invoice.ts) because the production `next build` stage ships plugin
// manifests but NOT plugin `.ts` source, and next build type-checks all of
// `packages/web` — so no build-graph file may import the plugin source. This
// test (excluded from that build under `src/**/*.test.ts`) is the guard that
// the local copy stays byte-identical to the plugin: if the plugin ever
// changes its handle format, this fails and forces the eval copy to follow,
// keeping the fake-ollama self-test's handles resolvable and gradeIdFidelity
// correct. See [[reference_email_graph_id_and_audit_false_green]].
describe("eval handle parity with pinchy-email id-handle-store", () => {
  it("scenario message handle equals plugin handleFor(seededMessageId, MSG_PREFIX)", () => {
    expect(HETZNER_ISSUED_MSG_HANDLE).toBe(handleFor(HETZNER_SEEDED_MESSAGE_ID, MSG_PREFIX));
  });

  it("scenario attachment handle equals plugin handleFor(seededAttachmentId, ATT_PREFIX)", () => {
    expect(HETZNER_ISSUED_ATT_HANDLE).toBe(handleFor(HETZNER_SEEDED_ATTACHMENT_ID, ATT_PREFIX));
  });
});
