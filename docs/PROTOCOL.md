# Protocol

How mesh nodes talk. The mesh is deliberately simple: mDNS for discovery,
bearer tokens for auth, two HTTP routes.

## Discovery (mDNS)

Each node publishes a DNS-SD service:

- Service type: `_opencode-mesh._tcp` (Bonjour type `opencode-mesh`).
- Service name: the advertising node's `node_id` (a random UUID).
- SRV port: the mesh HTTP server port.
- TXT records: `id` = `node_id`, `fp` = a 16-hex-char fingerprint derived from
  the node id (SHA-256 prefix). TXT carries **no secrets**.

The browser filters entries with no `id`. Each advertised A/AAAA address is
combined with the SRV port into `host:port` (bracketed for IPv6); a record
without a port yields no address, since guessing the local port reaches the
wrong socket.

Tailnet IPs (`tailscale status --json`, `Self.TailscaleIPs`) are surfaced by
`mesh_status` for cross-subnet pools and cached for 60s. The `tailscale` CLI is
absent-or-failing: an empty list, never an error.

## Pairing

1. Either side runs `mesh_pair` with no args: the host generates a token
   (32 random bytes, base64url, stored in `pending_tokens` with a `created_at`
   timestamp) and prints something like
   `mesh_pair(node_id="...uuid...", token="...", address="127.0.0.1:4399")`.
2. The operator relays the offer out of band (chat, not the mesh).
3. The peer runs `mesh_pair(node_id="...", token="...", address="host:port")`
   to pair in the other direction. With `node_id` and `token` it pairs directly
   through `pairWithToken`; both fields must be non-empty strings.
4. When the offer's host sees the peer drive-by, a pending token alone grants
   nothing: the claimed sender must already be a peer this host knows (paired,
   or discovered over mDNS). That is what makes a leaked offer unable to
   install a permanent peer by itself.

Offer tokens expire after 5 minutes (`PAIRING_TOKEN_TTL_MS`) and are pruned on
every auth check that reaches the pending lookup (a valid paired token short-
circuits earlier). Completing a pairing consumes the pending token and
upserts the peer record `paired = 1` with the token per node id (one token per
peer; the latest pairing wins).

Known gap (tracked in #30): while an offer is live, a second pairing with the
same node id can rebind that peer's token. Signed offers would close it.

## HTTP API

Every endpoint requires `Authorization: Bearer <token>`; nothing is open by
default. Tokens are matched against `peers.token` (`paired = 1`) and, for the
pending path, the node must already be known.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/mail` | peer token | `{"from": "...", "subject": "...", "body": "..."}` | `200 {"ok": true, "unread": N}` |
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