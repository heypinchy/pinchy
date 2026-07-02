/**
 * Terminal rejection handler for the server's async startup chain
 * (`app.prepare().then(async () => {...})` in server.ts).
 *
 * Without it, a throw anywhere during startup — e.g. the OpenClawClient
 * constructor failing on an unreadable device-identity file — surfaces only
 * as an unhandledRejection that Next.js logs and swallows, leaving a zombie
 * server: HTTP up, /api/health "ok", but the OpenClaw wiring (connect, status
 * broadcaster, run watchdog) never ran, so every chat shows "Reconnecting to
 * the agent…" forever with nothing actionable in the logs (staging incident,
 * 2026-07-02). Exiting non-zero makes Docker restart the container visibly:
 * a crash loop is diagnosable, a zombie is not.
 */
export function exitOnStartupFailure(err: unknown): never {
  console.error(
    "[pinchy] Server startup failed — exiting so the container restarts " +
      "instead of running without its chat backend:",
    err
  );
  process.exit(1);
}
