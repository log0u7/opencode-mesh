# opencode-mesh

[![CI](https://github.com/log0u7/opencode-mesh/actions/workflows/ci.yml/badge.svg)](https://github.com/log0u7/opencode-mesh/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@log0u7/opencode-mesh)](https://www.npmjs.com/package/@log0u7/opencode-mesh)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Coordination for [OpenCode](https://opencode.ai): multiple sessions working together on one machine, and a peer pool across a LAN or a Tailscale tailnet.

Each node advertises itself over mDNS, pairs with explicit operator approval (per-peer bearer tokens, deny by default), then sessions can exchange messages (`mesh_send` / `mesh_inbox`) and coordinate on shared work (`mesh_lock` / `mesh_unlock`). Tailscale IPs are picked up automatically when `tailscale status` works, for cross-subnet pools.

## Install

Register the plugin in `opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@log0u7/opencode-mesh"]
}
```

Restart OpenCode. The package is installed automatically at startup into opencode's plugin cache (`~/.cache/opencode/packages/`); no global npm/pnpm/mise install is needed (opencode does not consult global installs for plugins). Pin a version if you want upgrades to be explicit:

```json
{
  "plugin": ["@log0u7/opencode-mesh@0.1.1"]
}
```

Node identity and mailbox live under `~/.local/share/opencode-mesh/` (honors `XDG_DATA_HOME`), created with restrictive permissions.

Note (npm 12): the package ships no lifecycle install scripts and needs no `allowScripts` / allowlist on install (its runtime dependency `bonjour-service` has none either).

## Usage

Same machine: start two OpenCode instances in the same repository.

```
mesh_status()                      # local sessions + paired peers
mesh_pair()                        # list discovered peers, approve pairing
mesh_send(peer="laptop", subject="handoff", body="...")
mesh_inbox()                       # pull new messages, ack
mesh_lock(path="src/api.ts", ttl=300)   # claim a file before editing
mesh_unlock(path="src/api.ts")
```

### Tools

| Tool | Args | Description |
|---|---|---|
| `mesh_status` | : local session registry, own address, paired peers. |
| `mesh_pair` | `query?` | List discovered peers; operator approves by hostname/fingerprint. |
| `mesh_send` | `peer`, `subject`, `body` | Deliver a message to a peer's mailbox. |
| `mesh_inbox` | `ack?` | Fetch unread messages; ack marks them read. |
| `mesh_lock` | `path`, `ttl?` | Exclusive claim on a file or worktree path (default ttl 600s). |
| `mesh_unlock` | `path` | Release a claim. |

### Orchestrator

Spawn headless workers in isolated opencode worktrees (native worktree API), track them, and clean up:

```
mesh_spawn(task="implement the parser", name="parser")     # -> worker_id, worktree, branch
mesh_workers()                                             # lifecycle states, session ids
mesh_worker_logs(worker_id="...", tail=50)                 # captured output
mesh_worker_stop(worker_id="...")                          # SIGTERM a running worker
mesh_worker_remove(worker_id="...", force=true)            # worktree + registry row cleanup
```

Workers run `opencode run --dir <worktree> --format json` headless with `--auto` permissions by default (`auto=false` to require approvals). model/agent are optional args (defaults: your local config). `dispose` SIGTERMs every live worker so stopping opencode never leaves orphan processes.

### Security model

- Every HTTP endpoint requires a per-peer bearer token; nothing is open by default.
- All peers, same machine or remote, pair through `mesh_pair`: one side emits a one-time token, the other completes the pairing with it.
- mDNS TXT records carry node id + key fingerprint only, never secrets.
- LAN-only by default; tailnet addresses are surfaced by `mesh_status` when `tailscale` runs, for cross-subnet pools (`"allow_tailnet": true` plugin option, planned).

## Development

Requires Node >= 22 (mise: `mise install`) and pnpm (corepack).

```sh
pnpm install
pnpm verify      # biome + typecheck + vitest
pnpm build:check # tsc build + pack dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[Apache-2.0](LICENSE)
