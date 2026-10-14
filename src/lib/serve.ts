import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { MeshDb } from "./db.js";
import { authenticateToken } from "./peers.js";
import { receiveMessage, unreadCount } from "./mail.js";

const BODY_LIMIT = 64 * 1024;

// Loopback by default: the mesh HTTP API must not be reachable from the
// network unless the operator explicitly opted into a LAN pool.
const DEFAULT_BIND = "127.0.0.1";

export type MeshServerOptions = {
  db: MeshDb;
  port: number;
  bind?: "loopback" | "lan";
};

export type MeshServer = {
  server: Server;
  port: number;
  address: string;
};
// Bind the mesh HTTP server and resolve the actual port. When the requested
// port is taken (two mesh nodes on one machine, e.g. a spawned worker loading
// the same plugin), fall back to an ephemeral port instead of crashing.
export async function startMeshServer(options: MeshServerOptions): Promise<MeshServer> {
  const host = options.bind === "lan" ? "0.0.0.0" : DEFAULT_BIND;
  const server = createServer((req, res) => {
    void handle(options.db, req, res);
  });

  let onListen: () => void = () => {};
  const port = await new Promise<number>((resolve, reject) => {
    const attempt = (requested: number): void => {
      onListen = () => {
        server.removeListener("error", onError);
        resolve(serverAddressPort(server, requested));
      };
      server.once("listening", onListen);
      server.once("error", onError);
      server.listen(requested, host);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListen);
      if (err.code === "EADDRINUSE" && server.listening === false) {
        attempt(0);
        return;
      }
      reject(err);
    };
    attempt(options.port);
  });

  return { server, port, address: host };
}

function serverAddressPort(server: Server, fallback: number): number {
  const address = server.address();
  return address !== null && typeof address !== "string" ? address.port : fallback;
}

async function handle(db: MeshDb, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (body === null) {
      json(res, 413, { error: "body too large" });
      return;
    }
    const parsed = parseMail(body);
    if (!parsed) {
      json(res, 400, { error: "invalid mail body" });
      return;
    }
    // Authenticate with the claimed sender so a pending pairing token can only
    // bind to a node this host already knows.
    const mailPeer = authenticate(db, req, parsed.from);
    if (!mailPeer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (parsed.from !== mailPeer.node_id) {
      json(res, 401, { error: "from does not match token" });
      return;
    }
    receiveMessage(db, parsed);
    json(res, 200, { ok: true, unread: unreadCount(db) });
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
): { node_id: string } | null {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) {
    return null;
  }
  const peer = authenticateToken(db, match[1], from);
  return peer ? { node_id: peer.node_id } : null;
}

function readBody(req: IncomingMessage): Promise<string | null> {
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
    req.on("end", () => resolve(limited ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
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
    return { from: parsed.from, subject: parsed.subject, body: parsed.body };
  } catch {
    return null;
  }
}

type MailBody = {
  from: string;
  subject: string;
  body: string;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
