import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  advertiseMesh,
  browseMesh,
  resetTailnetCache,
  tailnetAddresses,
  type DiscoveredPeer,
} from "../src/lib/discovery.js";
import { upsertDiscoveredPeer } from "../src/lib/peers.js";
import { openMeshDb } from "../src/lib/db.js";
import { listPeers } from "../src/lib/peers.js";

const execFileMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: execFileMocks.execFile,
}));

beforeEach(() => {
  execFileMocks.execFile.mockReset();
  resetTailnetCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type ServiceRecord = { name: string; type: string; port: number; txt?: Record<string, string> };

type FakeService = {
  port?: number;
  txt?: Record<string, string>;
  host?: string;
  name: string;
  addresses?: string[];
};

function fakeBonjour() {
  const published: ServiceRecord[] = [];
  const stops = vi.fn();
  let findCallback: ((service: FakeService) => void) | null = null;

  return {
    published,
    stops,
    emit(service: FakeService) {
      findCallback?.(service);
    },
    bonjour: {
      publish: (record: ServiceRecord) => {
        published.push(record);
        return { stop: stops };
      },
      find: (_types: unknown, onUp: (service: FakeService) => void) => {
        findCallback = onUp;
        return { stop: stops };
      },
    },
  };
}

describe("advertiseMesh", () => {
  it("publishes the service with id and fingerprint in TXT, close stops it", () => {
    const fake = fakeBonjour();
    const handle = advertiseMesh({
      bonjour: fake.bonjour as never,
      port: 4399,
      node_id: "n1",
      fingerprint: "abcd1234",
    });

    expect(fake.published[0]).toMatchObject({
      name: "n1",
      type: "opencode-mesh",
      port: 4399,
      txt: { id: "n1", fp: "abcd1234" },
    });

    handle.close();
    expect(fake.stops).toHaveBeenCalled();
  });
});

describe("browseMesh", () => {
  it("attaches the advertised port to every discovered address", () => {
    const fake = fakeBonjour();
    const seen: DiscoveredPeer[] = [];
    const handle = browseMesh({
      bonjour: fake.bonjour as never,
      onDiscovered: (p) => seen.push(p),
    });

    fake.emit({
      port: 5555,
      txt: { id: "peer-1", fp: "ff00" },
      host: "laptop.local",
      name: "peer-1",
      addresses: ["192.168.1.5", "fe80::1"],
    });

    expect(seen).toEqual([
      {
        node_id: "peer-1",
        hostname: "laptop.local",
        fingerprint: "ff00",
        // A bare IP is not routable: the port comes from the same mDNS record.
        addresses: ["192.168.1.5:5555", "[fe80::1]:5555"],
      },
    ]);

    handle.close();
    expect(fake.stops).toHaveBeenCalled();
  });

  it("drops addresses when the record carries no port", () => {
    const fake = fakeBonjour();
    const seen: DiscoveredPeer[] = [];
    browseMesh({ bonjour: fake.bonjour as never, onDiscovered: (p) => seen.push(p) });

    fake.emit({ txt: { id: "peer-1", fp: "ff00" }, name: "peer-1", addresses: ["192.168.1.5"] });

    expect(seen[0]?.addresses).toEqual([]);
  });

  it("upsertDiscoveredPeer stores the discovery in the peer table", () => {
    const db = openMeshDb(":memory:");
    upsertDiscoveredPeer(db, {
      node_id: "peer-2",
      hostname: "desktop",
      fingerprint: "ff11",
      addresses: ["10.0.0.2:4399"],
    });

    expect(listPeers(db)).toEqual([
      {
        node_id: "peer-2",
        hostname: "desktop",
        fingerprint: "ff11",
        addresses: ["10.0.0.2:4399"],
        paired: false,
        token: null,
        last_seen: expect.any(Number),
      },
    ]);
    db.close();
  });
});

describe("tailnetAddresses edge cases", () => {
  it("returns empty on malformed tailscale output", async () => {
    execFileMocks.execFile.mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void,
    ) => cb(null, "not-json")) as never);

    expect(await tailnetAddresses()).toEqual([]);
  });
});

describe("browseMesh host fallback", () => {
  it("falls back to service name when host is absent", () => {
    const fake = fakeBonjour();
    const seen: DiscoveredPeer[] = [];
    browseMesh({ bonjour: fake.bonjour as never, onDiscovered: (p) => seen.push(p) });

    fake.emit({ txt: { id: "peer-3", fp: "ff22" }, name: "peer-3-name" });

    expect(seen[0]?.hostname).toBe("peer-3-name");
    expect(seen[0]?.addresses).toEqual([]);
  });
});

describe("tailnetAddresses", () => {
  it("caches the status so repeated tool calls do not re-exec tailscale", async () => {
    execFileMocks.execFile.mockClear();
    execFileMocks.execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.9"] } }), ""),
    );

    const first = await tailnetAddresses();
    const second = await tailnetAddresses();

    expect(first).toEqual(["100.64.0.9"]);
    expect(second).toEqual(["100.64.0.9"]);
    expect(execFileMocks.execFile).toHaveBeenCalledTimes(1);
  });

  it("bounds the tailscale subprocess with a timeout", async () => {
    execFileMocks.execFile.mockClear();
    execFileMocks.execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.2"] } }), ""),
    );

    await tailnetAddresses();

    // A wedged tailscaled must not hang mesh_status forever.
    expect(execFileMocks.execFile).toHaveBeenCalledWith(
      "tailscale",
      ["status", "--json"],
      expect.objectContaining({ timeout: 2000 }),
      expect.any(Function),
    );
  });

  it("returns empty when tailscale is not installed", async () => {
    execFileMocks.execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(new Error("not found"), "", ""),
    );

    expect(await tailnetAddresses()).toEqual([]);
  });

  it("collects self addresses from tailscale status", async () => {
    execFileMocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.1"] } }), "");
    });

    expect(await tailnetAddresses()).toEqual(["100.64.0.1"]);
  });

  it("returns empty on malformed tailscale output", async () => {
    execFileMocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "not-json", ""));

    expect(await tailnetAddresses()).toEqual([]);
  });
});
