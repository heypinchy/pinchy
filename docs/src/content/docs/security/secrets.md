---
title: Secrets & API Key Storage
description: How Pinchy stores, protects, and delivers API keys to the OpenClaw runtime.
---

Pinchy handles your LLM provider API keys — Anthropic, OpenAI, Ollama Cloud, and others. Here's exactly where they live, how they move, and what the limits of that protection are.

## Source of truth: PostgreSQL

API keys are stored in PostgreSQL, encrypted with AES-256-GCM. The encryption key comes from the `ENCRYPTION_KEY` environment variable in your `.env` file.

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

That path is a Docker `tmpfs` mount. tmpfs is RAM-based storage — it's never written to disk, never included in Docker volume exports, and disappears on container restart.

```yaml
# docker-compose.yml (excerpt)
openclaw-secrets:
  driver: local
  driver_opts:
    type: tmpfs
    device: tmpfs
    o: "mode=0770,uid=999,gid=999"
```

The directory is owned by uid 999 / gid 999 (the `pinchy` system user inside the Pinchy container) with mode `0770`. Pinchy writes `secrets.json` as the owner; OpenClaw runs as root in its own container and reads the file regardless of ownership. Inside, `secrets.json` is written with mode `0600` (owner read/write only) as defense-in-depth: even a same-uid process that obtained directory access cannot read another tenant's file.

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

## Key rotation

If you suspect an API key has been exposed, rotate it at the provider and update it in Pinchy via **Settings → Providers**. Pinchy will write the new encrypted value to PostgreSQL and regenerate the secrets file immediately.

## Reporting a vulnerability

If you find a security issue, please report it via the process described in [SECURITY.md](https://github.com/heypinchy/pinchy/blob/main/SECURITY.md). We take security reports seriously and aim to respond within 48 hours.
