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
| `cap_drop` / `user` | `ALL` / `998:999`, `no-new-privileges` | No root, no capabilities, and not the web process's uid (see below).        |
| image               | the **Pinchy image**, other entrypoint | See below.                                                                  |
| `init`              | `true`                                 | Reaps what a killed conversion leaves; makes orphans recognisable.          |

### Its own uid, the web process's group

The converter runs as `pinchy-office` (uid 998), in the `pinchy` group (gid
999); the web process is `pinchy` (uid 999). With one shared uid every mode in
the spool would be meaningless: the converter could rewrite a staged input
between the preflight and the conversion, rename another batch, or replace
anything the web process reads back. With its own uid the web process owns the
spool and every batch directory, and the group grants exactly what the
converter needs:

| Path                     | Mode   | Converter can                                             |
| ------------------------ | ------ | --------------------------------------------------------- |
| `<spool>`                | `1770` | create entries of its own (its socket); not touch a batch |
| `<spool>/<uuid>`         | `0750` | enter and list; not create, rename or remove anything     |
| `<spool>/<uuid>/in`      | `0750` | read the staged copies; not change or replace them        |
| `<spool>/<uuid>/out`     | `1770` | write the PDFs; remove only what it wrote                 |
| `<spool>/<uuid>/profile` | `1770` | write its LibreOffice profile; remove only what it wrote  |
| `<spool>/converter.sock` | `0660` | (its own) — the web process connects through the group    |

The modes are set with `chmod` after `mkdir`, since the process umask would cut
a mode passed to `mkdir`. The image creates the spool `1770`, and a fresh named
volume copies that mode (checked); `entrypoint.sh` sets it again on every start
for a volume that already exists, and removes a socket a converter of an older
build left under another uid, which the converter could not replace in a sticky
directory. Staged inputs are written with exclusive create (`wx`), so nothing
already at a staged name is ever written through, and with an explicit mode
`0640`: a umask can only remove bits, so the group can never write the checked
copy, even under a user-private-group umask of `002`.

The converter runs with umask `007`, so its output is group-writable, and it
empties `profile/` itself after each batch and, for every batch in the spool,
when it starts (LibreOffice picks the modes of the directories it creates
there, and a converter that died mid-batch leaves them). LibreOffice's
`TMPDIR` is `profile/tmp`: it removes its temp files only on a clean exit, and
the container's `/tmp` is a tmpfs that outlives every batch and counts against
its memory. It does not empty
`out/` when it starts: a PDF there may be one the web process is about to take.

The converter can create entries of its own in the spool root, `out/` and
`profile/`, and rearrange them at any time, so the web process — the one that
holds the secrets — treats everything there as the converter's and never
walks into it:

- It removes a batch entry by entry: its staged inputs, whatever sits directly
  in `out/` and `profile/` (unlinked, never followed), then the directories it
  made. A directory the converter left keeps the batch; that costs a leftover
  in the spool and a warning, not the batch's results.
- It prunes only stale batches that are real directories it owns (`lstat` and
  uid), never an entry the converter made in the spool root.
- It opens an output with `O_NOFOLLOW | O_NONBLOCK` and takes it only if it is
  a non-empty regular file, so neither a link nor a FIFO can redirect or stall
  it; an output it cannot open is that document's `infrastructure` outcome,
  not the batch's.
- It reads at most 64 KB of an answer (a real one is a few fields and at most
  8 KB of stderr).

Verified against the real image, as the two uids: the converter's
`mv`/`rm` of a batch, of a staged input and of a file the web process put in
`out/` fail; writing `in/` fails; writing `out/` works; the web process
converts a document through the sidecar and removes the whole batch.

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
   the code that ran in-process before (`office-soffice.ts`). Afterwards it
   empties the profile and checks that nothing it ran is still running (below).
4. Response: `{code, signal, stderr, timedOut}` — the existing `ConverterResult`.
   OOM and timeouts keep their meaning: the sidecar reports the SIGKILL it saw,
   and a sidecar that dies mid-request is a connection error → `infrastructure`.
