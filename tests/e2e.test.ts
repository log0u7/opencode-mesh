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
    const aOffer = String(await a.tool?.mesh_pair?.execute({}, ctx("s-a")));
    const token = /token="([^"]+)"/.exec(aOffer)?.[1];
    const nodeIdA = /node_id="([^"]+)"/.exec(aOffer)?.[1];
    const addressA = /address="([^"]+)"/.exec(aOffer)?.[1];
    expect(token).toBeTruthy();
    expect(nodeIdA).toBeTruthy();
    expect(addressA).toBeTruthy();

    // B completes pairing with that offer...
    await b.tool?.mesh_pair?.execute({ node_id: nodeIdA, token, address: addressA }, ctx("s-b"));

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
});
