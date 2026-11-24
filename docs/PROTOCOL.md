# Protocol

How mesh nodes talk. The mesh is deliberately simple: mDNS for discovery,
bearer tokens for auth, a handful of HTTP routes.

## Discovery (mDNS)

Each node publishes a DNS-SD service:

- Service type: `_opencode-mesh._tcp` (Bonjour type `opencode-mesh`).
- Service name: the advertising node's `node_id` (a random UUID).
- SRV port: the mesh HTTP server port.
- TXT records: `id` = `node_id`, `fp` = a 16-hex-char fingerprint derived from
  the node id (SHA-256 prefix), `pk` = the pairing public key (Ed25519 SPKI,
  base64). TXT carries **no secrets**: keys are public by construction.

The browser filters entries with no `id`. Each advertised A/AAAA address is
combined with the SRV port into `host:port` (bracketed for IPv6); a record
without a port yields no address, since guessing the local port reaches the
wrong socket.

Tailnet IPs (`tailscale status --json`, `Self.TailscaleIPs`) are surfaced by
`mesh_status` for cross-subnet pools and cached for 60s. The `tailscale` CLI is
absent-or-failing: an empty list, never an error.

## Pairing

Each node signs with the Ed25519 key stored in `node.json` (`public_key` /
`private_key`, generated on first run or on migration from an older format;
the `node_id` is preserved so peers stay recognised). The key is distributed
two ways: the pairing offer carries it (`pk="..."`), and mDNS TXT advertises it
as `pk`. A peer row pins the key of the node it paired with (`peers.public_key`).

**Code pairing (0.10.2, default).** One 6-digit code per pairing:

1. Host A runs `mesh_pair` with no args: the host generates a pending token
   (32 random bytes, base64url, stored in `pending_tokens` with `created_at`,
   a 6-digit `code` and the emitter's `hostname`) and prints
   `pairing code: 482913 (valable 30 min)` plus the command to run on the peer.
2. Host B runs `mesh_pair(code="482913")`. On the same LAN the candidate
   addresses come from mDNS discovery; across subnets pass
   `address="host:port"`.
3. B sends both offers to A in one `POST /pair-code` call: A consumes its
   pending offer, binds B from B's offer blob (hostname, socket address as
   peer address) and returns a fresh counter-offer blob. B binds it
   automatically — one command per side, both paired.

The code is a capability naming the pending offer, not a secret: it grants
nothing on its own and dies with the offer after 30 minutes. Trust stays
anchored on the Ed25519 proof: the offer's `pk` is pinned at completion. The
blob carries the emitter's hostname, so paired peers display their real name
instead of the `manual` placeholder (legacy manual rows are labeled
`id@address`).

**Offer blob.** `MESH1-<base64url JSON>` decoding to
`{node_id, token, pk, address?, hostname?}`: the whole handshake payload in
one copyable string. `mesh_pair(offer="MESH1-...")` completes it directly
(agent-to-agent flows: files, DMs); it is also the `/pair-code` request body.

**Legacy completion (node_id/token, older mesh versions).**

1. Either side runs `mesh_pair` with no args: the host generates a token
   (32 random bytes, base64url, stored in `pending_tokens` with a `created_at`
   timestamp) and prints something like
   `mesh_pair(node_id="...uuid...", token="...", address="127.0.0.1:4399", pk="...")`.
2. The operator relays the offer out of band (chat, not the mesh).
3. The peer runs
   `mesh_pair(node_id="...", token="...", address="host:port", pk="...")`
   to pair in the other direction. `node_id` and `token` must be non-empty;
   the offer's `pk` pins the emitter's signing key on the completing side.
4. When the offer's host sees the peer drive-by (a mail arriving with the
   pending token as bearer), the pending token alone grants nothing:
   - the claimed sender must already be a peer this host knows (paired, or
     discovered over mDNS), and
   - the mail must carry a **pairing proof**: `proof = "<base64 spki>.<base64
     ed25519 signature>"`, the signature being over the canonical payload
     `opencode-mesh-pair:<node_id>:<token>`.
   - For a first bind, the proof's key is pinned on the row (discovery-pinned
     keys must match). For a **rebind of an already paired peer**, the proof
     key must BE the pinned key: a leaked offer cannot rotate a live
     credential. Legacy rows paired without a key (0.3.0-era or manual
     completion without `pk`) refuse remote rebinding entirely; rotation goes
     through the operator re-running `mesh_pair`.

Offer tokens expire after 30 minutes (`PAIRING_TOKEN_TTL_MS`, raised from
5 minutes in 0.10.2) and are pruned on
every auth check that reaches the pending lookup (a valid paired token short-
circuits earlier). Completing a pairing consumes the pending token and
upserts the peer record `paired = 1` with the token per node id (one token per
peer; the latest pairing wins). Every outgoing mail carries a proof signed by
the sender's key, so the receiving side can attest the sender whenever it
needs to bind or rotate that sender's row. mDNS-discovered keys never
overwrite the pinned key of a paired row (an attacker reannouncing a node id
cannot swap its trust anchor).

## HTTP API

