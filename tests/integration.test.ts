import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { inboxRows, registerMailbox, unreadMessages } from "../src/lib/mail.js";
import { pairWithToken } from "../src/lib/peers.js";
import { sendMail } from "../src/lib/client.js";
import { startMeshServer } from "../src/lib/serve.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-mesh-integration-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function startNode(name: string) {
  const db = openMeshDb(join(dir, `${name}.db`));
  const { server, port } = await startMeshServer({
    db,
    port: 0,
    tls: false,
    self: { node_id: name, pk: "test-pk", hostname: name },
  });
  return { db, server, url: `http://127.0.0.1:${port}` };
}

function field(offer: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(offer.slice(offer.indexOf(`${name}=`)));
  return match?.[1] ?? "";
}

function ctx() {
  return {} as never;
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

describe("two-node integration", () => {
  it("round-trips mail: sender -> receiver inbox, then ack", async () => {
    const a = await startNode("a");
    const b = await startNode("b");

    // Each side pairs the other. The token that matters for sending is the one
    // the RECEIVER issued: B pairs node-a (tokenForA), so A authenticates to B with it.
    pairWithToken(b.db, { node_id: "node-a", hostname: "a", fingerprint: "fa", token: "tok-a" });
    const tokenForA = "tok-a";
    pairWithToken(a.db, { node_id: "node-b", hostname: "b", fingerprint: "fb", token: "tok-b" });

    const result = await sendMail({
      url: b.url,
      token: tokenForA,
      from: "node-a",
      subject: "handoff",
      body: "api layer is done, tests green",
    });
    expect(result).toBe("ok");

    const inbox = unreadMessages(b.db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.subject).toBe("handoff");
    expect(inbox[0]?.from).toBe("node-a");

    // Issued pairing tokens stay long and unguessable (base64url of 32 bytes).
    const { createPairingToken } = await import("../src/lib/peers.js");
    expect(createPairingToken(a.db).length).toBeGreaterThan(10);

    a.server.close();
    b.server.close();
    a.db.close();
    b.db.close();
  });

  it("round-trips mail addressed to a named mailbox on the peer", async () => {
    const a = await startNode("a2");
    const b = await startNode("b2");

    pairWithToken(b.db, { node_id: "node-a", hostname: "a", fingerprint: "fa", token: "tok-a2" });
    registerMailbox(b.db, { name: "somebox", session_id: "sess-b", now: Date.now() });

    const result = await sendMail({
      url: b.url,
      token: "tok-a2",
      from: "node-a",
      subject: "boxed",
      body: "for the box",
      to: "somebox",
    });
    expect(result).toBe("ok");

    const inbox = inboxRows(b.db, "sess-b");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.subject).toBe("boxed");
    expect(inbox[0]?.from).toBe("node-a");

    a.server.close();
    b.server.close();
    a.db.close();
    b.db.close();
  });

  it("reaches a peer discovered on an ephemeral port through mesh_send", async () => {
    // No requested port, so the receiver lands on whatever the OS picks: the
    // address a peer relays must already carry its own port.
    const { MeshPlugin } = await import("../src/plugin.js");
    const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-ephemeral-"));
    const a = await MeshPlugin(input(), { dataDir: join(dir, "a"), port: 0, advertise: false });
    const b = await MeshPlugin(input(), { dataDir: join(dir, "b"), port: 0, advertise: false });

    const aStatus = JSON.parse(String(await a.tool?.mesh_status?.execute({}, ctx()))) as {
      server: string;
    };
    const bStatus = JSON.parse(String(await b.tool?.mesh_status?.execute({}, ctx()))) as {
      server: string;
    };
    expect(aStatus.server).not.toBe(bStatus.server);

    // Exchange offers so each side knows the other, then send.
    const offerA = String(await a.tool?.mesh_pair?.execute({}, ctx()));
    const offerB = String(await b.tool?.mesh_pair?.execute({}, ctx()));
    await b.tool?.mesh_pair?.execute(
      {
        node_id: field(offerA, "node_id"),
        token: field(offerA, "token"),
        address: field(offerA, "address"),
        pk: field(offerA, "pk"),
      },
      ctx(),
    );
    await a.tool?.mesh_pair?.execute(
      {
        node_id: field(offerB, "node_id"),
        token: field(offerB, "token"),
        address: field(offerB, "address"),
        pk: field(offerB, "pk"),
      },
      ctx(),
    );

    const sent = String(
      await b.tool?.mesh_send?.execute(
        { peer: field(offerA, "node_id"), subject: "s", body: "b" },
        ctx(),
      ),
    );
    expect(sent).toContain("ok");

    await a.dispose?.();
    await b.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sendMail reports unreachable peers without throwing", async () => {
    const result = await sendMail({
      url: "http://127.0.0.1:1",
      token: "t",
      from: "node-a",
      subject: "x",
      body: "y",
    });
    expect(result).toBe("unreachable");
  });

  it("federates a pool broadcast across three nodes (fanout + dedup)", async () => {
    const { MeshPlugin } = await import("../src/plugin.js");
    const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-federate-"));
    const mk = async (name: string, mailbox: string, pool: string) => {
      const hooks = await MeshPlugin(input(), {
        dataDir: join(dir, name),
        port: 0,
        advertise: false,
      });
      // Local member.
      await hooks.tool?.mesh_register?.execute({ name: mailbox, role: "pair" }, {
        sessionID: `sess-${name}`,
      } as never);
      await hooks.tool?.mesh_join?.execute({ pool }, { sessionID: `sess-${name}` } as never);
      return hooks;
    };
    const a = await mk("a", "ops", "team:infra");
    const b = await mk("b", "sre", "team:infra");
    const c = await mk("c", "sre", "team:infra");

    // Fully pair the three nodes.
    const offer = async (hooks: Awaited<ReturnType<typeof MeshPlugin>>) =>
      String(await hooks.tool?.mesh_pair?.execute({}, {} as never));
    const statusOf = async (hooks: Awaited<ReturnType<typeof MeshPlugin>>) =>
      JSON.parse(String(await hooks.tool?.mesh_status?.execute({}, {} as never))) as {
        node_id: string;
        server: string;
      };
    const sa = await statusOf(a);
    const sb = await statusOf(b);
    const sc = await statusOf(c);
    const field = (offerText: string, name: string) =>
      new RegExp(`${name}="([^"]*)"`).exec(offerText.slice(offerText.indexOf(`${name}=`)))?.[1] ??
      "";
    const oA = await offer(a);
    const oB = await offer(b);
    const oC = await offer(c);
    await b.tool?.mesh_pair?.execute(
      { node_id: sa.node_id, token: field(oA, "token"), address: sa.server, pk: field(oA, "pk") },
      {} as never,
    );
    await a.tool?.mesh_pair?.execute(
      { node_id: sb.node_id, token: field(oB, "token"), address: sb.server, pk: field(oB, "pk") },
      {} as never,
    );
    await c.tool?.mesh_pair?.execute(
      { node_id: sb.node_id, token: field(oB, "token"), address: sb.server, pk: field(oB, "pk") },
      {} as never,
    );
    await b.tool?.mesh_pair?.execute(
      { node_id: sc.node_id, token: field(oC, "token"), address: sc.server, pk: field(oC, "pk") },
      {} as never,
    );
    await c.tool?.mesh_pair?.execute(
      { node_id: sa.node_id, token: field(oA, "token"), address: sa.server, pk: field(oA, "pk") },
      {} as never,
    );
    await a.tool?.mesh_pair?.execute(
      { node_id: sc.node_id, token: field(oC, "token"), address: sc.server, pk: field(oC, "pk") },
      {} as never,
    );

    // ops (node a) broadcasts to team:infra: sre on b AND c must receive it.
    const sent = String(
      await a.tool?.mesh_send?.execute(
        { to: "team:infra", subject: "status: fanout", body: "hello infra" },
        { sessionID: "sess-a" } as never,
      ),
    );
    expect(JSON.parse(sent) as { recipients: unknown }).toBeTruthy();

    await new Promise((r) => setTimeout(r, 300));
    const { inboxRows } = await import("../src/lib/mail.js");
    // The plugin hooks expose no db: open the per-node SQLite files directly.
    const bDb = openMeshDb(join(dir, "b", "mesh.db"));
    const cDb = openMeshDb(join(dir, "c", "mesh.db"));
    const bRows = inboxRows(bDb, "sess-b");
    const cRows = inboxRows(cDb, "sess-c");
    expect(bRows.map((r) => r.subject)).toContain("status: fanout");
    expect(cRows.map((r) => r.subject)).toContain("status: fanout");
    // Exactly one copy each (origin_id dedup across the two fanout paths).
    expect(bRows).toHaveLength(1);
    expect(cRows).toHaveLength(1);

    await a.dispose?.();
    await b.dispose?.();
    await c.dispose?.();
    bDb.close();
    cDb.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
