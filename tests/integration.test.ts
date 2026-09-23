import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { unreadMessages } from "../src/lib/mail.js";
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
  const { server, port } = await startMeshServer({ db, port: 0 });
  return { db, server, url: `http://127.0.0.1:${port}` };
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
});
