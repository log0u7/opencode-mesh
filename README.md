# opencode-mesh

[![CI](https://github.com/log0u7/opencode-mesh/actions/workflows/ci.yml/badge.svg)](https://github.com/log0u7/opencode-mesh/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@log0u7/opencode-mesh)](https://www.npmjs.com/package/@log0u7/opencode-mesh)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Coordination for [OpenCode](https://opencode.ai): multiple sessions working together on one machine, and a peer pool across a LAN or a Tailscale tailnet.

Each node advertises itself over mDNS, pairs with explicit operator approval (per-peer bearer tokens, deny by default), then sessions can exchange messages (`mesh_send` / `mesh_inbox`) and coordinate on shared work (`mesh_lock` / `mesh_unlock`). Tailscale IPs are picked up automatically when `tailscale status` works, for cross-subnet pools.

## Install

```sh
npm install -g @log0u7/opencode-mesh
```

Then register the plugin in `opencode.json`:

```json
{
  "plugin": ["opencode-mesh"]
}
```

Restart OpenCode. Node identity and mailbox live under `~/.local/share/opencode-mesh/` (honors `XDG_DATA_HOME`), created with restrictive permissions.

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

### Security model

- Every HTTP endpoint requires a per-peer bearer token; nothing is open by default.
- Loopback peers (same machine) are auto-trusted; remote peers require explicit `mesh_pair` approval.
- mDNS TXT records carry node id + key fingerprint only, never secrets.
- LAN-only by default; tailnet reachability is opt-in (`"allow_tailnet": true` plugin option).

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
