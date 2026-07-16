import { createHash } from "node:crypto";

import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";

// =============================================================================
// Provenance record for Smithers' SOUL.md — READ THIS before editing
// smithers-soul.ts.
// =============================================================================
//
// `createSmithersAgent` writes SMITHERS_SOUL_MD to the agent's workspace exactly
// once, at creation time. Nothing ever rewrote it, so changing the constant had
// no effect on any Smithers that already existed: an instance installed before
// 2026-04-15 still ran a soul that opened with "You know the Pinchy platform
// inside out" and then listed platform facts that have since gone stale (the
// provider list predates ollama-local; Telegram, email and Odoo did not exist).
// The docs-driven rewrite never reached those instances.
//
// `migrateSmithersSoul()` fixes that on boot, and this list is what makes it
// safe. SOUL.md is user-editable (Agent Settings → SOUL.md), so the migration
// may only touch files the user has NOT customized. A hash match against this
// list proves the CONTENT is text Pinchy shipped — nothing else can produce
// those bytes by accident.
//
// Note the exact claim. It is about the content, not the user's intent: it
// does NOT prove nobody ever touched the file. Someone who pastes an older
// shipped soul back byte-for-byte — out of git, a backup, or a preference for
// the old behavior — matches too, and gets upgraded. That is the accepted
// limit of the design, and docs/guides/upgrading.mdx states the rule the way
// the code actually behaves ("we only replace a SOUL.md that still matches one
// we shipped"), not as a promise about edits.
//
// Within that limit the hash is still the only workable selector, and no
// database column can replace it. `isPersonal` / `ownerId` can tell you an
// agent IS Smithers; nothing in the row tells you whether its SOUL.md is still
// the one we wrote. Only the bytes do. (`name` and `avatarSeed` are
// user-changeable on top of that, so they would be poor identifiers even for
// the weaker question.) So the migration does not identify Smithers at all —
// it identifies OUR TEXT, wherever it sits.
//
// Over-inclusion within this list is safe by construction. A hash here that
// never actually shipped can only ever match a file that byte-equals it — in
// which case it did ship. So the list errs toward completeness.
//
// The real boundary is the OTHER souls Pinchy ships. `the-butler`'s preset soul
// already shares whole paragraphs with Smithers' and drifts in a different
// file, so a preset derived from SMITHERS_SOUL_MD would land in this list and
// get every agent using it silently overwritten. smithers-soul-history.test.ts
// guards that; it is the one collision this design cannot tolerate.
//
// APPEND-ONLY. Editing SMITHERS_SOUL_MD without appending its new hash breaks
// smithers-soul-history.test.ts, which pins the last entry to the current
// constant. That guard is the whole point: it means the git archaeology behind
// this list never has to be repeated.
//
// To append: hash the EVALUATED constant, not the file text. writeWorkspaceFile
// writes the string verbatim via writeFileSync, so a user's on-disk bytes equal
// the evaluated constant exactly. The drift-guard test failure prints the hash
// to paste here.
// =============================================================================

/** Hash a soul string. Same "sha256:"+hex shape as the diagnostics collector's
 * `instructionsHash` (see lib/diagnostics/agent-config-collector.ts). */
