import type { ServerResponse } from "node:http";

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
      // timeouts do not close the stream.
      this.heartbeat = setInterval(() => {
        for (const set of this.streams.values()) {
          for (const res of set) res.write(": hb\n\n");
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
    res.on("close", drop);
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

export type StreamClientHooks = {
  /** Dispatch one received event (the same handling as the wire routes). */
  onEvent: (event: StreamEvent) => void;
  /** The stream dropped — the caller logs or rebrowses. */
  onDrop: () => void;
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

  const connect = (): void => {
    if (stopped) return;
    const doRequest = target.tls ? httpsRequest : httpRequest;
    const req = doRequest(
      `${target.url}/stream`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${target.token}`,
          "x-mesh-sender": target.from,
          "x-mesh-proof": target.proof,
          accept: "text/event-stream",
        },
      },
      (response) => {
        res = response;
        failures = 0;
        let buffer = "";
        response.on("data", (chunk: Buffer) => {
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
                hooks.onEvent({ type: type as StreamEvent["type"], data: JSON.parse(data) });
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
      },
    );
    req.on("error", () => schedule());
    req.end();
  };

  const schedule = (): void => {
    if (stopped) return;
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
