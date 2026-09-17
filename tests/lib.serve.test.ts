import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  const server = startMeshServer({ db, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no ephemeral port");
  }
  const url = `http://127.0.0.1:${address.port}`;
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