export function hashSoul(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

/**
 * Every SMITHERS_SOUL_MD value Pinchy has ever shipped, oldest first.
 *
 * Generated once from the 25 commits that touched smithers-soul.ts between
 * 2026-02-20 and 2026-05-19 (each produced a distinct string). The last entry
 * MUST equal `CURRENT_SOUL_HASH`.
 */
export const SHIPPED_SOUL_HASHES: readonly string[] = [
  // 2026-02-20  fef013ef  2837B — first soul, with hardcoded platform knowledge
  "sha256:91fc60b2f9c0b2b5ad2dc774e69fd76e6628477aa3850ae73f1584f03019b766",
  // 2026-02-21  c6187929  3443B — audit trail page
  "sha256:cb313fabff10b39269e55277861a407c5602a368a66358cca12bda5474c83a55",
  // 2026-02-24  e8d16d05  3888B — restart resilience, agent switching
  "sha256:458fc252de011fe3941e734c7a4ab0fea7e9303ec64b33b98abc514ec79e37e6",
  // 2026-02-24  39966768  3775B — avatars, taglines
  "sha256:83bcbcda88f2077065085aacdd0e8ed653b13fd5adb4949268a8ccc0b4e0a527",
  // 2026-02-25  4751c283  4350B — new tab structure
  "sha256:cb7e7d62ce9e8690c8c60ad56be08e87e6a1980704b9a259f26824d2d06061d3",
  // 2026-02-26  3a9fbba4  4784B — context in general settings
  "sha256:55164bd9f00af934fc5bca31cbaa76f0bb4040af95659e60ab82df6d528b87b1",
  // 2026-02-27  ceb3ecf3  5173B — onboarding
  "sha256:4caf60697eb63886dddfe5091b739d2b168b18b1e338f4f5419f812bd8b6da07",
  // 2026-03-02  900bbc2f  5396B — onboarding thoroughness, settings hint
  "sha256:b38551b8ebd36de5241b963a9f0c7b9b1af5ffdfa6644266ad30e89d613e46c4",
  // 2026-03-02  11ce0fbb  5352B — onboarding streamlined to four details
  "sha256:31b2a024dc92c03c3934a79b3c40927dd3b77ac02f6013c1c6733c51e3f39883",
  // 2026-03-03  86f4c05e  5573B — in-app error reporting
  "sha256:8ce011ca5e47e8953d40b481d33090874438c27acf1e35a6c104f493795ea549",
  // 2026-03-03  a085f684  5423B — name dropped from onboarding
  "sha256:138fe97c15a0a793e937f9c0cc16ce27dfcb10d43cc1a446ba46529ead69a392",
  // 2026-03-04  60aa0a68  5437B — name comes from context, not conversation
  "sha256:c3ad3c8d92ba5032f522bfee7eca9dc203202e3473916d7aa980b39a30202fb8",
  // 2026-03-09  4a12217e  6287B — groups
  "sha256:ffb77d5cd73204a10a67234831fdc09044d2ed5b76a890a6c76fd7e0c46a3afe",
  // 2026-03-09  fdb1b2f5  6352B — two-value visibility model
  "sha256:a5a350d8159cd6a0ef48f41cd65e36fcad5f5d63a37bf3b53c77cbc8a629fd2b",
  // 2026-03-19  48e40cbb  6767B — v0.2.0
  "sha256:f1517ae120c23160b67c7cddf162fdb6f647dae9e6b1a44f3be4e5c9c93b7f17",
  // 2026-03-22  3d10f85a  7246B — usage & cost dashboard
  "sha256:790c0747bba76d33393cf1faa13e81a440b8c9d3be11065744859aee4e620249",
  // 2026-03-27  c8e228c5  7514B — v0.3.0
  "sha256:ff9cd1f13da18a64f8e782c95f942785618b59f6c7ee23715ee3b4632de5af5c",
  // 2026-03-31  884ca759  7564B — Ollama cloud quality fixes
  "sha256:1313d4bdf22bd11b9b93f237e53dd444814640b25d441b8be3c6ab2f83d31051",
  // 2026-03-31  af3fc9d4  9006B — Telegram channel integration
  "sha256:6dedf734cbc96a7c6a4b842340f3240bbdb85f247ce09393a81474d5db323411",
  // 2026-04-05  fcdd8271  9636B — insecure-mode banner, domain lock
  "sha256:4aee6e3abd76dd352052dca00055cfedcdad813644a10289239b296ab753816d",
  // 2026-04-09  e53fb7e4  10022B — the last and largest hardcoded-knowledge soul
  "sha256:e56305f854afb99d5156a7529ad5cba6717a9fc68b15f29c02beaf6df5bb7950",
  // 2026-04-09  4bf35313  2727B — docs-driven rewrite (pinchy-docs plugin)
  "sha256:3aa3d152bacb77ed6bfee7d48954fe4a4fefd51c35b6db8e7204de17dc8cff62",
  // 2026-04-10  4c6c141c  7741B — post-merge cleanup RESURRECTED the platform
  //   knowledge for six days; this soul is docs-blind despite postdating the
  //   rewrite, which is why the cutoff is 04-15 and not 04-09.
  "sha256:a259c7e98075db8dddd3152dabf638e85d341907770902d02374bfdf45ef17e0",
  // 2026-04-15  e73a13f5  3203B — platform knowledge removed for good
  "sha256:fac4cbf250a79bce3730438372bfbc331b42544338eac2387ed64a599e4066db",
  // 2026-05-19  806cbed1  3853B — public docs URL for citations (current)
  "sha256:4d14d621770155a5916718455b06501da1a23b3b4e3ade6023193c8438b35877",
];

/** Hash of the soul this build ships. Pinned to the last SHIPPED_SOUL_HASHES
 * entry by smithers-soul-history.test.ts. */
export const CURRENT_SOUL_HASH = hashSoul(SMITHERS_SOUL_MD);

/**
 * True when `content` byte-matches a soul Pinchy shipped at some point — i.e.
 * the CONTENT is text we wrote, and nothing else can produce those bytes by
 * accident.
 *
 * Note what this does NOT say: it is no proof that the user never touched the
 * file. Someone who pastes an older shipped soul back byte-for-byte matches
 * too. That is the accepted limit of the design — see the provenance note at
 * the top of this file.
 *
 * The current soul counts as shipped. Callers that want "stale and pristine"
 * must check `hash !== CURRENT_SOUL_HASH` themselves.
 */
export function isPristineShippedSoul(content: string): boolean {
  return SHIPPED_SOUL_HASHES.includes(hashSoul(content));
}
