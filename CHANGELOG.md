# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-11-23

### Changed

- **BREAKING — TLS on all mesh traffic**: the mesh server speaks HTTPS on its
  port (default 4399) and every client call (`sendMail`, `getPools`,
  `postPairCode`) upgrades to TLS when the target does. Peers on 0.10.x can no
  longer send to a 0.11+ node until both hosts upgrade (assumed: mesh hosts on
  a team upgrade together). A documented escape hatch exists: plugin option
  `"insecureHttp": true` opens an extra plain-HTTP listener on port+1, and
  `"tls": false` turns TLS off entirely — both default off.
- **Certificates derive from the node identity**: the Ed25519 key that already
  signs pairing proofs mints the node's self-signed X.509 certificate (a
  minimal RFC 5280 DER encoder in `src/lib/tls.ts`; node:crypto does the
  signing). Zero new trust: the certificate presents the exact key peers
  already pin.
- **Certificate key pinning**: clients verify the peer's certificate SPKI
  against the pinned pairing key during the handshake; a mismatched
  certificate is rejected before any response body is read. Unpinned peers
  (legacy manual pairings) fall back to TOFU semantics.
- **TOFU on code pairing**: the first `POST /pair-code` over TLS accepts the
  peer's self-signed certificate without a pin, then pins the certificate key,
  which must equal the counter-offer's public key (the node key). Subsequent
  connections to that peer are pinned.
- New pairings and discovered 0.11+ peers (mDNS TXT `tls=1`, offer blobs
  `tls: true`) store `tls = 1` in the peers table (schema v7, guarded
  `ALTER TABLE`); `mesh_send` and fanout choose `https` + pin per peer.
- `mesh_pair(code=…, address=…)` addresses an assumed-TLS peer; legacy peers
  discovered over mDNS without the `tls` flag keep plain HTTP.

### Added

- Plugin options `tls` (default `true`) and `insecureHttp` (default `false`).
- `src/lib/tls.ts`: `nodeTlsMaterial(dataDir)` (identity-derived key + cert,
  cached per process), `buildTlsMaterial(identity)`, `certPkSpki(certPem)`.

## [0.10.11] - 2026-11-23

### Fixed

- **Per-tab panel**: the snapshot now exposes the asking session's hats —
  every mailbox bound to that session, each with its own unread count —
  instead of a single `me` mailbox. A multi-hat session (one tab owning
  several agent boxes) sees all of its boxes; the collapsed sidebar shows
  their total unread.

### Changed

- The collapsed header shows the full counters line — unread · agents ·
  pools · hosts — reusing the sidebar summary instead of building a subset.
- Hosts = 1 (this node) + paired peers: a lone node reads "1 hôte", one
  paired peer "2 hôtes".

## [0.10.8] - 2026-11-23

### Fixed

- Wake prompts no longer quote an unread count: a queued prompt can fire
  after the session acked some mail, and a stale number reads as a false
  positive (observed live on a multi-hat session). The prompt now says
  "unread mail waiting" — the signal is the wake itself, mesh_inbox is the
  truth.

### Fixed

- **Bind no-steal**: the TUI mount bind re-bound ALL stamped boxes to the
  currently rendered tab's session on EVERY tab switch — hats churned across
  tabs as the user switched (the "agents drop pools / exchange roles"
  reports). The bind now only recovers boxes whose bound session has NOT
  been seen in this process (dead pre-restart ids); a box bound to a live
  tab's session is never stolen. Restart recovery keeps working.
- Includes 0.10.7-diagnostic: `mesh_status` reports the calling session id.

### Fixed

- **The v2 adapter never passed the fanout to the tools** (lost in a 0.9.4
  merge): every tool-originated broadcast with no local recipients errored
  instead of forwarding — pool federation silently died for `mesh_send`
  broadcasts (the relay path from remote arrivals still worked). The fanout
  is wired again, with a regression test asserting the forward over HTTP.

## [0.10.5] - 2026-11-22

### Fixed

- `mesh_join` / `mesh_leave` / `mesh_send` default to the **most recently
  touched box** of the session (multi-box: the default was the first box by
  creation date — the oldest — so enrollment joins landed on the wrong
  mailbox). Explicit `box=` override available.
- `SCHEMA_VERSION` bumped to 6: the 0.10.3 mailboxes rebuild (drop
  `UNIQUE(session_id)`) never ran on existing v5 stores.

## [0.10.4] - 2026-11-22

