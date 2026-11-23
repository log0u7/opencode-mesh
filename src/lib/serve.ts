import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import type { MeshDb } from "./db.js";
import { authenticateToken } from "./peers.js";
import type { TlsMaterial } from "./tls.js";
import {
  deliverMessage,
  listMailboxes,
  MESSAGE_TTL_MS,
  purgeExpired,
  receiveMessage,
  unreadCount,
} from "./mail.js";
import type { Fanout } from "./fanout.js";
import {
  ensurePairingCodeSchema,
  findPendingByCode,
  pairWithToken,
  prunePendingTokens,
} from "./peers.js";
import { buildOfferBlob, parseOfferBlob, type OfferPayload } from "./offer-blob.js";

const BODY_LIMIT = 64 * 1024;

// Loopback by default: the mesh HTTP API must not be reachable from the
// network unless the operator explicitly opted into a LAN pool.
const DEFAULT_BIND = "127.0.0.1";

export type MeshServerOptions = {
  db: MeshDb;
  port: number;
  bind?: "loopback" | "lan";
  /** Pool federation: forwards local broadcasts to paired peers. */
  fanout?: Fanout;
  /** This node's identity, for pairing counter-offers. */
  self: { node_id: string; pk: string; hostname: string };
  /** Resolved by startMeshServer: "host:port" the caller reached us on. */
  selfAddress?: string;
  /** Resolved by startMeshServer: the actually-bound port (differs from
   * `port` when the requested one was taken and we fell back to ephemeral). */
  resolvedPort?: number;
  /** TLS material (identity-derived key + cert), from nodeTlsMaterial().
   * Required unless tls is explicitly disabled. */
  tlsMaterial?: TlsMaterial;
  /** Serve HTTPS on `port` (default true): all mesh traffic is encrypted and
   * the cert is pinned by the peer's Ed25519 key. */
  tls?: boolean;
  /** Documented escape hatch: an extra PLAIN-HTTP server on port+1 (default
   * off). Peers that cannot speak TLS yet may target it explicitly. */
  insecureHttp?: boolean;
};