Every endpoint requires `Authorization: Bearer <token>`; nothing is open by
default except the pairing bootstrap `POST /pair-code` (rate-limited). Tokens
are matched against `peers.token` (`paired = 1`) and, for the pending path,
the node must already be known.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/mail` | peer token | `{"from": "...", "subject": "...", "body": "...", "proof"?: "<pk>.<sig>", "to"?: "<mailbox or team:<pool> or all>", "from_box"?: "<sender mailbox>", "reply_to"?: "<message id>", "via"?: ["<node id>", ...], "origin_id"?: "<message id>", "wake"?: true}` | `200 {"ok": true, "unread": N, "delivered": M}` |
| `GET` | `/status` | peer token | none | `200 {"node_id": "...", "unread": N}` |
| `GET` | `/pools` | peer token | none | `200 {"pools": {"<pool>": ["<mailbox>", ...]}}` |
| `POST` | `/pair-code` | none (bootstrap) | `{"code": "482913", "offer": "MESH1-..."}` | `200 {"ok": true, "counter_offer": "MESH1-..."}` |
| `POST` | `/spawn` | peer token + Ed25519 | `{"spec": {"task": "...", "name": "...", "role": "worker", "pools": ["team:x"]}, "from": "<node id>", "from_box"?: "<parent mailbox>", "nonce": "<uuid>", "ts": <epoch ms>, "sig": "<base64 ed25519>", "proof"?: "<pk>.<sig>"}` | `200 {"ok": true, "worker_id": "...", "hostname": "...", "name": "..."}` |

The optional mail fields (`to`, `from_box`, `reply_to`, `via`, `origin_id`)
carry mailbox routing across nodes. A receiving node that recognizes the
addressed mailbox delivers the mail into that box; an unknown `to` falls back
to the node's global inbox so mail is never silently dropped (unchanged by
federation). Older receivers ignore the extra fields entirely (global inbox),
which keeps mixed-version pools working.

Two fields exist for broadcast fanout (0.10.0): `via` is the anti-loop list —
every node that forwards a broadcast appends its node id and never forwards to
a peer already listed; `origin_id` is the original message id — a receiver
that already holds a message with that `origin_id` skips the second delivery.

`GET /pools` returns the node's local pool membership (one mailbox list per
pool). A node that delivers a `team:<pool>` or `all` broadcast locally — sent
by a local session or received from a peer — forwards it to paired peers with
at least one member in that pool (discovered via `GET /pools`, cached 60 s);
`via` + `origin_id` keep the fanout to a single delivery per node.

`POST /pair-code` is the pairing bootstrap: no bearer token, the 6-digit code
is the capability. It consumes the pending offer matching `code`, binds the
caller from its `MESH1-` offer blob, and returns a counter-offer blob the
caller binds to complete the pairing.

`POST /spawn` is the distant spawn (0.24.0): a paired peer births an ENROLLED
fleet agent on this node. The request is authenticated twice: the pairing
token (with the standard `proof` so a pending token binds like on `/mail`),
then an Ed25519 signature (`sig`, base64) over the canonical payload
`opencode-mesh-spawn:<from>:<nonce>:<ts>:<JSON spec>` — the receiver rebuilds
it from its own parse and verifies it against the key it PINNED for `from`
(a peer row without a pinned key is refused: no TOFU on a token-authenticated
channel). Replay defense is two-fold: `ts` must sit inside a 5 minute window
and the `(from, nonce)` pair must be unseen. Reception is deny-by-default: the
operator opts in with `acceptSpawn` (default `false`), and `spawnQuotaPeer`
(default 2) caps how many enrolled workers ONE requesting peer may keep
running here. On acceptance the node executes its own local enrolled-spawn
path (worktree, enrolled child, self-enroll header), stamps the registry row
with the requesting peer, answers `200 {"ok", "worker_id", "hostname",
"name"}`, and DMs the parent's mailbox (`from_box`)
`spawned <name> on <hostname> (worker <id>)`. The worker then lives on the
receiving node's registry: the parent does not manage it remotely (v1) — the
spawned agent posts its own `status:` to the pools like any member, and
reaping is the receiving side's job (`mesh_worker_stop` there).

Status codes:

- `400`: malformed mail body (the receiver could not parse `{from, subject,
  body}` as strings) or a body read failure (socket error, abort mid-body).
- `401`: missing/unknown token, or the mail `from` does not match the token's
  node id.
- `403`: `/spawn` refused with an explicit message: `acceptSpawn disabled`
  (the default), the requesting peer has no pinned key, a stale request
  (outside the 5 min window), an invalid signature, a replayed nonce, or the
  per-peer spawn quota reached.
- `404`: unknown route, or an unknown/expired pairing code on `/pair-code`.
  `/lock`, `/locks`, `/unlock`, `/announce` are
  deliberately absent: locks are local-only and never part of the wire protocol
  (a regression test guards this).
- `405`: wrong method for an existing route.
- `413`: body over the 64 KiB limit, by header or by counting.
- `429`: `/pair-code` rate limit exceeded — 5 attempts per 5 minutes per
  source address.

- Sender binding: a paired token from one node id cannot mail as another node
  id (`from` is checked against the token row).

## Transport

Plain HTTP, no TLS. The HTTP server binds loopback by default; the mesh is
intended for loopback and networks you trust (LAN, tailnet).