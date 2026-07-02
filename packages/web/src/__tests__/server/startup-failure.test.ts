import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { exitOnStartupFailure } from "@/server/startup-failure";

describe("exitOnStartupFailure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an actionable error and exits with code 1", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const cause = new Error("EACCES: permission denied, open '/app/secrets/device-identity.json'");
    expect(() => exitOnStartupFailure(cause)).toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, loggedErr] = errorSpy.mock.calls[0];
    // The message must tell the operator what happened and why exiting is
    // deliberate — this line is all they see before the container restarts.
    expect(String(message)).toContain("startup failed");
    expect(String(message)).toContain("exiting");
    expect(loggedErr).toBe(cause);
  });

  it("passes non-Error rejection values through to the log", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    expect(() => exitOnStartupFailure("string rejection")).toThrow("process.exit(1)");
    expect(errorSpy.mock.calls[0][1]).toBe("string rejection");
  });
});

describe("server.ts startup chain wiring", () => {
  // The 2026-07-02 staging incident: the OpenClawClient constructor threw
  // inside `app.prepare().then(async () => {...})`, which had no .catch. The
  // rejection surfaced only as an unhandledRejection that Next.js logs and
  // swallows, leaving a zombie server — HTTP up, /api/health "ok", but the
  // OpenClaw wiring (connect, status broadcaster, watchdog) never ran, so
  // every chat showed "Reconnecting to the agent…" forever. This guard fails
  // if the terminal .catch is ever dropped from the startup chain.
  it("attaches exitOnStartupFailure as the terminal .catch of app.prepare()", () => {
    const serverSource = fs.readFileSync(path.resolve(__dirname, "../../../server.ts"), "utf8");
    expect(serverSource).toContain(".catch(exitOnStartupFailure)");
    expect(serverSource).toMatch(
      /import \{ exitOnStartupFailure \} from ".\/src\/server\/startup-failure"/
    );
  });
});
