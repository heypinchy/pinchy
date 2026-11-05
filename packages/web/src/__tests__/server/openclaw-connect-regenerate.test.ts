// Which (re)connects to OpenClaw run a full regenerate.
//
// The first connect always does. A reconnect does only when a config change
// could not be delivered while OpenClaw was unreachable: every push that gave
// up records that (push-state.ts), and the regenerate rebuilds the whole config
// — channels.telegram included — from the database. Without it, a change
// refused while OpenClaw was down waited for an unrelated later change: a
// Telegram bot removed for everyone kept polling once OpenClaw came back.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { regenerateOnConnect } from "@/server/openclaw-connect-regenerate";
import {
  _resetConfigPushState,
  noteFileOnlyDelivery,
  noteUndeliveredConfigChange,
  trackConfigPushStarted,
} from "@/lib/openclaw-config/push-state";

describe("regenerateOnConnect", () => {
  beforeEach(() => _resetConfigPushState());

  it("regenerates on the first connect", () => {
    const regenerate = vi.fn(async () => {});
    regenerateOnConnect({ firstConnect: true }, regenerate);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate on a reconnect when every change was delivered", () => {
    // A reconnect after the restart a config.apply caused must not push again,
    // or a large first diff would restart OpenClaw in a loop.
    const regenerate = vi.fn(async () => {});
    regenerateOnConnect({ firstConnect: false }, regenerate);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("regenerates on a reconnect when a change could not be delivered", () => {
    noteUndeliveredConfigChange(1);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const regenerate = vi.fn(async () => {});
    regenerateOnConnect({ firstConnect: false }, regenerate);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("regenerates on a reconnect when a push reached only openclaw.json", () => {
    // A running OpenClaw may never reload a file Pinchy wrote while it was
    // not connected (CI run 41906476538): the connect is what can deliver it.
    noteFileOnlyDelivery();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const regenerate = vi.fn(async () => {});
    regenerateOnConnect({ firstConnect: false }, regenerate);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("leaves a file-only delivery to a push still in flight", () => {
    // That push retries over the new connection and settles it itself. A
    // second regenerate would only add an apply — and if an apply restarts
    // OpenClaw before it answers, a reconnect that regenerates again would
    // repeat that for as long as it happens.
    noteFileOnlyDelivery();
    trackConfigPushStarted();
    const regenerate = vi.fn(async () => {});
    regenerateOnConnect({ firstConnect: false }, regenerate);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("logs a failed regenerate instead of rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    regenerateOnConnect({ firstConnect: true }, () => Promise.reject(new Error("db down")));
    await new Promise((r) => setImmediate(r));
    expect(warn.mock.calls.flat().join(" ")).toMatch(/db down/);
  });
});