export type MeshServer = {
  server: Server;
  port: number;
  address: string;
  /** The insecure side channel, when insecureHttp was requested. */
  insecureServer?: Server;
  insecurePort?: number;
};
// Bind the mesh HTTP(S) server and resolve the actual port. When the requested
// port is taken (two mesh nodes on one machine, e.g. a spawned worker loading
// the same plugin), fall back to an ephemeral port instead of crashing.
export async function startMeshServer(options: MeshServerOptions): Promise<MeshServer> {
  ensurePairingCodeSchema(options.db);
  // Messages older than 7 days are swept at boot.
  purgeExpired(options.db, MESSAGE_TTL_MS, Date.now());

  const host = options.bind === "lan" ? "0.0.0.0" : DEFAULT_BIND;
  const tls = options.tls !== false;
  if (tls && options.tlsMaterial === undefined) {
    throw new Error(
      "startMeshServer: TLS is on by default; pass tlsMaterial (nodeTlsMaterial(dataDir)) or tls: false",
    );
  }
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(options, req, res);
  };
  const server = tls
    ? createHttpsServer(
        { key: options.tlsMaterial!.keyPem, cert: options.tlsMaterial!.certPem },
        handler,
      )
    : createServer(handler);
  const port = await listenWithFallback(server, options.port, host);

  let insecureServer: Server | undefined;
  let insecurePort: number | undefined;
  if (options.insecureHttp === true) {
    insecureServer = createServer(handler);
    insecurePort = await listenWithFallback(insecureServer, port + 1, host);
  }

  options.selfAddress = `${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  options.resolvedPort = port;
  return {
    server,
    port,
    address: host,
    ...(insecureServer !== undefined && insecurePort !== undefined
      ? { insecureServer, insecurePort }
      : {}),
  };
}

function listenWithFallback(server: Server, requested: number, host: string): Promise<number> {
  let onListen: () => void = () => {};
  return new Promise<number>((resolve, reject) => {
    const attempt = (port: number): void => {
      onListen = () => {
        server.removeListener("error", onError);
        resolve(serverAddressPort(server, port));
      };
      server.once("listening", onListen);
      server.once("error", onError);
      server.listen(port, host);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListen);
      if (err.code === "EADDRINUSE" && server.listening === false) {
        attempt(0);
        return;
      }
      reject(err);
    };
    attempt(requested);
  });
}

function serverAddressPort(server: Server, fallback: number): number {
  const address = server.address();
  return address !== null && typeof address !== "string" ? address.port : fallback;
}

function consumePairingOffer(
  options: MeshServerOptions,
  pendingToken: string,
  offer: string,
  remote: string,
  localAddress: string,
): string | null {
  const parsed = parseOfferBlob(offer) as OfferPayload | null;
  if (parsed === null) return null;
  options.db.conn.run("DELETE FROM pending_tokens WHERE token = ?", [pendingToken]);
  pairWithToken(options.db, {
    node_id: parsed.node_id,
    hostname: (parsed.hostname ?? "").length > 0 ? (parsed.hostname ?? "") : "manual",
    fingerprint: "code-pairing",
    token: parsed.token,
    addresses: remote.startsWith("::ffff:") ? [remote.slice(7)] : [remote],
    public_key: parsed.pk,
  });
  // Counter-offer: our fresh pending offer, addressed to the interface the
  // caller actually reached.
  const address = localAddress.startsWith("::ffff:") ? localAddress.slice(7) : localAddress;
  return buildOfferBlob(options.db, {
    node_id: options.self.node_id,
    pk: options.self.pk,
    hostname: options.self.hostname,
    address: `${address}:${options.resolvedPort ?? options.port}`,
  });
}

async function handle(
  options: MeshServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { db, fanout } = options;
  const url = new URL(req.url ?? "/", "http://localhost");

  const contentLength = Number(req.headers["content-length"] ?? "0");
  if (req.method === "POST" && contentLength > BODY_LIMIT) {
    json(res, 413, { error: "body too large" });
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mail") {
    const body = await readBody(req);
    if ("error" in body) {
      // A body over the limit is 413; a read failure (client aborted mid-body)
      // is a malformed request, not an oversized one.
      json(res, body.error === "too_large" ? 413 : 400, {
        error: body.error === "too_large" ? "body too large" : "malformed request body",
      });
      return;
    }
    const parsed = parseMail(body.body);
    if (!parsed) {
      json(res, 400, { error: "invalid mail body" });
      return;
    }
    // Authenticate with the claimed sender so a pending pairing token can only
    // bind to a node this host already knows. The pairing proof (sender-signed
    // over node_id+token) is what authorizes binding a pairing to that node.
    const mailPeer = authenticate(db, req, parsed.from, parsed.proof);
    if (!mailPeer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (parsed.from !== mailPeer.node_id) {
      json(res, 401, { error: "from does not match token" });
      return;
    }
    // Addressed mail first: a known box routes to per-box deliveries, an
    // unknown box falls back to the legacy global inbox so remote mail is
    // never lost, and a broadcast with no local members is not an error.
    const result = deliverMessage(db, {
      from: parsed.from,
      from_box: parsed.from_box ?? null,
      to_box: parsed.to ?? null,
      subject: parsed.subject,
      body: parsed.body,
      reply_to: parsed.reply_to ?? null,
      origin_id: parsed.origin_id ?? null,
    });
    let delivered = 0;
    if (!result.ok && result.error === "unknown_mailbox") {
      receiveMessage(db, {
        from: parsed.from,
        subject: parsed.subject,
        body: parsed.body,
        ...(parsed.from_box !== undefined ? { from_box: parsed.from_box } : {}),
        ...(parsed.reply_to !== undefined ? { reply_to: parsed.reply_to } : {}),
      });
    } else if (result.ok) {
      delivered = result.recipients.length;
    }
    // Federation: a broadcast that produced local deliveries is forwarded to
    // the paired peers that also hold members (dedup via origin_id + via).
    if (
      fanout &&
      result.ok &&
      delivered > 0 &&
      parsed.to !== undefined &&
      (parsed.to === "all" || parsed.to.startsWith("team:"))
    ) {
      void fanout
        .fanout({
          to_box: parsed.to,
          origin_id: parsed.origin_id ?? result.id,
          from: parsed.from,
          from_box: parsed.from_box ?? null,
          subject: parsed.subject,
          body: parsed.body,
          via: parsed.via ?? null,
        })
        .catch(() => {});
    }
    json(res, 200, {
      ok: true,
      unread: unreadCount(db) + unreadDeliveries(db),
      delivered,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/pair-code") {
    // Pairing bootstrap: the 6-digit code is the capability. Rate-limited per
    // source address (5 consumed attempts per 5 minutes) to blunt brute force.
    const body = await readBody(req);
    if ("error" in body) {
      json(res, 400, { error: "malformed request body" });
      return;
    }
    let parsed: { code?: string; offer?: string } = {};
    try {
      parsed = JSON.parse(body.body) as { code?: string; offer?: string };
    } catch {}
    const code = typeof parsed.code === "string" ? parsed.code : "";
    const offer = typeof parsed.offer === "string" ? parsed.offer : "";
    if (!/^\d{6}$/.test(code) || !offer.startsWith("MESH1-")) {
      json(res, 400, { error: "invalid pairing request" });
      return;
    }
    const remote = req.socket.remoteAddress ?? "unknown";
    if (pairCodeThrottled(remote)) {
      json(res, 429, { error: "too many pairing attempts" });
      return;
    }
    const pending = findPendingByCode(db, code);
    if (pending === null) {
      json(res, 404, { error: "unknown pairing code" });
      return;
    }
    const counter = consumePairingOffer(
      options,
      pending.token,
      offer,
      remote,
      req.socket.localAddress ?? "",
    );
    if (counter === null) {
      json(res, 400, { error: "invalid offer" });
      return;
    }
    json(res, 200, { ok: true, counter_offer: counter });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pools") {
    const peer = authenticate(db, req);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const pools: Record<string, string[]> = {};
    for (const box of listMailboxes(db)) {
      for (const pool of box.pools) {
        const members = pools[pool] ?? [];
        members.push(box.name);
        pools[pool] = members;
      }
    }
    json(res, 200, { pools });
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    const peer = authenticate(db, req);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    json(res, 200, {
      node_id: peer.node_id,
      unread: unreadCount(db),
    });
    return;
  }

  json(res, 404, { error: "not found" });
}

function authenticate(
  db: MeshDb,
  req: IncomingMessage,
  from: string | null = null,
  proof?: string,
): { node_id: string } | null {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) {
    return null;
  }
  const peer = authenticateToken(db, match[1], from, proof);
  return peer ? { node_id: peer.node_id } : null;
}

type BodyResult = { body: string } | { error: "too_large" | "read" };

function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let limited = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        limited = true;
        chunks.length = 0;
        return;
      }
      if (!limited) {
        chunks.push(chunk);
      }
    });
    req.on("end", () =>
      resolve(limited ? { error: "too_large" } : { body: Buffer.concat(chunks).toString("utf8") }),
    );
    // A socket error, an aborted request, or a bare close all end the read
    // without `end`. `close` is the last-resort fallback; resolving twice is a
    // no-op, so a normal request that already ended is unaffected.
    req.on("error", () => resolve({ error: "read" }));
    req.on("aborted", () => resolve({ error: "read" }));
    req.on("close", () => resolve({ error: "read" }));
  });
}

// Unread deliveries across every box, added to the legacy global count for
// the /mail and /status unread totals.
function unreadDeliveries(db: MeshDb): number {
  return (
    db.conn.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM deliveries WHERE status = 'unread'",
    )?.count ?? 0
  );
}

function parseMail(raw: string): MailBody | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MailBody>;
    if (
      typeof parsed.from !== "string" ||
      typeof parsed.subject !== "string" ||
      typeof parsed.body !== "string"
    ) {
      return null;
    }
    return {
      from: parsed.from,
      subject: parsed.subject,
      body: parsed.body,
      ...(typeof parsed.proof === "string" ? { proof: parsed.proof } : {}),
      ...(typeof parsed.origin_id === "string" ? { origin_id: parsed.origin_id } : {}),
      ...(Array.isArray(parsed.via)
        ? { via: parsed.via.filter((v): v is string => typeof v === "string") }
        : {}),
      ...(typeof parsed.to === "string" ? { to: parsed.to } : {}),
      ...(typeof parsed.from_box === "string" ? { from_box: parsed.from_box } : {}),
      ...(typeof parsed.reply_to === "string" ? { reply_to: parsed.reply_to } : {}),
    };
  } catch {
    return null;
  }
}

type MailBody = {
  from: string;
  subject: string;
  body: string;
  proof?: string;
  to?: string;
  from_box?: string;
  reply_to?: string;
  via?: string[];
  origin_id?: string;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---- pairing-code bootstrap ----

const PAIR_ATTEMPTS = new Map<string, { count: number; windowStart: number }>();

function pairCodeThrottled(remote: string): boolean {
  const now = Date.now();
  const entry = PAIR_ATTEMPTS.get(remote);
  if (entry === undefined || now - entry.windowStart > 5 * 60_000) {
    PAIR_ATTEMPTS.set(remote, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > 5;
}

/** Consume the code's pending offer, bind the caller from its offer blob, and
 * mint a counter-offer blob so the caller can bind us back. */