5. Web copies `<spool>/<uuid>/out/<n>.pdf` into a private directory inside the
   artifact store (below), verifies that copy and renames it into place — one
   volume, one atomic rename. `put()` still falls back to copy-then-rename on
   `EXDEV` for a caller that hands it a path on another volume.

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
- **A process outlives its batch** (a group kill that missed one, something that
  moved out of its group): it could still write into the batch the web process
  is about to read, or into the next one. After every batch the sidecar reads
  `/proc` for orphans — processes whose parent is the init (`init: true`) and
  that are not the server — with a two-second grace for one on its way out. If
  one is left, the batch is answered with an error (`infrastructure`, retried
  on the next run) and the sidecar exits; the restart policy brings up a clean
  container. The server's own children are not counted: `soffice` has exited
  by the time a batch answers, and tsx keeps an `esbuild` child for the
  server's whole life. Processes `docker exec` starts (the healthcheck) have no
  parent inside the container and are not counted either. Verified in the
  image: a planted orphan turns the next batch into `infrastructure` and one
  restart; the batch after converts. A batch answers once `soffice` has
  exited, even when something it started still holds its stderr open: after a
  two-second drain the group is killed and the pipe closed, and anything that
  left the group is an orphan the check finds. The recycle does not depend on
  the web process still listening for the answer. No exit removes the socket —
  neither this one nor a stop by Docker (`docker compose restart`, a changed
  `OFFICE_CONVERTER_MEM_LIMIT`, a host restart) — so until the new process
  listens a connection is refused rather than missing: the web side retries a
  refused connection for up to 20 s before it books the batch (`not answering
… docker compose logs office-converter`), and fails at once only when there
  is no socket at all — no converter service, which waiting would not change.
  The next start replaces the leftover socket atomically — it binds under a
  temporary name and renames that over it — so the path is never missing in
  between. A batch already in flight when the converter is stopped gets its
  connection closed, and is booked with that reason (`closed the connection
before answering`), retried on the next run. Once `soffice` has exited, the
  batch's time budget no longer applies, so a stderr drain cannot turn a
  finished batch into a timed-out one.

### What stays in the web container

- `catdoc`/`catppt` (the independent word-count oracles) still run in the web
  container. They are small C parsers of the same untrusted input and would be
  the next candidate for the sidecar; out of scope here, noted as follow-up.
- pdfjs reads the produced PDF in the web process, as before.

### What the converter can still see

Nothing secret, but not nothing:

- **The image's own filesystem** — the application code (AGPL, public), its
  `node_modules`, the embedding model, `/etc`. The paths the web container
  mounts config, secrets, workspaces and the corpus at exist only as the
  image's empty mountpoints. The canary asserts that.
- **The spool** — read-only, except for what it writes itself. It can read
  its own batch's staged copies and, in principle, those of another batch
  staged at the same moment; it cannot change, replace, rename or remove any
  of them, nor anything else the web process put there. Ingest converts one
  batch at a time per instance (one index job per org, sequential batches),
  and a batch directory is a random UUID a document cannot know, so a
  `file://` reference into the spool can in practice only reach the
  document's own staged copy. It can create entries of its own in the spool
  root and in a batch's `out/` and `profile/`; the web process never walks
  into them (above).

The #1243 review found a reference the profile does not stop: an INTERNAL
`aFChunk` relationship. With this LibreOffice the HTML-chunk form does not
import, but a Word document nested as the chunk does, and its `file://`
picture is read — a PNG is drawn in, an SVG's text becomes searchable PDF
text. The canary carries both: CONTROL with the files at a web-container path
leaks, the shipped service converts the same documents with nothing.

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
- Unit tests pin the protocol (both sides), the batch modes, the socket mode,
  the leftover check, the default wiring, the `EXDEV` commit, and a Compose
  drift guard pins the service's isolation properties — the separate uid and
  shared gid, and the spool's mode in the image and the entrypoint among them.

## Not done

- CapRover: Swarm services cannot use `network_mode: none`, and the CapRover
  template mounts no `/data` corpus. Office conversion there reports the
  converter unreachable; documented in the CapRover README.
- A seccomp profile that refuses `socket(AF_INET)` outright would need a file
  next to `docker-compose.yml`, which a `curl`-only install does not have.
