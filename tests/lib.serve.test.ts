import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";

import { openMeshDb } from "../src/lib/db.js";
import { pairPeer } from "../src/lib/peers.js";
import { startMeshServer } from "../src/lib/serve.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-serve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function start() {
  const db = openMeshDb(join(dir, "mesh.db"));
  const { server, port } = await startMeshServer({ db, port: 0 });
  const url = `http://127.0.0.1:${port}`;
  return { db, server, url };
}

async function post(url: string, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("mesh server", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { db, server, url } = await start();

    const noToken = await post(url, "/mail", { subject: "x", body: "y", from: "n1" });
    expect(noToken.status).toBe(401);

    const badToken = await post(url, "/mail", { subject: "x", body: "y", from: "n1" }, "wrong");
    expect(badToken.status).toBe(401);

    server.close();
    db.close();
  });

  it("rejects oversized bodies with 413", async () => {
    const { db, server, url } = await start();

    const response = await post(url, "/mail", {
      subject: "x",
      body: "y".repeat(70_000),
      from: "n1",
    });
    expect(response.status).toBe(413);

    server.close();
    db.close();
  });

  it("accepts mail from a paired peer token and stores it", async () => {
    const { db, server, url } = await start();
    const token = pairPeer(db, { node_id: "peer1", hostname: "laptop", fingerprint: "ff00" });

    const response = await post(
      url,
      "/mail",
      { subject: "handoff", body: "api is done", from: "peer1" },
      token,
    );
    expect(response.status).toBe(200);

    server.close();
    db.close();
  });

  it("returns 401 for a paired token from a different node id", async () => {
    const { db, server, url } = await start();
    const token = pairPeer(db, { node_id: "peer1", hostname: "laptop", fingerprint: "ff00" });

    const response = await post(
      url,
      "/mail",
      { subject: "spoof", body: "x", from: "other-node" },
      token,
    );
    expect(response.status).toBe(401);

    server.close();
    db.close();
  });
});

describe("mesh server routes", () => {
  it("answers /status with node identity for a valid token", async () => {
    const { db, server, url } = await start();
    const token = pairPeer(db, { node_id: "peer1", hostname: "laptop", fingerprint: "ff00" });

    const response = await fetch(`${url}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { node_id: string; unread: number };
    expect(body.node_id).toBe("peer1");
    expect(body.unread).toBe(0);

    server.close();
    db.close();
  });

  it("accepts /announce from a paired peer and updates addresses", async () => {
    const { db, server, url } = await start();
    const token = pairPeer(db, { node_id: "peer1", hostname: "laptop", fingerprint: "ff00" });

    const response = await post(url, "/announce", { addresses: ["10.0.0.9:4399"] }, token);
    expect(response.status).toBe(200);

    const { listPeers } = await import("../src/lib/peers.js");
    expect(listPeers(db)[0]?.addresses).toEqual(["10.0.0.9:4399"]);

    server.close();
    db.close();
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const { db, server, url } = await start();
    const token = pairPeer(db, { node_id: "peer1", hostname: "laptop", fingerprint: "ff00" });

    expect((await post(url, "/nope", { x: 1 }, token)).status).toBe(404);
    expect(
      (
        await fetch(`${url}/status`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(405);

    server.close();
    db.close();
  });

  it("rejects mail with a missing or mismatched body (400)", async () => {
    const { db, server, url } = await start();
    const token = pairPeer(db, { node_id: "peer1", hostname: "laptop", fingerprint: "ff00" });

    expect((await post(url, "/mail", { nope: true }, token)).status).toBe(400);

    server.close();
    db.close();
  });
});

describe("mesh server body guard", () => {
  it("rejects oversized chunked bodies without content-length (413)", async () => {
    const { db, server, url } = await start();
    const token = pairPeer(db, { node_id: "peer1", hostname: "laptop", fingerprint: "ff00" });

    const urlObj = new URL(url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: urlObj.hostname,
          port: urlObj.port,
          path: "/mail",
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      // No content-length header: node uses chunked encoding when we write in pieces.
      const chunk = "y".repeat(16 * 1024);
      for (let i = 0; i < 6; i++) {
        req.write(chunk);
      }
      req.end();
    });
    expect(status).toBe(413);

    server.close();
    db.close();
  });
});

describe("mesh server status auth", () => {
  it("rejects /status without a valid token (401)", async () => {
    const { db, server, url } = await start();

    const response = await fetch(`${url}/status`, { headers: { authorization: "Bearer wrong" } });
    expect(response.status).toBe(401);

    server.close();
    db.close();
  });
});
