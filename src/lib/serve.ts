import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { MeshDb } from "./db.js";
import { authenticateToken } from "./peers.js";
import { receiveMessage, unreadCount } from "./mail.js";

const BODY_LIMIT = 64 * 1024;

export type MeshServerOptions = {
  db: MeshDb;
  port: number;
};

export type MeshServer = {
  server: Server;
  port: number;
};

// Bind the mesh HTTP server and resolve the actual port. When the requested
// port is taken (two mesh nodes on one machine, e.g. a spawned worker loading
// the same plugin), fall back to an ephemeral port instead of crashing.
export async function startMeshServer(options: MeshServerOptions): Promise<MeshServer> {
  const server = createServer((req, res) => {
    void handle(options.db, req, res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    const tryListen = (requested: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && requested !== 0) {
          tryListen(0);
          return;
        }
        reject(err);
      });
      server.listen(requested, () => {
        const address = server.address();
        resolve(address !== null && typeof address !== "string" ? address.port : requested);
      });
    };
    tryListen(options.port);
  });

  return { server, port };
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

  if (req.method === "POST") {
    const body = await readBody(req);
    if (body === null) {
      json(res, 413, { error: "body too large" });
      return;
    }

    if (url.pathname === "/mail") {
      const parsed = parseMail(body);
      if (!parsed) {
        json(res, 400, { error: "invalid mail body" });
        return;
      }
      // Authenticate with the claimed sender so pending pairing tokens bind
      // to the node id in the message.
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

    const peer = authenticate(db, req);
    if (!peer) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/announce") {
      const parsed = parseAnnounce(body);
      if (!parsed) {
        json(res, 400, { error: "invalid announce body" });
        return;
      }
      touchAddress(db, peer.node_id, parsed.addresses);
      json(res, 200, { ok: true });
      return;
    }
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

function touchAddress(db: MeshDb, nodeId: string, addresses: string[]): void {
  db.conn.run("UPDATE peers SET addresses = ?, last_seen = ? WHERE node_id = ?", [
    JSON.stringify(addresses),
    Date.now(),
    nodeId,
  ]);
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

function parseAnnounce(raw: string): { addresses: string[] } | null {
  try {
    const parsed = JSON.parse(raw) as { addresses?: unknown };
    if (!Array.isArray(parsed.addresses)) {
      return null;
    }
    const addresses = parsed.addresses.filter((a): a is string => typeof a === "string");
    return { addresses };
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
