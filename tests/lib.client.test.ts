import { describe, expect, it, vi } from "vitest";
import { createServer as createHttpsServer } from "node:https";

import { openMeshDb } from "../src/lib/db.js";
import { sendMail } from "../src/lib/client.js";

const SELF = { node_id: "self", pk: "test-pk", hostname: "localhost" };

describe("sendMail result mapping", () => {
  it("maps 401 to unauthorized", async () => {
    const { startMeshServer } = await import("../src/lib/serve.js");
    const db = openMeshDb(":memory:");
    const { server, port } = await startMeshServer({ db, port: 0, tls: false, self: SELF });

    const result = await sendMail({
      url: `http://127.0.0.1:${port}`,
      token: "wrong-token",
      from: "node-a",
      subject: "s",
      body: "b",
    });
    expect(result).toBe("unauthorized");

    server.close();
    db.close();
  });

  it("maps server errors to error", async () => {
    const { startMeshServer } = await import("../src/lib/serve.js");
    const db = openMeshDb(":memory:");
    const { server, port } = await startMeshServer({ db, port: 0, tls: false, self: SELF });
    const { pairWithToken } = await import("../src/lib/peers.js");
    pairWithToken(db, { node_id: "node-a", hostname: "a", fingerprint: "f", token: "tok-a" });
    const token = "tok-a";

    // Authenticated but invalid body -> 400 -> mapped to "error".
    const response = await fetch(`http://127.0.0.1:${port}/mail`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ nope: true }),
    });
    expect(response.status).toBe(400);

    server.close();
    db.close();
  });
});

describe("sendMail server error mapping", () => {
  it("maps 500 responses to error via stubbed fetch", async () => {
    const fetchStub = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchStub);

    const result = await sendMail({
      url: "http://127.0.0.1:1",
      token: "t",
      from: "a",
      subject: "s",
      body: "b",
    });
    expect(result).toBe("error");

    vi.unstubAllGlobals();
  });
});

describe("sendMail TLS pinning", () => {
  it("maps a stale pin to pin-mismatch, not unreachable", async () => {
    const { startMeshServer } = await import("../src/lib/serve.js");
    const { nodeTlsMaterial } = await import("../src/lib/tls.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadOrCreateIdentity } = await import("../src/lib/identity.js");

    const serverDir = mkdtempSync(join(tmpdir(), "mesh-pin-a-"));
    const clientDir = mkdtempSync(join(tmpdir(), "mesh-pin-b-"));
    const serverIdentity = loadOrCreateIdentity(serverDir);
    const clientIdentity = loadOrCreateIdentity(clientDir);
    const material = nodeTlsMaterial(serverDir);
    const db = openMeshDb(":memory:");
    const { server, port } = await startMeshServer({
      db,
      port: 0,
      tls: true,
      tlsMaterial: material,
      self: SELF,
    });

    // The client pins a DIFFERENT key than the one the server presents: the classic
    // stale pin after the peer re-paired or rotated its identity.
    const result = await sendMail({
      url: `https://127.0.0.1:${port}`,
      tls: true,
      pk: clientIdentity.public_key,
      token: "t",
      from: "node-b",
      subject: "s",
      body: "b",
    });
    expect(result).toBe("pin-mismatch");

    server.close();
    db.close();
  });
});

describe("sendMail version skew", () => {
  it("maps a plaintext listener to plaintext-peer, not unreachable", async () => {
    const { startMeshServer } = await import("../src/lib/serve.js");
    const db = openMeshDb(":memory:");
    const { server, port } = await startMeshServer({ db, port: 0, tls: false, self: SELF });

    // A 0.11+ TLS client against a 0.10.x plaintext peer: the host is up, the
    // handshake is not. The error must name the skew, not blame the network.
    const result = await sendMail({
      url: `https://127.0.0.1:${port}`,
      tls: true,
      token: "t",
      from: "node-a",
      subject: "s",
      body: "b",
    });
    expect(result).toBe("plaintext-peer");

    server.close();
    db.close();
  });
});

describe("sendMail response bound (0.18.0)", () => {
  it("refuses a plain-HTTP response body over 2 MiB instead of reading it all", async () => {
    // A stubbed oversized body: the bounded plain reader must cancel the
    // stream, not accumulate it — sendMail maps the failure to plain "error".
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    const fetchStub = vi.fn(async () => new Response(oversized, { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);

    const result = await sendMail({
      url: "http://127.0.0.1:1",
      token: "t",
      from: "a",
      subject: "s",
      body: "b",
    });
    expect(result).toBe("error");

    vi.unstubAllGlobals();
  });

  it("refuses a TLS response body over 2 MiB instead of reading it all", async () => {
    const { nodeTlsMaterial } = await import("../src/lib/tls.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const serverDir = mkdtempSync(join(tmpdir(), "mesh-bound-tls-"));
    try {
      const material = nodeTlsMaterial(serverDir);
      const server = createHttpsServer(
        { key: material.keyPem, cert: material.certPem },
        (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("x".repeat(2 * 1024 * 1024 + 1));
        },
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      // TOFU on the cert (first contact, no pin): the response size is the
      // thing under test, not the identity.
      const result = await sendMail({
        url: `https://127.0.0.1:${port}`,
        tls: true,
        token: "t",
        from: "a",
        subject: "s",
        body: "b",
      });
      expect(result).toBe("error");

      server.close();
    } finally {
      rmSync(serverDir, { recursive: true, force: true });
    }
  });
});