### Fixed

- The 0.10.3 mailboxes rebuild (drop `UNIQUE(session_id)`) was dead code on
  existing databases: `SCHEMA_VERSION` was not bumped, so v5 stores skipped
  the migration entirely and multi-box stayed broken on every pre-0.10.3
  database. Version bumped to 6 — the rebuild now runs on open. New databases
  were unaffected (fresh schema already correct).

### Fixed

- **Multi-box sessions**: one TUI wearing several agent hats used to drop the
  previous mailbox at every new enrollment (one-box-per-session rule) — pools
  and roles churned as roles rotated. A session now owns SEVERAL mailboxes:
  `mesh_register` never deletes another box, `mesh_inbox` aggregates all the
  session's boxes (each row labeled with its box), the wake loop aggregates
  per session (one prompt listing the boxes), and `mesh_send` gains an
  optional `box=` to choose the sending mailbox.
- **Sidebar per session**: switching tabs now shows THAT session's state
  instantly (snapshots cached per session id instead of one shared "latest").

### Changed

- Schema v6: `mailboxes` loses `UNIQUE(session_id)` (rebuild migration).

## [0.10.2] - 2026-11-22

### Added

- Code pairing: `mesh_pair()` now emits a **6-digit code** (30 min) instead of
  a raw token blob. The peer runs `mesh_pair(code="482913")` — on the same LAN
  the address is autodiscovered (mDNS), cross-subnet adds `address=`
  (`host:port`). The code endpoint exchanges both offers in one call: the peer
  binds you AND mints a counter-offer you bind automatically — **one command
  each side, both paired**.
- The code is a capability, not a secret: trust stays anchored on the Ed25519
  proof (pk pinned at completion). `POST /pair-code` (unauthenticated
  bootstrap) is rate-limited per source (5 consumed attempts / 5 min).
- Offers now carry the emitter's hostname: paired peers display their real
  name instead of the `manual` placeholder; the sidebar labels legacy manual
  pairings as `id@address`.
- Blob offers (`mesh_pair(offer="MESH1-...")`) kept for agent-to-agent flows
  (files, DMs); legacy node_id/token completion still accepted for older
  mesh versions. Offer TTL raised 5 min → 30 min.

## [0.10.1] - 2026-11-22

### Fixed

- Wrong-mailbox wake attribution after a restart. Session records outlive
  their process: `ctx.session.get` called a dead pre-restart session "alive",
  so the host-wide loop prompted it with mail that belonged to other
  mailboxes (6admin pinged forever over quartermaster's unread delivery,
  while its own `mesh_inbox` read empty — the box was bound to the dead
  session id). The wake loop now only trusts sessions this instance has
  actually SEEN since boot (a mesh tool call or a TUI bind); an unseen
  session's mailbox waits for the agent's first turn, which re-registers and
  re-binds the box per the AGENTS.md check-in convention.

## [0.10.0] - 2026-11-22

### Added

- Pool federation across paired hosts. A broadcast (`to: "team:<pool>"` or
  `to: "all"`) that produced local deliveries is forwarded to the paired peers
  that also hold members of that pool (discovered over a new authenticated
  `GET /pools` endpoint, cached 60 s), where the host-wide wake loop (0.9.3)
  prompts the local members. Boîtes and wake stay local per host — only mail
  travels.

### Fixed

- `mesh_send(peer=<own node id>)` — same-machine sessions share one node —
  used to fall into the global feed unread. It now routes as a local delivery
  when `to` is given, and errors with guidance otherwise.
- A pool broadcast whose only member is the sender (empty local recipients)
  no longer errors when federation can carry it: the origin id is synthesized
  and the mail is forwarded to the remote members.
- Forwarded mail now carries the pairing proof: first contact after a fresh
  pairing (peer token not yet bound on our side) would 401 before the drive-by
  binding had a chance to fire.

### Security

- Broadcast fanout is loop- and duplicate-safe: the wire gains `via`
  (node ids already traversed — a relay never forwards to a listed peer) and
  `origin_id` (a receiver that already stored the broadcast turns the second
  arrival into a no-op).
- New authenticated route `GET /pools` returns the node's local pool map.
- Schema v5: `messages.origin_id`, migrated in place.

## [0.9.4] - 2026-11-22

### Fixed

