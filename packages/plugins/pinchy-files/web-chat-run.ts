/**
 * Whether a tool run will end in Pinchy's web-chat artifact poll — the only
 * place a saved file becomes a download chip (`deliverRunArtifacts` in
 * packages/web/src/server/stream-pipe.ts). OpenClaw itself forwards a tool's
 * `file` block to no channel: Telegram only receives `details.media`, which
 * no Pinchy plugin emits.
 *
 * Both halves are needed. A web-chat run is a gateway `agent` call with no
 * channel, which OpenClaw resolves to "webchat" — but so is an automation
 * inbox run (`agent:<id>:inbox:<ledgerId>`), which has no chat to show a chip
 * in. A Telegram DM uses the same `:direct:` key shape, on channel "telegram".
 * Anything OpenClaw did not report counts as "not web chat": claiming less
 * than happened is the safe direction.
 *
 * Ask this from `execute`'s closure over the factory's ctx, never from text
 * baked into the tool's description: OpenClaw caches descriptions keyed on
 * messageChannel but not sessionKey, so an inbox run can be shown the
 * description built for a web-chat run. `execute` always gets the live ctx.
 *
 * DUPLICATED byte-for-byte into pinchy-email and pinchy-files (a plugin
 * directory is mounted on its own and cannot import a sibling). Edit the
 * pinchy-email copy, then copy it over; plugin-web-chat-run-drift.test.ts in
 * packages/web fails until the copies match. Keep it import-free.
 */
export function isWebChatRun(
  ctx: { sessionKey?: string; messageChannel?: string } | undefined
): boolean {
  return ctx?.messageChannel === "webchat" && /^agent:[^:]+:direct:/.test(ctx.sessionKey ?? "");
}
