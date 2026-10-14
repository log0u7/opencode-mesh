# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-14

### Added

- Documentation: `docs/CONFIGURATION.md` (the full options reference), and new
  architecture and wire protocol docs detailing the process model, worker
  lifecycle, data-dir layout, and the HTTP/mDNS/pairing protocol. The README
  links them and documents the plugin options inline.
- Plugin options are validated at setup. A `port` outside `[0, 65535]` or not an
  integer, a `bind` other than `loopback`/`lan`, a non-boolean `advertise`, or an
  empty/non-string `dataDir` now fails fast with a clear message instead of
  surfacing later as `EADDRINUSE`, a bind on the wrong interface, or a data dir
  at the wrong path. `tsconfig.test.json` and a `pnpm typecheck:tests` step
  typecheck the test suite, which `tsconfig.json` (src only) never did.

### Changed

- `engines.node` is now `>=22.5.0` (the first release with `node:sqlite`), and
  `@types/node` is pinned to the max Node major tested in CI (24) instead of 26.
  `scripts/smoke-dist.mjs` now asserts the v2 (`setup`) entrypoint, and
  `biome.json` is migrated to the 2.5.x schema.
- `mesh_lock` is documented and advertised as local to this machine: it is
  enforced between sessions sharing this host's data directory and is not part
  of the wire protocol. A guard test fails the build if a lock route reappears
  on the server.
- Removed the Ed25519 keypair ceremony in node identity: nothing signed or
  verified with it, so the short fingerprint is derived from `node_id`.
  Existing node ids are preserved on upgrade; the fingerprint value changes,
  which may require re-pairing peers.
- Workers spawned by `mesh_spawn` run with `OPENCODE_MESH_CHILD=1` and skip the
  server, mDNS and all mesh tools, so a pool of N workers no longer costs N
  mesh nodes.
- `mesh_worker_logs` reads only the tail of a worker log instead of loading the
  whole file on the host's event loop; `mesh_status` caches `tailscale status`
  for 60s and bounds the subprocess with a 2s timeout.

### Fixed

- The docs no longer claim security behaviour the code does not implement:
  `SECURITY.md` drops the "refuses entries that look like API-key formats"
  promise (no such filtering exists) and the umask-077 claim (the data
  *directory* is created `0700`; the SQLite file itself is not `chmod`ed), and
  the README drops the non-existent `"allow_tailnet"` option while updating its
  stale install pin.
- `mesh_pair` now rejects an empty `node_id` or `token` instead of completing a
  pairing with a credential nobody can present (or that clobbers a peer record).
  A partially-supplied pair (`node_id` without `token`, or vice versa) is an
  error rather than being silently ignored.
- The mesh server reports a body read failure as `400` (malformed request) rather
  than `413` (too large): a client that drops the connection mid-body no longer
  looks like an oversized payload.
- Peer addresses that carry an IPv6 zone id (`[fe80::1%eth0]:4399`) are accepted,
  so a link-local peer is no longer silently unreachable.
- `defaultDataDir()` no longer resolves to a filesystem-root path
  (`/.local/share/opencode-mesh`) when `HOME` is unset or blank: it falls back to
  `os.homedir()`, then `os.tmpdir()`.
- The node identity migration now finishes on disk: a `node.json` written by
  <= 0.2.0 is rewritten without its dead Ed25519 keypair, so the stale key
  material no longer lingers after the id is loaded. A corrupt or `node_id`-less
  `node.json` now fails loudly with a recovery path instead of silently minting a
  new node id, which would break every peer that recognised the node. Closes #31.
- `mesh_lock` no longer throws a raw `UNIQUE constraint failed` error when two
  opencode sessions sharing the same data directory race for the same path. The
  lock claim is a single atomic `INSERT ... ON CONFLICT DO NOTHING`, and the
  worker status transition is a single guarded `UPDATE`, so a stale
  read-then-write can neither raise nor overwrite a concurrently finalized row.
- The mesh database now records a schema version (`PRAGMA user_version`) and
  creates indexes for its hot lookups (unread messages, pending pairing tokens,
  peer tokens, running workers, expired locks).
- On OpenCode 2.x hosts, `mesh_spawn` and `mesh_worker_remove` no longer hand the
  raw `ctx.worktree` domain to the REST-shaped worktree client. The in-process
  domain (which resolves payloads directly, without the v1 `{ data, error }`
  envelope) is wrapped back into that shape, and an injected
  `options.worktreeClient` now takes precedence. Closes #29.
- Worktree create/remove calls on the 1.x REST client are bounded by a 15s
  timeout. A create response with no directory, or a remove response that is
  not a boolean, now raises a clear error instead of persisting an `undefined`
  directory. When the 2.x domain reports only a directory (no branch), the
  worker's branch falls back to that directory's name.
- A spawn that fails before the child runs no longer leaks its worktree:
  `mesh_spawn` removes the worktree and the dead registry row when the child
  never starts or `runWorker` throws. `mesh_worker_remove` keeps the registry
  row when the worktree was not actually removed, instead of orphaning it.
- Node runtime support: the published package no longer calls `require()` from
  ESM modules. The Node fallback paths (`node:sqlite` engine, `node:crypto`)
  now use static and dynamic imports and actually run. Vitest's module runner
  injects a `require`, which hid the `ReferenceError` from the suite, so
  `scripts/smoke-dist.mjs` loads the built package under plain Node and is part
  of `pnpm verify`.