- No more stale wake prompts for mid-turn sessions. The prompt was queued
  (`delivery: "queue"`) with the unread count baked in at creation time: a
  session running a long turn acked the mail during the turn, then received
  the queued prompt claiming unread messages that were already read (the
  orchestrator's recurring "false positives"). The plugin now tracks running
  sessions from the host's durable execution events
  (`session.execution.started/succeeded/failed/interrupted`) and the wake loop
  skips them — their turn-start check-in reads the box anyway. Prompts fire
  only for idle sessions, so the count is fresh at delivery. When the event
  stream is unavailable, the loop falls back to the previous behavior.

## [0.9.3] - 2026-11-22

### Fixed

- Wake is now host-wide. One opencode process — notably `opencode serve` —
  hosts many sessions, but the wake loop tracked a single "current" session id
  (last mesh tool call), so only that session's mailbox was polled: mail piling
  up in other live mailboxes never woke their agents. The loop now iterates
  every registered mailbox, checks the session lives on this host
  (`ctx.session.get`), and prompts that session — headless sessions included.
  Per-mailbox cooldown, foreign-host and dead-session skips.

## [0.9.2] - 2026-11-22

### Fixed

- Wake reliability: the wake loop only knew the session's id after the first
  mesh tool call, so a freshly restarted (or long-idle) session never woke on
  incoming mail, and a mailbox stayed bound to the dead pre-restart session id.
  Two coexisting binding paths fix it:
  - **Dynamic**: `mesh_register` stamps the mailbox with an instance binding
    key (project id + directory), and the TUI `bind` RPC re-binds every
    stamped box to the live session at mount — restarts and handoffs need no
    configuration and no re-registration.
  - **Static (optional)**: `mailbox` / `mailboxRole` plugin options re-bind
    their box at every mount; on a name collision the last act wins.
  Verified against the host source: `Session.prompt` wakes an idle session
  (`packages/core/src/session/session.ts`, `execution.wake`), so a bound idle
  session reacts to incoming mail within one poll interval.

### Added

- `docs/ORGANIZATION.md`: four multi-team reference models (flat teams with
  bridges, a centralized `tower` orchestrator, a manager hierarchy, ad-hoc
  squads) with mermaid diagrams and the pools-are-announcements convention.
- `wakeIntervalMs` option (default 5000) to tune the wake poll interval.

### Changed

- Schema v4: `mailboxes.bind_key` (instance binding), migrated in place.

## [0.9.0] - 2026-11-22

### Added

- Sidebar v2 (quota-style): collapsible header with toggle (click or
  `mesh.toggleSidebar`), collapsed by default showing `N unread · M agents ·
  K pools`; expanded shows my mailbox with unread count, one line per pool
  with per-member presence (`●` fresh < 2 min, `○` warm < 15 min), peers and
  locks. The snapshot RPC takes an optional `sessionID` (from the
  `sidebar.content` slot input) and resolves the asking session's mailbox,
  per-mailbox presence ages and the pool membership map.

## [0.8.1] - 2026-11-22

### Fixed

- Sidebar collapse state survives TUI restarts even for scoped plugin ids
  (`@scope/name`): the host's storage segment validation rejects them
  (anomalyco/opencode#62634, fix pending in PR #62638), so the collapse state
  is now persisted by the setup side through the raw storage domain under an
  escaped key (`plugin.<escaped-id>.mesh-sidebar`) and synced to the TUI over
  RPC. In-memory remains the last resort on hosts without RPC.

## [0.8.0] - 2026-11-22

### Added

- Named mailboxes: `mesh_register(name, role?)` binds a session to a mailbox;
  `mesh_send(to=...)` routes locally by mailbox name; `mesh_inbox` reads only
  the caller's box. Ends the shared-inbox cross-drain where the first session
  to run consumed every message on the node.
- Pool broadcast: `mesh_join` / `mesh_leave` / `mesh_pools` manage persisted
  pool membership; `mesh_send(to="team:<pool>")` delivers one copy per member
  (sender excluded), `to="all"` reaches every registered mailbox. Per-member
  delivery rows mean each recipient acks independently.
- Request/response: `mesh_wait(id, timeout)` blocks the agent turn until a
  message with `reply_to: <id>` lands, then returns it acked.
- Wake (OpenCode 2.x): the plugin watches the session's mailbox (5s poll,
  60s cooldown) and injects a prompt via `ctx.session.prompt` when unread mail
  arrives, so an idle agent reacts to incoming mail. Disable with `wake: false`.
- Presence: mailboxes carry role, pools and `last_seen`; `mesh_status` shows
  the age of every registered box.
- Remote mailbox addressing: `POST /mail` accepts optional `to`, `from_box`,
  `reply_to`; an unknown `to` falls back to the node's global inbox (old
  receivers simply ignore the fields).
