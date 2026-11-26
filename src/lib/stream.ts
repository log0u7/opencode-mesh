import type { ServerResponse } from "node:http";
import { pinCheck } from "./client.js";

// The persistent stream (the refonte 3.1, SSE): each peer holds ONE
// server-sent-events connection to every other node — the server pushes
// (the mail, the task states, the registry) the moment they exist; the
// peer's outgoing traffic keeps riding the outbox (the POST fallback stays
// when no stream is open). No polling, no latency budget on the receive
// side.

export type StreamEvent = {
  type: "mail" | "registry";
  /** The wire payload: for mail, the same shape as POST /mail; for the
   * registry, the same rows as POST /registry-sync. */
  data: unknown;
};

/** The applicative ack (the refonte2-C6): the receiver APPLIED the event —
 * the POST tells the sender's /ack, which marks the outbox row sent. The
 * push alone is at-most-once; the ack makes it effectively-once. */
export async function ackEvent(
  target: { url: string; token: string; from: string; proof: string; tls?: boolean; pk?: string },
  originId: string,
): Promise<void> {
  const isTls = target.tls === true || target.url.startsWith("https:");
  const u = new URL(target.url);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${target.token}`,
    "x-mesh-sender": target.from,
    "x-mesh-proof": target.proof,
  };
  const body = JSON.stringify({ origin_id: originId });
  try {
    const requestOpts = {
      hostname: u.hostname,
      ...(u.port !== "" ? { port: Number(u.port) } : {}),
      path: "/ack",
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
      ...(isTls
        ? {
            rejectUnauthorized: false,
            ...(target.pk
              ? {
                  checkServerIdentity: (_host: string, cert: PeerCertificate) =>
                    pinCheck(target.pk)(cert) ?? undefined,
                }
              : {}),
          }
        : {}),
    };
    const doRequest = isTls ? httpsRequest : httpRequest;
    const req = doRequest(requestOpts, (response) => {
      response.resume();
    });
    if (isTls) {
      // The secureConnect guard (the refonte2-P2): fires in EVERY case
      // (self-signed included) — the ack POST carries the Bearer token, the
      // pin MUST hold before any byte leaves.
      req.on("socket", (socket) => {
        socket.on("secureConnect", () => {
          const tlsSocket = socket as import("node:tls").TLSSocket;
          const err = pinCheck(target.pk)(tlsSocket.getPeerCertificate());
          if (err) req.destroy(err);
        });
      });
    }
    req.on("error", () => {});
    req.end(body);
  } catch {
    // The ack is best-effort: the resend window (the claim's 30s) covers
    // the missed acks (the origin_id dedup collapses the duplicate).
  }
}

/** The hub: the OPEN peer streams, keyed by the authenticated node id. */
export class StreamHub {
  private streams = new Map<string, Set<ServerResponse>>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  /** Register an authenticated peer stream. Returns the deregister fn. */
  add(nodeId: string, res: ServerResponse): () => void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    let set = this.streams.get(nodeId);
    if (!set) {
      set = new Set();
      this.streams.set(nodeId, set);
    }
    set.add(res);
    if (!this.heartbeat) {
      // The keep-alive: a comment line every 25s — proxies and idle
      // timeouts do not close the stream. Writes guarded: a dying socket
      // must not crash the heartbeat (the drop listener cleans up).
      this.heartbeat = setInterval(() => {
        for (const set of this.streams.values()) {
          for (const res of set) {
            try {
              res.write(": hb\n\n");
            } catch {
              set.delete(res);
            }
          }
        }
      }, 25_000);
    }
    const drop = () => {
      set?.delete(res);
      if (set && set.size === 0) this.streams.delete(nodeId);
      if (this.streams.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    };
    // The 'close' AND 'error' listeners: a socket dying between writes
    // raises 'error' on the response — an unhandled 'error' event would
    // crash the host process.
    res.on("close", drop);
    res.on("error", drop);
    return drop;
  }

  /** Is a stream open for this node? (The outbox sender checks first.) */
  isOpen(nodeId: string): boolean {
    return (this.streams.get(nodeId)?.size ?? 0) > 0;
  }

  /** Push an event to EVERY open stream of the node. Returns the delivered
   * count (0 = no stream open — the caller falls back to the POST path). */
  push(nodeId: string, event: StreamEvent): number {
    const set = this.streams.get(nodeId);
    if (!set || set.size === 0) return 0;
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    let delivered = 0;
    for (const res of set) {
      try {
        res.write(frame);
        delivered += 1;
      } catch {
        set.delete(res);
      }
    }
    return delivered;
  }

  /** The count of open streams (the tests + the diagnostics). */
  get size(): number {
    return this.streams.size;
  }

  /** The open streams for ONE node: the duplicate-client detector — more
   * than 1 means a reconnecting client AND a fresh client coexist (the
   * refonte2-A3 leak class). */
  count(nodeId: string): number {
    return this.streams.get(nodeId)?.size ?? 0;
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const set of this.streams.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {}
      }
    }
    this.streams.clear();
  }
}

// ---- the client side ----

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { PeerCertificate } from "node:tls";

export type StreamClientHooks = {
  /** Dispatch one received event (the same handling as the wire routes).
   * Returns the event's origin_id IF the dispatch applied it successfully
   * (null/undefined = not applied — no ack). */
  onEvent: (event: StreamEvent) => string | null | undefined;
  /** The stream dropped — the caller logs or rebrowses. */
  onDrop: () => void;
  /** The ACK channel (the refonte2-P1): POST /ack {origin_id} to the
   * stream's peer — the push alone is at-most-once, the ack makes it
   * effectively-once. */
  ack: (originId: string) => void;
};

/** Open ONE SSE stream to a peer and keep it alive (reconnect with a
 * doubling backoff, capped). Returns the stop fn. The events dispatch to
 * the caller's handler — the receive side never polls. */
export function openPeerStream(
  target: { url: string; token: string; from: string; proof: string; tls?: boolean; pk?: string },
  hooks: StreamClientHooks,
): { stop: () => void } {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let res: IncomingMessage | undefined;
  // The watchdog (the refonte2-C6): NO byte for 60s = the socket is
  // half-dead (the NAT dropped it) — destroy and reconnect. Reset on every
  // byte AND every heartbeat.
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let lastByteAt = Date.now();

  const startWatchdog = (): void => {
    lastByteAt = Date.now();
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > 60_000) {
        res?.destroy();
        hooks.onDrop();
        schedule();
      }
    }, 10_000);
  };

  const connect = (): void => {
    lastByteAt = Date.now();
    if (watchdog) clearInterval(watchdog);
    watchdog = undefined;
    timer = undefined;
    if (stopped) return;
    startWatchdog();
    // The TLS pinning (the refonte2-A2): the mesh certs are SELF-SIGNED —
    // rejectUnauthorized off, the trust comes ENTIRELY from the SPKI pin
    // (the same gabarit as the wire's tlsRequest). The pk passed and
    // ignored before: the stream failed in TLS, silently, forever.
    const isTls = target.tls === true || target.url.startsWith("https:");
    const u = new URL(target.url);
    const requestOpts: Record<string, unknown> = {
      hostname: u.hostname,
      ...(u.port !== "" ? { port: Number(u.port) } : {}),
      path: "/stream",
      method: "GET",
      headers: {
        authorization: `Bearer ${target.token}`,
        "x-mesh-sender": target.from,
        "x-mesh-proof": target.proof,
        accept: "text/event-stream",
      },
      ...(isTls
        ? {
            rejectUnauthorized: false,
            checkServerIdentity: (_host: string, cert: PeerCertificate) =>
              pinCheck(target.pk)(cert) ?? undefined,
          }
        : {}),
    };
    const doRequest = isTls ? httpsRequest : httpRequest;
    const req = doRequest(requestOpts, (response) => {
      res = response;
      failures = 0;
      let buffer = "";
      response.on("data", (chunk: Buffer) => {
        lastByteAt = Date.now();
        buffer += chunk.toString();
        // The SSE frames: event: <type>\n data: <json>\n\n
        for (;;) {
          const sep = buffer.indexOf("\n\n");
          if (sep < 0) break;
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const lines = frame.split("\n");
          const type = lines
            .find((l) => l.startsWith("event: "))
            ?.slice(7)
            .trim();
          const data = lines
            .find((l) => l.startsWith("data: "))
            ?.slice(6)
            .trim();
          if (type && data && type !== "hb") {
            try {
              const applied = hooks.onEvent({
                type: type as StreamEvent["type"],
                data: JSON.parse(data),
              });
              // The ack AFTER a successful apply (the refonte2-P1): the
              // sender's row goes sent only when the receiver APPLIED it.
              if (applied) hooks.ack(applied);
            } catch {}
          }
        }
      });
      response.on("end", () => {
        hooks.onDrop();
        schedule();
      });
      response.on("error", () => {
        hooks.onDrop();
        schedule();
      });
    });
    if (isTls) {
      // The secureConnect guard: fires in EVERY case (including self-signed,
      // where the default identity check is skipped) — the tlsRequest's
      // double enforcement, copied.
      req.on("socket", (socket) => {
        socket.on("secureConnect", () => {
          const tlsSocket = socket as import("node:tls").TLSSocket;
          const err = pinCheck(target.pk)(tlsSocket.getPeerCertificate());
          if (err) req.destroy(err);
        });
      });
    }
    req.on("error", () => schedule());
    req.end();
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return; // one pending reconnect max
    failures += 1;
    const backoff = Math.min(1000 * 2 ** failures, 60_000);
    timer = setTimeout(connect, backoff);
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      res?.destroy();
    },
  };
}
