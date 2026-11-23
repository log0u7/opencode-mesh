import { listMailboxes as listLocalMailboxes } from "./mail.js";
import { listPeers, resolvePeerTarget } from "./peers.js";
import { pairingProof, type NodeIdentity } from "./identity.js";
import type { MeshDb } from "./db.js";
import { getPools, sendMail } from "./client.js";

// Pool federation: when a node delivers a broadcast (team:<pool> or all), it
// also forwards the mail to every paired node that has at least one member in
// that pool. Loop and duplicate protection:
// - `via` carries the node ids already traversed; a relay never forwards to a
//   peer listed there,
// - `origin_id` lets a receiver that already stored the broadcast (through
//   another path) turn the second arrival into a no-op.

export type FanoutPeer = {
  node_id: string;
  url: string;
  token: string;
  tls: boolean;
  pk: string | null;
};

export type FanoutInput = {
  to_box: string | null;
  origin_id: string;
  from_box: string | null;
  subject: string;
  body: string;
  via?: string[] | null;
  /** Deliberate broadcast: the recipient wakes its members (0.17.0). */
  wake?: boolean;
};

export type Fanout = {
  /** Returns the node ids the mail was forwarded to. */
  fanout(input: FanoutInput): Promise<string[]>;
};

export type FanoutOptions = {
  db: MeshDb;
  identity: NodeIdentity;
  /** TTL of the per-peer /pools cache. Default 60s. */
  poolsCacheTtlMs?: number;
};

export function createFanout(options: FanoutOptions): Fanout {
  const selfNodeId = options.identity.node_id;
  const ttl = options.poolsCacheTtlMs ?? 60_000;
  const cache = new Map<string, { pools: Record<string, string[]>; at: number }>();

  const localPools = (): Record<string, string[]> => {
    const pools: Record<string, string[]> = {};
    for (const box of listLocalMailboxes(options.db)) {
      for (const pool of box.pools) {
        const members = pools[pool] ?? [];
        members.push(box.name);
        pools[pool] = members;
      }
    }
    return pools;
  };

  const peerPools = async (peer: FanoutPeer): Promise<Record<string, string[]> | null> => {
    const cached = cache.get(peer.node_id);
    if (cached && Date.now() - cached.at < ttl) {
      return cached.pools;
    }
    const result = await getPools({
      url: peer.url,
      token: peer.token,
      ...(peer.tls ? { tls: true } : {}),
      ...(peer.pk !== null ? { pk: peer.pk } : {}),
    });
    if (result === null) return null;
    cache.set(peer.node_id, { pools: result.pools, at: Date.now() });
    return result.pools;
  };

  return {
    async fanout(input: FanoutInput): Promise<string[]> {
      if (!input.to_box) return [];
      const visited = new Set([...(input.via ?? []), selfNodeId]);
      const forwarded: string[] = [];

      const peers = listPeers(options.db)
        .filter((p) => p.paired)
        .map((p) => {
          const target = resolvePeerTarget(options.db, p.node_id);
          return target
            ? {
                node_id: p.node_id,
                url: target.url,
                token: p.token ?? "",
                tls: target.tls,
                pk: target.pk,
              }
            : null;
        })
        .filter((p): p is FanoutPeer => p !== null);

      for (const peer of peers) {
        if (visited.has(peer.node_id)) continue;
        // TLS peer without a pinned key: any certificate would be accepted on
        // a token-authenticated channel (silent TOFU = steal the bearer
        // token). Never send there; the operator re-pairs with mesh_pair.
        if (peer.tls && peer.pk === null) continue;
        if (input.to_box !== "all") {
          // Pool broadcast: forward only to peers with at least one member.
          // Unknown pools (peer unreachable, or its token not yet bound on our
          // side at first contact) forward anyway: origin_id dedup makes the
          // redundant copy a no-op, and the mail drive-by binds the token so
          // later /pools calls succeed.
          const pools = await peerPools(peer);
          if (pools !== null && (pools[input.to_box] ?? []).length === 0) continue;
        }
        const result = await sendMail({
          url: peer.url,
          token: peer.token,
          ...(peer.tls ? { tls: true } : {}),
          ...(peer.pk !== null ? { pk: peer.pk } : {}),
          // Multi-hop (0.18.0): the wire `from` is ALWAYS the node that puts
          // the mail on the wire, because the receiver binds the bearer token
          // and the pairing proof to that node (`parsed.from` must equal the
          // authenticated peer). A relay forwarding the origin's id was
          // rejected 401 by the next hop — any mesh of 3+ nodes was broken.
          // The origin stays traceable through origin_id + from_box.
          from: selfNodeId,
          proof: pairingProof(options.identity, peer.token),
          ...(input.from_box !== null && input.from_box !== undefined
            ? { from_box: input.from_box }
            : {}),
          to: input.to_box,
          subject: input.subject,
          body: input.body,
          origin_id: input.origin_id,
          ...(input.wake === true ? { wake: true } : {}),
          via: [...visited],
        });
        if (result === "ok") {
          forwarded.push(peer.node_id);
        }
      }
      return forwarded;
    },
  };
}

// Local import placed at the top: mail.ts never imports fanout, no cycle.
