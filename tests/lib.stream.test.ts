import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMeshDb } from "../src/lib/db.js";
import { startMeshServer } from "../src/lib/serve.js";
import { StreamHub, openPeerStream } from "../src/lib/stream.js";
import { deliverMessage, registerMailbox } from "../src/lib/mail.js";
import { pairWithToken } from "../src/lib/peers.js";
import { loadOrCreateIdentity, pairingProof } from "../src/lib/identity.js";

describe("the stream hub (refonte 3.1)", () => {
  it("registers, pushes to the open streams and cleans up on stop", async () => {
    const hub = new StreamHub();
    expect(hub.isOpen("peer-1")).toBe(false);
    const fakeRes = {
      writeHead: () => {},
      write: (frame: string) => {
        void frame;
      },
      on: () => {},
      end: () => {},
    } as unknown as Parameters<typeof hub.add>[1];
    const drop = hub.add("peer-1", fakeRes);
    expect(hub.isOpen("peer-1")).toBe(true);
    const n = hub.push("peer-1", { type: "mail", data: { subject: "s" } });
    expect(n).toBe(1);
    expect(hub.push("peer-2", { type: "mail", data: {} })).toBe(0);
    drop();
    expect(hub.isOpen("peer-1")).toBe(false);
    hub.stop();
  });
});

describe("the stream round trip (refonte 3.1): the push delivers without any POST", () => {
  it("a client stream receives the mail the moment it is pushed", { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-stream-"));
    const db = openMeshDb(join(dir, "mesh.db"));
    const received: Array<{ type: string; data: unknown }> = [];
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    const { server, port, hub } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      self: { node_id: "node-a", pk: "", hostname: "a" },
    });
    // Un VRAI pairing: l'identite de B + la cle pinnee + le proof signe.
    const identityB = loadOrCreateIdentity(join(dir, "b-identity"));
    pairWithToken(db, {
      node_id: identityB.node_id,
      hostname: "b",
      fingerprint: "ff00",
      token: "tok-b",
      public_key: identityB.public_key,
    });
    const client = openPeerStream(
      {
        url: `http://127.0.0.1:${port}`,
        token: "tok-b",
        from: identityB.node_id,
        proof: pairingProof(identityB, "tok-b"),
      },
      {
        onEvent: (e) => received.push(e),
        onDrop: () => {},
      },
    );
    // La connexion + l'enregistrement du stream (le handshake + la reponse).
    await new Promise((r) => setTimeout(r, 300));
    expect(hub!.isOpen(identityB.node_id)).toBe(true);
    const streamHub = hub!;
    const n = streamHub.push(identityB.node_id, {
      type: "mail",
      data: { subject: "pushed", body: "instant" },
    });
    expect(n).toBe(1);
    // L'evenement arrive au client SANS aucun POST ni poll.
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(received[0])).toContain("pushed");
    client.stop();
    streamHub.stop();
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the stream client: the reconnect (refonte 3.1)", () => {
  it("a stream drop schedules the reconnect; a dead target retries without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-reconnect-"));
    const db = openMeshDb(join(dir, "mesh.db"));
    registerMailbox(db, { name: "alice", session_id: "s1", now: 1000 });
    const identityB = loadOrCreateIdentity(join(dir, "id-b"));
    const { server, port, hub } = await startMeshServer({
      db,
      port: 0,
      tls: false,
      self: { node_id: "node-a", pk: "", hostname: "a" },
    });
    pairWithToken(db, {
      node_id: identityB.node_id,
      hostname: "b",
      fingerprint: "ff00",
      token: "tok-b",
      public_key: identityB.public_key,
    });
    const drops: number[] = [];
    const streamHub = hub as NonNullable<typeof hub>;
    const client = openPeerStream(
      {
        url: `http://127.0.0.1:${port}`,
        token: "tok-b",
        from: identityB.node_id,
        proof: pairingProof(identityB, "tok-b"),
      },
      {
        onEvent: () => {},
        onDrop: () => drops.push(Date.now()),
      },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(streamHub.isOpen(identityB.node_id)).toBe(true);
    // Le serveur meurt: la stream droppe, le client reconnecte (le retry).
    server.close();
    server.closeAllConnections();
    await new Promise((r) => setTimeout(r, 500));
    expect(drops.length).toBeGreaterThanOrEqual(1);
    // Le client tourne toujours (les retries vers le port mort ne crashent pas).
    client.stop();
    streamHub.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the hub push survives a broken stream (the write throws, the set prunes)", () => {
    const hub = new StreamHub();
    const broken = {
      writeHead: () => {},
      write: (() => {
        let writes = 0;
        return () => {
          writes += 1;
          if (writes > 1) throw new Error("EPIPE");
        };
      })(),
      on: () => {},
      end: () => {},
    } as unknown as Parameters<typeof hub.add>[1];
    hub.add("peer-x", broken);
    expect(hub.isOpen("peer-x")).toBe(true);
    const n = hub.push("peer-x", { type: "mail", data: {} });
    expect(n).toBe(0);
    expect(hub.isOpen("peer-x")).toBe(false);
    hub.stop();
  });
});

describe("the stream hub: the multi-add (the heartbeat created once)", () => {
  it("two streams on the same node: both get the push, the heartbeat exists once", () => {
    const hub = new StreamHub();
    const frames1: string[] = [];
    const frames2: string[] = [];
    const fake = (sink: string[]) => {
      let writes = 0;
      return {
        writeHead: () => {},
        write: (frame: string) => {
          writes += 1;
          sink.push(frame);
          void writes;
        },
        on: () => {},
        end: () => {},
      } as unknown as Parameters<typeof hub.add>[1];
    };
    const drop1 = hub.add("peer-1", fake(frames1));
    const drop2 = hub.add("peer-1", fake(frames2));
    expect(hub.isOpen("peer-1")).toBe(true);
    const n = hub.push("peer-1", { type: "mail", data: { x: 1 } });
    expect(n).toBe(2);
    expect(frames1.length).toBe(2); // : connected + l'event
    expect(frames2.length).toBe(2);
    drop1();
    drop2();
    expect(hub.isOpen("peer-1")).toBe(false);
    hub.stop();
  });
});
