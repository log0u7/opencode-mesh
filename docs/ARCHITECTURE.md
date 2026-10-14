# Architecture

One process per OpenCode session hosts the plugin. It bundles everything:
identity, a SQLite-backed store, an HTTP server, mDNS, tools, or worker
offloading; source under `src/`.

## Components

| Component | Source | Role |
|---|---|---|
| Adapters | `src/plugin.ts` (v1), `src/plugin-v2.ts` (v2) | Validate `options` (`parseOptions`), bootstrap everything, map tool specs onto the host's tool surface (v1 zod, v2 JSON schema). |
| Tools | `src/tools.ts` | The single tool table: 11 `mesh_*` tools with fields and executes, shared by both adapters. |
| Store | `src/lib/db.ts`, `src/lib/sqlite.ts` | SQLite (`bun:sqlite` on the opencode runtime, `node:sqlite` fallback), WAL, 5s busy timeout, schema version (`user_version`), five hot-lookup indexes. |
| Identity | `src/lib/identity.ts` | `node.json` (`{node_id, hostname, public_key, private_key}`) with id continuity across migration; corrupt file fails loud, never remints. The Ed25519 keypair signs pairing proofs. |
| Peers | `src/lib/peers.ts` | Peer rows, pairing tokens, bearer-token auth, address resolution, pairing proofs (sender must sign with its pinned key to bind or rotate a row). |
| Mail | `src/lib/mail.ts` | Append-only messages (`unread`/`read`), unread counters, acks. |
| Server | `src/lib/serve.ts` | HTTP `/mail` + `/status`, loopback binding with an ephemeral fallback. |
| Discovery | `src/lib/discovery.ts` | mDNS advertise/browse (TXT: id + fingerprint), tailnet IPs. |
| Workers | `src/lib/spawn.ts`, `src/lib/workers.ts`, `src/lib/worktree.ts` | Headless opencode run in a fresh worktree: lifecycle, logs, kill escalation, reconciliation. |
| Locks | `src/lib/locks.ts` | Local-only file claims with TTL, atomic claim. |

## Process model

```
opencode (host)
└── plugin (MeshPlugin / MeshV2)
    ├── identity        node.json                 dir 0700, file 0600
    ├── sqlite          mesh.db (WAL)             locks, messages, peers, tokens, workers
    ├── http server     127.0.0.1:port            /mail  /status
    ├── bonjour         advertise + browse        _opencode-mesh._tcp
    └── tools           mesh_*                    exposed to every session
        └── worker      opencode run --dir <wt>   OPENCODE_MESH_CHILD=1
```

The child marker matters: a worker spawned by `mesh_spawn` loads the same
plugin, and the `OPENCODE_MESH_CHILD=1` environment variable makes it skip
booting its own mesh server, advertising over mDNS and registering mesh tools.
A worker pool costs N worktrees, not N mesh nodes.

The data directory holds `node.json` (file mode `0600`, first run), `mesh.db`
(SQLite, WAL) and the `workers/` log files. Then two opencode sessions in the
same repository each boot the plugin against this one directory.

## Worker lifecycle

`mesh_spawn` reserves a worktree (host worktree API, or an injected client),
inserts a `running` registry row (with worktree path and branch), then spawns
`opencode run --dir <worktree> --format json` headless. A spawn that never
started (the `spawnFn` throwing before a child exists, or yielding no usable
pid) finalises the row as `failed`, and `mesh_spawn` then deletes that row and
removes the worktree: no orphan worktree, no stuck row. A child that boots and
then errors (`error` event) is finalised `failed` and keeps its worktree and
log row, since the process was real.

While running:

- The worker's stdout is the session's event stream. Line-buffered JSON is
  parsed to attach the worker's `session_id`; log output is appended to
  `workers/<id>.log`, capped at 512 KiB per file, rotating at that size so a
  chatty worker cannot fill the disk.
- stderr is drained into the same log (bounded): a worker cannot stall because
  nobody reads its stderr pipe.
- `mesh_worker_stop` sends SIGTERM; if the process is still alive after a short
  grace period (`SIGKILL` after ~3s), it escalates, so an ignoring worker
  cannot survive forever. Stopping the host (`dispose`) SIGTERMs every live
  worker: closing opencode never leaves orphans.
- A late `mesh_worker_logs` (`tail` clamped) reads the tail of the log file.
  `mesh_worker_remove` deletes the worktree and the log; `force` stops a
  running worker first.

After a host restart, the in-memory process map is gone but the registry is
not: `reconcileWorkers` marks every `running` row whose pid is gone (or never
was recorded) `stopped` before the tools read the table - a worker that already
detached and survived the crash keeps its `running` row. Terminal statuses are `completed`, `failed`, `stopped`; a transition into/between them is
a single guarded `UPDATE` (`WHERE status NOT IN (terminal)`), so a stale
read-then-write cannot resurrect a finalized row.

## Locks

`mesh_lock(path, ttl)` claims a file path for this machine for `ttl` seconds
(default 600). The claim is a single atomic
`INSERT ... ON CONFLICT(path) DO NOTHING`, so two sessions racing on the same
dir get a clean deny rather than a constraint error. A same-node re-claim
refreshes expiry. Locks are never sent over HTTP.

## Concurrency model

Everything in one process shares one SQLite connection (WAL). Cross-process
concurrency (two opencode sessions in the same repository) is protected by:

- guarded SQL instead of read-modify-write (`tryLock`, `setWorkerStatus`);
- `PRAGMA busy_timeout = 5000` on the shared connection;
- ephemeral-port fallback: a second node on one machine binds a new port, so
  two nodes never collide, they coexist (see `port-collision.test.ts`).

## Data directory layout

```
~/.local/share/opencode-mesh/        (0700, honors XDG_DATA_HOME)
├── node.json        { node_id, hostname, public_key, private_key }   0600
├── mesh.db          SQLite: peers (+ pinned public_key), messages, locks, tokens, workers
├── mesh.db-wal      -- WAL sidecar
└── workers/
    └── <worker id>.log   captured output, rotated at 512 KiB
```