- Retention: messages older than 7 days are swept at server boot.
- Schema v3: `mailboxes`, `deliveries` tables; `messages.from_box` /
  `messages.reply_to`; migration from v2 in place.

### Fixed

- `mesh_send`/`mesh_inbox` tolerate a missing session context (tests, exotic
  hosts) instead of failing on a SQLite bind with `undefined`.

## [0.7.1] - 2026-11-07

### Fixed

- The TUI no longer crashes on hosts whose storage layer rejects scoped npm
  plugin ids (`TypeError: Invalid storage segment`, anomalyco/opencode#62634).
  The sidebar falls back to in-memory collapse state: functional, but not
  persisted across TUI restarts until the host-side fix lands.

## [0.7.0] - 2026-11-06

### Added

- Themed mesh sidebar: bold header and muted peer lines using the active
  theme's text colors.
- Sidebar collapse: the `/mesh` toggle keybind persists its state in durable
  storage, so the collapsed sidebar survives TUI restarts.
- Event refresh: the sidebar refreshes immediately (debounced) on server
  events, with the 15s polling as fallback.
- `/mesh` now opens a dialog with the full snapshot instead of a toast.

## [0.6.0] - 2026-11-06

### Added

- Live mesh sidebar: the TUI part polls a `mesh.snapshot` RPC (registered
  server-side) every 15s and renders the node, one line per paired peer and
  the active lock count. Hidden on v1 hosts and while the server is down.

## [0.5.1] - 2026-11-06

### Fixed

- Peer dependencies aligned with the dual-export pattern: `@opencode-ai/plugin`
  pinned to `^1.18.32` and `@opencode/plugin` to `^2.0.26`, both optional.
  The previous `>=2.0.0` range blocked installation because no matching
  version exists on npm.

## [0.5.0] - 2026-11-05

### Added

- TUI plugin (phase 0+1): toast, `/mesh` slash command, sidebar slot.

## [0.4.1] - 2026-10-24

### Fixed

- The package loads under OpenCode 2 again. The v1 implementation imports
  `@opencode-ai/plugin`, which only v1 hosts resolve, and it sat in the static
  import graph, so v2 hosts rejected the whole plugin at load time
  (`Cannot find package '@opencode-ai/plugin'`). The v1 entry is now loaded
  lazily from `server()`: a v2 host never calls `server()` and therefore never
  resolves the v1-only packages. The named `MeshPlugin` export is type-only.
- The v1 worktree REST factory moved from `lib/worktree.ts` into `plugin.ts`
  for the same reason: it imports `@opencode-ai/sdk/v2`, which must stay out
  of the static import graph too. Shared option plumbing moved to
  `options.ts`, imported by both adapters.
- `smoke:dist` now audits the static import graph of `dist/`: no
  `@opencode-ai/*` import may be reachable statically, `plugin.js` must only
  be reached through a dynamic `import()`, and every other bare import must
  be `@opencode/plugin`, a Node builtin, or a declared runtime dependency.

## [0.4.0] - 2026-10-14

### Added

- Signed pairing offers close the pending-token rebind window (Closes #30).
  Each node keeps an Ed25519 keypair in `node.json` (generated on first run or
  on migration; the `node_id` is preserved). Pairing offers carry the emitter's
  public key (`pk`), completing a pairing pins it, mDNS TXT advertises it, and
  every outgoing mail carries a pairing proof (`<pk>.<signature>` over
  `opencode-mesh-pair:<node_id>:<token>`). A pending token now binds (or
  rotates) a peer row only with a valid proof from the pinned key: a leaked
  offer alone can no longer take over a paired peer's credential. Peers paired
  without a pinned key (0.3.0-era rows, or completions without `pk`) refuse
  remote rebinding: re-run `mesh_pair` to rotate them. `peers` gains a
  `public_key` column (schema version 2, migrated in place).

### Fixed

- Peer addresses in the IPv4-mapped IPv6 form (`[::ffff:192.168.1.10]:4399`)
  are accepted, so a dual-stack resolver's reported address no longer leaves
  its peer unreachable ("no known address with a port"). Portless and
  empty-zone forms stay rejected.

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
