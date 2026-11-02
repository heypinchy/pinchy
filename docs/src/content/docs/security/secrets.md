---
title: Secrets & API Key Storage
description: How Pinchy stores, protects, and delivers API keys to the OpenClaw runtime.
---

Pinchy handles your LLM provider API keys — Anthropic, OpenAI, Ollama Cloud, and others. Here's exactly where they live, how they move, and what the limits of that protection are.

## Source of truth: PostgreSQL

API keys are stored in PostgreSQL, encrypted with AES-256-GCM. The encryption key normally comes from the `ENCRYPTION_KEY` environment variable. If you leave it unset, Pinchy auto-generates one at first start and persists it in the `pinchy-secrets` Docker volume so it survives restarts — production deployments should still set `ENCRYPTION_KEY` explicitly so the key is part of your backup/restore story rather than tied to a single volume.

Each row is encrypted with its own nonce and authenticated separately. A single decryption failure (e.g., a corrupted row) does not hide every other integration's credentials — the others stay readable.

When Pinchy reads a key from the database, it decrypts it in memory to reconstruct the OpenClaw config. The plaintext key is never written back to disk by Pinchy itself.

Your database contains ciphertext. Without the `ENCRYPTION_KEY`, the stored values are unreadable.

## The config file contains no secrets

`openclaw.json` — the config file that OpenClaw reads — doesn't contain any actual keys. Instead, it uses SecretRef pointers:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": {
          "source": "file",
          "provider": "pinchy",
          "id": "/providers/anthropic/apiKey"
        }
      }
    }
  }
}
```

OpenClaw resolves these pointers at runtime by reading from the secrets file. The config file itself can be inspected, backed up, or committed to version control without exposing any secrets.

## The runtime secrets file: tmpfs

At startup — and every time you change a provider or integration — Pinchy calls `regenerateOpenClawConfig()`, which:

1. Reads all relevant rows from PostgreSQL
2. Decrypts each value in memory
3. Writes the decrypted keys to `/openclaw-secrets/secrets.json`
4. Tells OpenClaw to re-read that file whenever a key in it was added or changed in place

Step 4 is what makes rotation immediate for the built-in providers and the integrations. OpenClaw resolves each pointer when it loads a configuration and keeps the value until the next config apply or re-read, and for these keys `openclaw.json` is unchanged by a rotation — it carries the pointer, not the key. So a new key would otherwise sit in the file unread until the container restarted, with every agent still presenting the old one.

OpenAI-compatible providers are the exception. Each newly entered key gets a slot of its own, so a rotation does change `openclaw.json`: its pointer now names the new slot. Pinchy deliberately skips the re-read for these keys — the new key reaches OpenClaw together with the configuration that carries the new pointer, and never on its own (see below).

A removed key leaves `secrets.json` with the regeneration that follows its removal from PostgreSQL — a deleted provider's key, and a re-keyed provider's previous slot alike. That includes a regeneration Pinchy refuses because the configuration it built shrank suspiciously — say, a local Ollama that wasn't reachable yet and listed no models: Pinchy does not use the refused configuration, but the key still leaves `secrets.json`, in the order described below. The one exception is a regeneration whose provider list came back empty altogether. Pinchy never lets you remove the last provider, so that is a failed read, not a removal: Pinchy then writes neither file, and the key leaves with the next regeneration that goes through. What needs care is the order. `openclaw.json` refers to the old key until the new configuration has reached OpenClaw, and that can take a while: OpenClaw rate-limits configuration changes, and removing a large provider is handed over in steps that can take a few minutes (see [Remove a provider](/guides/llm-providers/#remove-a-provider)). A pointer to a value that is no longer in `secrets.json` would keep OpenClaw from restarting, make it refuse any configuration that still carries the pointer, and make a re-read fail — say, because you rotated a built-in provider's key meanwhile. So before Pinchy writes `secrets.json` without the key, it rewrites `openclaw.json` so that nothing in it points there any more: the provider stays listed, with its models but without a key. A deleted provider stays like that until the hand-over removes it. A re-keyed provider gets its new key straight after `secrets.json` holds it: Pinchy writes the provider's new entry from the regenerated configuration — new address, new slot and models together. One thing stays from before when the new address serves far fewer models: OpenClaw treats a configuration file under half the size of the last one it accepted as damaged and puts an older copy back — a copy that still points at the removed slot, which would keep OpenClaw from starting. So when the new list would take the file under that line, the provider's entry keeps some of the models it already listed, after the new ones — the fewest that keep the file above the line, so the shorter list can follow without being held back by a file larger than it needs to be (see [Moving a provider to a much smaller endpoint](/guides/llm-providers/#moving-a-provider-to-a-much-smaller-endpoint)). Agents on a model the new address serves keep working. "The last one it accepted" is not always the file on disk: OpenClaw only takes note of a new file while it is running, so with OpenClaw stopped, every file Pinchy writes is compared, at OpenClaw's next start, with the file from before the first of them. Pinchy therefore measures each configuration file it writes against the largest one it has replaced since OpenClaw last applied a configuration, and keeps that size in a small file of its own next to `openclaw.json` (`pinchy-last-good-bound.json`), so a Pinchy restart does not forget it. A configuration file that would fall under the line is not written. The change waits for OpenClaw instead: as soon as OpenClaw is running and connected to Pinchy again, Pinchy rebuilds the configuration from the database and hands it over as an ordinary configuration change — a Telegram bot you disconnected meanwhile included. (If that small file cannot be written, Pinchy logs a warning and keeps the size in memory only, which a Pinchy restart before OpenClaw is back forgets.) Nor does Pinchy ever write a configuration file of its own that points at a key it has taken out of `secrets.json`: a configuration change still waiting to reach OpenClaw that was built before the key left is dropped rather than written — the regeneration that removed the key brings the current configuration. Pinchy decides all of this from `openclaw.json` and the database alone, without reading `secrets.json` — which it can't in production: the OpenClaw container takes ownership of the file as soon as it is written. For the same reason Pinchy cannot tell in production whether a built-in key really changed, so it asks OpenClaw to re-read the file after each regeneration (a re-read that turns out unnecessary costs only a round trip) — except one that has just rewritten `openclaw.json` for a removed key: OpenClaw re-reads every key when it picks up that rewrite, while a re-read requested at once would still see the configuration that points at the removed key, and fail.

The `/openclaw-secrets/` directory is a Docker `tmpfs` mount. tmpfs is RAM-based storage — it's never written to disk, never included in Docker volume exports, and disappears on container restart.

```yaml
# docker-compose.yml (excerpt)
openclaw-secrets:
  driver: local
  driver_opts:
    type: tmpfs
    device: tmpfs
    o: "mode=0770,uid=999,gid=999"
