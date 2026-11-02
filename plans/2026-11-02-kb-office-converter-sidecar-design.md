# Office conversion in a network-less sidecar — design

Follow-up to PR #1243 (v0.10.0 release review, finding 1).

## Problem

The knowledge base converts `.doc/.docx/.ppt/.pptx` to PDF with LibreOffice.
Until now `soffice` ran **inside the `pinchy` container**: the container that
has a network (the Docker network, and through it the internet and the host),
and that mounts `/openclaw-config`, the secrets tmpfs, `pinchy-secrets` and the
agent workspaces. Anyone who can write to a mounted share can plant the file
LibreOffice opens.

#1243 hardened that path: a locked LibreOffice profile
(`BlockUntrustedRefererLinks`, `Link = 2`, a dead proxy), a content-sniffing
preflight that strips every external relationship, zip-bomb limits. All of that
is _configuration of a process that still has the capability_. A LibreOffice
release that learns a new way to fetch, or a parser bug in the legacy binary
filters, walks straight past it.

This change removes the capability itself.

## Decision

A separate Compose service, `office-converter`, runs `soffice`:

| Property            | Value                                  | Why                                                                         |
| ------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `network_mode`      | `none`                                 | Only `lo` exists. No route to the Docker network, the host or the internet. |
| volumes             | `pinchy-office-spool` only             | No `/openclaw-config`, no secrets, no `/data`, no artifact store.           |
| `environment`       | none                                   | Nothing secret to inherit.                                                  |
| `read_only`         | `true` (+ tmpfs `/tmp`)                | A compromised converter cannot persist anything in the container.           |
| `cap_drop` / `user` | `ALL` / `999:999`, `no-new-privileges` | No root, no capabilities.                                                   |
| image               | the **Pinchy image**, other entrypoint | See below.                                                                  |

### Why the Pinchy image and not a new one

A dedicated image would drop ~420 MB from the web image, but it is one more
image to build in CI, publish on release, pre-pull in the DigitalOcean image,
and — the deciding cost — mirror into every air-gapped install. Reusing the
image costs nothing operationally. The security question is not "is the binary
on disk" but "which process parses the untrusted file, with what reach": the
web image sets `KB_OFFICE_SPOOL_DIR`, so the web process never spawns `soffice`
again, and the only process that does has no network and no secrets. An
attacker who already executes code in the web container gains nothing from a
LibreOffice binary.

Compose resolves an image built by another service in the same project (checked
with Compose v5.1: service B with `image: X` and no `build:` uses the X that
service A builds), so the dev and E2E overlays only have to point the converter
at the same image reference as `pinchy`.

### Protocol

HTTP over a **Unix socket** that lives in the spool volume
(`<spool>/converter.sock`). A Unix socket needs no network namespace, so it is
the one channel `network_mode: none` leaves open, and it is reachable only by
containers that mount the spool.

1. Web stages the batch under `<spool>/<uuid>/{in,out,profile}` — the same
   index-named, preflight-checked copies as before. The spool is mounted at the
   same path in both containers, so paths need no translation.
2. Web sends `POST /convert {batch, inputs: ["0.docx", …], timeoutMs}`.
3. The sidecar validates the request (uuid, `<n>.<office ext>` names, bounded
   timeout) and derives every path itself — it never takes an absolute path
   from the request — then writes the locked profile and runs `soffice`, exactly
   the code that ran in-process before (`office-soffice.ts`).
4. Response: `{code, signal, stderr, timedOut}` — the existing `ConverterResult`.
   OOM and timeouts keep their meaning: the sidecar reports the SIGKILL it saw,
   and a sidecar that dies mid-request is a connection error → `infrastructure`.
5. Web reads `<spool>/<uuid>/out/<n>.pdf`, verifies it and moves it into the
   artifact store. The store is a different volume, so `put()` falls back from
   `rename` to copy-then-rename on `EXDEV` — the commit stays atomic.

The `RunConverter` seam is unchanged; `ConvertOptions` gains
`createStagingDir`, because where a batch is staged is now the converter's
business, not the store's.

### Failure modes

- **Sidecar absent** (an upgrade that kept the old `docker-compose.yml`): the
  socket does not exist → every Office document is `infrastructure` with
  "office converter is not reachable … is the office-converter service
  running?". Retryable, never branded unreadable. There is **no fallback to
  in-process conversion** — a fallback would be the capability we are removing.
- **Sidecar OOM**: it now has its own `OFFICE_CONVERTER_MEM_LIMIT` (default
  `1g`), so a large conversion no longer squeezes the web process and the
  embedder. The OOM reason names that variable.
- **Crash leftovers in the spool** are pruned after 24 h when the next batch is
  staged (a batch's own budget is minutes).

### What stays in the web container

- `catdoc`/`catppt` (the independent word-count oracles) still run in the web
  container. They are small C parsers of the same untrusted input and would be
  the next candidate for the sidecar; out of scope here, noted as follow-up.
- pdfjs reads the produced PDF in the web process, as before.

## Evidence

- `office-convert.sidecar.canary.test.ts` (docker-gated, run in CI's
  `docker-smoke` job against the PR's image): **every** #1243 hardening is
  switched off — stock profile, unsanitized files. CONTROL: the same image on a
  bridge network fetches from a host listener. BOUNDARY: the shipped
  `office-converter` service definition (`docker compose run`) converts the
  same files and the listener hears nothing; a socket probe from inside gets
  `ENETUNREACH` to the same address, and `lo` is the only interface.
- `docker-smoke` also converts a document through the **running** production
  stack, stops the sidecar and proves the next conversion becomes
  `infrastructure` — i.e. the web container really does not convert on its own.
- Unit tests pin the protocol (both sides), the default wiring, the `EXDEV`
  commit, and a Compose drift guard pins the service's isolation properties.

## Not done

- CapRover: Swarm services cannot use `network_mode: none`, and the CapRover
  template mounts no `/data` corpus. Office conversion there reports the
  converter unreachable; documented in the CapRover README.
- A seccomp profile that refuses `socket(AF_INET)` outright would need a file
  next to `docker-compose.yml`, which a `curl`-only install does not have.
