import { describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { sendMail } from "../src/lib/client.js";

describe("sendMail result mapping", () => {
  it("maps 401 to unauthorized", async () => {
    const { startMeshServer } = await import("../src/lib/serve.js");
    const db = openMeshDb(":memory:");
    const { server, port } = await startMeshServer({ db, port: 0 });

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
    const { server, port } = await startMeshServer({ db, port: 0 });
    const { pairPeer } = await import("../src/lib/peers.js");
    const token = pairPeer(db, { node_id: "node-a", hostname: "a", fingerprint: "f" });

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