```

The directory is owned by uid/gid 999 (the `pinchy` system user inside the Pinchy container) with mode `0770`. Pinchy writes `secrets.json` as the owner; OpenClaw runs as root in its own container and reads the file regardless of ownership. Inside, `secrets.json` is written with mode `0600` (owner read/write only) as defense-in-depth: even a same-uid process that obtained directory access cannot read another tenant's file.

### OpenAI-compatible providers: the address and the key travel together

OpenAI-compatible providers take a stricter route than the built-in ones, because their address is set by you rather than fixed by Pinchy. A key must only ever reach the address it was entered for, and Pinchy holds to that at three points:

- **Saving.** Changing a provider's base URL needs the key typed again. And a save only lands if the stored address and key are still the ones Pinchy checked it against when the request arrived. If another save changed either in the meantime, nothing is written and the request is answered with `409`.
- **Reading.** Step 1 above reads each provider's address, models and key in a single query, so everything written for a provider comes from one saved state of it. Regenerates run one at a time: the regenerate a save triggers starts only after any regenerate already running has finished, so a save is never mixed into a regenerate that read the provider before it, and a regenerate that read the older state can never write after the one that read the newer. The model list Pinchy fetches during the regenerate uses that same address and key; a list fetched earlier for a different address or key is never reused.
- **Applying.** Each provider's key sits under a slot named for the key itself — `/providers/<slug>@<version>/apiKey`, where the version is a fingerprint of the stored ciphertext — so every newly entered key gives `openclaw.json` a new pointer. The base URL and the key entered for it then reach OpenClaw together, in one configuration change: OpenClaw never sends the new key to the old address, or the old key to a new one. The previous slot leaves the secrets file at once; just before it does, `openclaw.json` stops pointing at it, and right after the new slot is in place, Pinchy writes the provider's whole new entry — address, slot and models from the one saved state the regenerate read — never the new slot next to the address that was on disk (see above). Until OpenClaw has picked that up, it keeps running the previous configuration and the key it resolved for it, which still go together.

## What this protects against

- **Root filesystem analysis** — an attacker with read access to your Docker volume storage won't find plaintext keys in `/var/lib/docker/volumes/`
- **Docker volume exports** — `docker run --volumes-from` or a volume backup contains no secrets because tmpfs doesn't back up
- **Container image inspection** — keys are never baked into the image layer
- **`openclaw.json` leaks** — the config file is safe to share or inspect

## What this does not protect against

tmpfs is RAM. If someone has access to the running process or the host, they can reach the data:

- **Root access to the host** — a host root user can read any container's memory via `/proc/<pid>/mem` or `ptrace`
- **Memory dumps** — a core dump or crash report may contain key material
- **Container escape** — if the OpenClaw container is compromised, `secrets.json` is readable from inside
- **`docker exec` access** — anyone who can `docker exec` into the container can read the file

These are infrastructure-level threats. Protect against them at the host level: locked-down SSH, minimal `docker exec` permissions, and host-level disk encryption for swap (RAM can spill to swap). See the [Hardening Guide](/guides/hardening/) for recommendations.

## How credentials reach plugins: three patterns

Different consumers reach their secrets through different paths. Knowing which pattern applies is useful when something looks wrong in `openclaw.json`.

**Pattern A — OpenClaw resolves SecretRef pointers.** Used for `models.providers.<name>.apiKey` and any `env.<VAR>` template. The flow above describes this pattern in full: ciphertext lives in PostgreSQL, plaintext lands in the tmpfs `secrets.json`, and OpenClaw walks the pointer when it loads its runtime — then keeps the resolved value until Pinchy tells it the file moved. Provider API keys (Anthropic, OpenAI, Google, etc.) all use this path.

**Pattern B — Pinchy plugins fetch credentials at call time.** Used by every Pinchy-built plugin that talks to a third-party SaaS: `pinchy-odoo`, `pinchy-email`, `pinchy-web`. `openclaw.json` only carries the plugin's `apiBaseUrl`, the gateway auth token, and an opaque `connectionId`. The plugin calls `GET /api/internal/integrations/:connectionId/credentials?agentId=<id>` with the gateway token as Bearer auth when it actually needs the credential, caches it in-process with a 5-minute TTL, and invalidates the cache on a 401 so credential rotation works without restarts. The credential itself never appears in `openclaw.json`.

The `agentId` is not decoration. The gateway token is a single secret shared by every plugin, so it answers "is this the OpenClaw container?" and nothing about which connections the caller may read. Pinchy therefore checks the named agent's grant before it decrypts anything, and refuses with `403` — plus an `integration.credentials_denied` audit row — when the agent has no claim to that connection. Because the agent id is asserted by the caller, this is defense in depth on top of the container boundary rather than a replacement for it: it stops a plugin holding the wrong `connectionId`, and it makes a deliberate attempt visible. Scoping the token itself per agent, so possession stops being instance-wide authority, is the structural follow-up.

**Pattern C — Bootstrap credentials in `openclaw.json`.** Used only for `gateway.auth.token` and the matching `plugins.entries.pinchy-*.config.gatewayToken`. These are the trust root for the OpenClaw container and cannot be fetched through Pinchy's API by definition — they are written in plaintext into `openclaw.json` on purpose. The `openclaw-plaintext-scanner` validates that no other provider key prefixes have leaked into the config file. Rotate by regenerating the config (any change in **Settings → AI Provider**) and restarting the OpenClaw container.

The defense-in-depth scan that runs at config-write time recognises known provider-key prefixes (`sk-ant-`, `sk-`, etc.) and refuses to write the config if any appear outside the legitimate Pattern A SecretRef slots.

## Key rotation

If you suspect an API key has been exposed, rotate it at the provider and update it in Pinchy via **Settings → AI Provider**. Pinchy writes the new encrypted value to PostgreSQL, regenerates the secrets file, and tells OpenClaw to re-resolve it, so your agents stop presenting the exposed key without a restart. For a built-in provider that re-read happens right away, usually within seconds, even if a configuration change for another provider is still on its way. For an OpenAI-compatible provider the new key arrives with the configuration that points at its slot, so it takes as long as that config apply does: usually seconds, up to a minute or more while OpenClaw is rate-limiting configuration changes or restarting. See [Rotate an API key](/guides/llm-providers/#rotate-an-api-key) for the operator's view.

## Reporting a vulnerability

If you find a security issue, please report it via the process described in [SECURITY.md](https://github.com/heypinchy/pinchy/blob/main/SECURITY.md). We take security reports seriously and aim to respond within 48 hours.
