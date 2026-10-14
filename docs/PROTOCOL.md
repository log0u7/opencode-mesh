# Protocol

How mesh nodes talk. The mesh is deliberately simple: mDNS for discovery,
bearer tokens for auth, two HTTP routes.

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

Offer tokens expire after 5 minutes (`PAIRING_TOKEN_TTL_MS`) and are pruned on
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
default. Tokens are matched against `peers.token` (`paired = 1`) and, for the
pending path, the node must already be known.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/mail` | peer token | `{"from": "...", "subject": "...", "body": "...", "proof"?: "<pk>.<sig>"}` | `200 {"ok": true, "unread": N}` |
| `GET` | `/status` | peer token | none | `200 {"node_id": "...", "unread": N}` |

Status codes:

- `400`: malformed mail body (the receiver could not parse `{from, subject,
  body}` as strings) or a body read failure (socket error, abort mid-body).
- `401`: missing/unknown token, or the mail `from` does not match the token's
  node id.
- `404`: unknown route. `/lock`, `/locks`, `/unlock`, `/announce` are
  deliberately absent: locks are local-only and never part of the wire protocol
  (a regression test guards this).
- `405`: wrong method for an existing route.
- `413`: body over the 64 KiB limit, by header or by counting.

- Sender binding: a paired token from one node id cannot mail as another node
  id (`from` is checked against the token row).

## Transport

Plain HTTP, no TLS. The HTTP server binds loopback by default; the mesh is
intended for loopback and networks you trust (LAN, tailnet).