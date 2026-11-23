import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MeshPlugin } from "../src/plugin.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-e2e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The offer reads `...address="host:port"`: isolate the tail so the regex
// cannot match the node_id pair that precedes it.
function addressPart(offer: string): string {
  return offer.slice(offer.indexOf("address="));
}

function ctx(sessionID: string) {
  return {
    sessionID,
    messageID: "m1",
    agent: "build",
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as never;
}

function input() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: "/work/project",
    worktree: "/work/project",
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

describe("e2e: two plugin instances", () => {
  it("pairs via token and delivers mail end to end", async () => {
    const a = await MeshPlugin(input(), { dataDir: `${dir}/a`, port: 0, advertise: false });
    const b = await MeshPlugin(input(), { dataDir: `${dir}/b`, port: 0, advertise: false });

    // A generates a pairing offer: token + its own node id + server address.
    const offerA = String(await a.tool?.mesh_pair?.execute({}, ctx("s-a")));
    const tokenA = /token="([^"]+)"/.exec(offerA)?.[1];
    const nodeIdA = /node_id="([^"]+)"/.exec(offerA)?.[1];
    const addressA = /address="([^"]+)"/.exec(addressPart(offerA))?.[1];
    const pkA = /pk="([^"]+)"/.exec(addressPart(offerA))?.[1];
    expect(tokenA).toBeTruthy();
    expect(nodeIdA).toBeTruthy();
    expect(addressA).toBeTruthy();
    expect(pkA).toBeTruthy();

    // B generates its own offer too: an offer alone must not be able to mint a
    // permanent peer on the other side.
    const offerB = String(await b.tool?.mesh_pair?.execute({}, ctx("s-b")));
    const tokenB = /token="([^"]+)"/.exec(offerB)?.[1];
    const nodeIdB = /node_id="([^"]+)"/.exec(offerB)?.[1];
    const addressB = /address="([^"]+)"/.exec(addressPart(offerB))?.[1];
    const pkB = /pk="([^"]+)"/.exec(addressPart(offerB))?.[1];

    // Each operator completes the other side's offer explicitly, carrying the
    // offer's public key: the completing side pins the emitter's signing key.
    await b.tool?.mesh_pair?.execute(
      { node_id: nodeIdA, token: tokenA, address: addressA, pk: pkA },
      ctx("s-b"),
    );
    await a.tool?.mesh_pair?.execute(
      { node_id: nodeIdB, token: tokenB, address: addressB, pk: pkB },
      ctx("s-a"),
    );

    // ...and B sends mail to A through the peer connection.
    const send = String(
      await b.tool?.mesh_send?.execute(
        { peer: nodeIdA, subject: "handoff", body: "api done" },
        ctx("s-b"),
      ),
    );
    expect(send).toContain("ok");

    // A reads the message from its inbox.
    const inbox = String(await a.tool?.mesh_inbox?.execute({}, ctx("s-a")));
    expect(inbox).toContain("handoff");
    expect(inbox).toContain("api done");

    // Inbox acks: second read is empty.
    const after = String(await a.tool?.mesh_inbox?.execute({}, ctx("s-a")));
    expect(after).toContain("empty");

    await a.dispose?.();
    await b.dispose?.();
  });

  it("pairs via 6-digit code over TLS (TOFU pin) and delivers mail", async () => {
    const a = await MeshPlugin(input(), { dataDir: `${dir}/ca`, port: 0, advertise: false });
    const b = await MeshPlugin(input(), { dataDir: `${dir}/cb`, port: 0, advertise: false });

    const statusA = JSON.parse(String(await a.tool?.mesh_status?.execute({}, ctx("s-a")))) as {
      server: string;
    };
    const offerA = String(await a.tool?.mesh_pair?.execute({}, ctx("s-a")));
    const code = /pairing code: (\d{6})/.exec(offerA)?.[1];
    const nodeIdA = /node_id="([^"]+)"/.exec(offerA)?.[1];
    expect(code).toBeTruthy();
    expect(nodeIdA).toBeTruthy();

    // B consumes the code, addressing A explicitly: first contact is TLS TOFU
    // (unpinned), then both sides pin each other's Ed25519 key.
    const paired = String(
      await b.tool?.mesh_pair?.execute({ code, address: statusA.server }, ctx("s-b")),
    );
    expect(paired).toContain("pairé des deux côtés");

    // B sends to A over the pinned TLS channel.
    const send = String(
      await b.tool?.mesh_send?.execute(
        { peer: nodeIdA, subject: "code-tls", body: "via code" },
        ctx("s-b"),
      ),
    );
    expect(send).toContain("ok");

    const inbox = String(await a.tool?.mesh_inbox?.execute({}, ctx("s-a")));
    expect(inbox).toContain("code-tls");
    expect(inbox).toContain("via code");

    await a.dispose?.();
    await b.dispose?.();
  });
});