- `mesh_send` no longer derives the peer's port from the local node. Discovered
  addresses now carry the port from the mDNS SRV record (`[ipv6]:port` for IPv6
  literals), and a portless address is refused instead of resolving to a wrong
  socket. Peers that fall back to an ephemeral port are now reachable.
- Workers killed through `mesh_worker_stop` no longer orphan their own child
  processes: workers are detached process-group leaders and a stop takes the
  group down. The late `exit` event after a deliberate stop no longer throws;
  a host restart reconciles `running` rows whose pid is gone.
- A worker that fails to start (binary missing, `error` event with no `exit`)
  is now finalized as `failed` instead of staying `running` forever with a
  leaked live entry; a `-1` pid is never persisted. `mesh_spawn` reports the
  failure instead of a success envelope.
- A worker's stderr is drained into its log; a child writing more than the pipe
  buffer (~64 KB) to stderr no longer blocks. `mesh_worker_stop` escalates
  `SIGTERM` to `SIGKILL` after 3s so a worker ignoring the signal cannot linger.
- Worker logs are capped at 512 KB (rotated to `<id>.log.1`) and deleted by
  `mesh_worker_remove`, so a chatty worker cannot fill the disk.
- A JSON line split across two stdout chunks is now reassembled before parsing,
  so a worker's `session_id` is captured instead of silently dropping to null.
  A session id arriving after the row is terminal is ignored.

### Security

- The mesh HTTP server binds to `127.0.0.1` by default. `"bind": "lan"` opts
  into listening on all interfaces, and `mesh_status` / the `mesh_pair` offer
  report the address actually bound instead of a hardcoded loopback string.
- Pairing offers expire after 5 minutes, are pruned on check, and a pending
  token alone no longer installs a permanent peer: the claimed node must
  already be known to this host (mDNS discovery or explicit `mesh_pair`).
  Auto-pairing a previously unknown node id is gone.
- Discovered peers keep their hostname and fingerprint through pairing instead
  of collapsing to `"pending"`, so `mesh_status` still shows a real identity.

### Removed

- `/announce` endpoint, its parser and `touchAddress` (no client ever called
  the route).

## [0.2.0] - 2026-10-12

### Added

- Dual-export plugin entry for OpenCode 2: one published package runs on both
  OpenCode 1.18 and 2.x (official migration pattern, "Support V1 and V2 from
  one package"). v1 hosts call `server()` (unchanged); v2 hosts call `setup()`
  (`Plugin.define`). Both entries drive the same engine.

## [0.1.2] - 2026-09-23

### Changed

- Install docs describe opencode auto-install into its plugin cache; global npm/pnpm/mise installs are not used for plugin loading.
- `mesh_status` now reports active locks, matching what `mesh_lock` errors have always told the model to check.

### Removed

- Over-engineering audit cuts: test-only `pairPeer` helper (tests pair via `pairWithToken`), constant `MailMessage` fields (`to`/`session_id` were constants absent from the schema), `onSpawned` hook (never set), `rememberPeer` one-line delegate (folded into `upsertDiscoveredPeer`), dead `BunSqliteModule` interface, internal-only exports unexported (`defaultKill`), duplicated row types reused via `Omit`, `V1PluginModule` alias inlined.

## [0.1.1] - 2026-09-23

### Changed

- No functional changes: first release shipped through the tag-driven trusted-publishing pipeline (GitHub Actions OIDC, npm provenance attestation).

## [0.1.0] - 2026-09-18

### Changed

- Dev deps: vitest 5 with @vitest/coverage-v8 5 (coverage gate unchanged: 90/80).
- Trunk-based workflow: `main` is the only branch (PRs required, protected by rulesets); `dev` removed.

### Added

- Orchestrator: `mesh_spawn` runs tasks as tracked headless workers in isolated opencode worktrees (native worktree API), with `mesh_workers`, `mesh_worker_logs`, `mesh_worker_stop`, and `mesh_worker_remove`; plugin dispose SIGTERMs live workers.
- Coverage gate in CI: 90% lines/functions, 80% branches (`pnpm test:coverage` locally).
- Dependabot group coupling vitest with @vitest/* (coverage provider) so major bumps arrive together.
- CONTRIBUTING.md documents the mandatory test-first flow and the solo-maintainer merge preference.
- CONTRIBUTING.md documents the Dependabot dependency PR routine (criteria, maintainer approval, workflow-file merge options).
- Project scaffold: Apache-2.0 license, CI (biome + typecheck + vitest + gitleaks, Node 22/24 matrix), npm publish via trusted publishing, issue and PR templates, Dependabot, lefthook pre-commit.

### Fixed

- Install docs register the scoped plugin name in `opencode.json` (an unscoped spec would attempt to install a nonexistent npm package).
- Removed a stray committed PR body file (`.pr-body.md`).
- Runtime compatibility with the installed OpenCode binary: ephemeral-port fallback for mesh servers, in-process fetch reuse for the worktree API in `opencode run` mode, `bun:sqlite` module resolution for hot-loaded plugins, and workers defaulting to `--agent build`.
- CI gitleaks job no longer fails on Dependabot pull requests (push-only).
