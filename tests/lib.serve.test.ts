import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { connect } from "node:net";

import { openMeshDb } from "../src/lib/db.js";
import { pairWithToken } from "../src/lib/peers.js";
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

describe("mesh server bind", () => {
  it("binds loopback by default and reports the address it bound", async () => {
    const db = openMeshDb(":memory:");
    const { server, port, address } = await startMeshServer({ db, port: 0 });

    expect(address).toBe("127.0.0.1");
    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });

    server.close();
    db.close();
  });

  it("binds every interface only when explicitly asked for lan", async () => {
    const db = openMeshDb(":memory:");
    const { server, address } = await startMeshServer({ db, port: 0, bind: "lan" });

    expect(address).not.toBe("127.0.0.1");

    server.close();
    db.close();
  });

  it("serves mail on the non-loopback interface when lan is opted into", async () => {
    const db = openMeshDb(":memory:");
    const { server, port, address } = await startMeshServer({ db, port: 0, bind: "lan" });

    const lanIp = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface?.family === "IPv4" && !iface.internal)?.address;

    if (lanIp !== undefined) {
      pairWithToken(db, {
        node_id: "peer1",
        hostname: "laptop",
        fingerprint: "ff00",
        token: "tok-peer1",
      });
      const response = await post(
        `http://${lanIp}:${port}`,
        "/mail",
        {
          subject: "x",
          body: "y",
          from: "peer1",
        },
        "tok-peer1",
      );
      expect(response.status).toBe(200);
    }
    expect(address).not.toBe("127.0.0.1");

    server.close();
    db.close();
  });
});

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
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

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
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

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
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

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

  it("exposes no lock route: locks stay local to this host (guard)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    // mesh_lock is deliberately not part of the wire protocol. A future
    // half-measure that adds a lock endpoint must fail here.
    for (const path of ["/lock", "/locks", "/unlock", "/announce"]) {
      expect((await post(url, path, { path: "a" }, token)).status).toBe(404);
    }

    server.close();
    db.close();
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

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
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

    expect((await post(url, "/mail", { nope: true }, token)).status).toBe(400);

    server.close();
    db.close();
  });
});

describe("mesh server body guard", () => {
  it("rejects oversized chunked bodies without content-length (413)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";

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

  it("reports a body read failure as 400, not 413 (socket error)", async () => {
    const { db, server, url } = await start();
    pairWithToken(db, {
      node_id: "peer1",
      hostname: "laptop",
      fingerprint: "ff00",
      token: "tok-peer1",
    });
    const token = "tok-peer1";
    const urlObj = new URL(url);

    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect({ host: urlObj.hostname, port: Number(urlObj.port) }, () => {
        // Declare a 100-byte body, send 10, then half-close: the read fails
        // (aborted/reset) without ever completing.
        socket.write(
          `POST /mail HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n`,
        );
        socket.write("0123456789");
        socket.end();
      });
      let raw = "";
      socket.on("data", (chunk) => {
        raw += chunk.toString();
      });
      socket.on("end", () => resolve(Number(/HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0)));
      socket.on("error", reject);
    });

    expect(status).toBe(400);

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
