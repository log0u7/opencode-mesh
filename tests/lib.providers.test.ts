import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedProvider,
  listOwnAddresses,
  netbirdProvider,
  parseNetbirdStatus,
  parseZerotierNetworks,
  resetProviderCaches,
  zerotierProvider,
} from "../src/lib/providers.js";

const execFileMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: execFileMocks.execFile,
}));

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

beforeEach(() => {
  execFileMocks.execFile.mockReset();
  resetProviderCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cachedProvider", () => {
  it("caches the list within the TTL and refetches past it", async () => {
    let calls = 0;
    const cached = cachedProvider(
      "probe",
      async () => {
        calls += 1;
        return ["10.0.0.1"];
      },
      60_000,
      2_000,
    );
    const expiring = cachedProvider(
      "probe-expiring",
      async () => {
        calls += 1;
        return ["10.0.0.2"];
      },
      0,
      2_000,
    );

    expect(await cached.list()).toEqual(["10.0.0.1"]);
    expect(await cached.list()).toEqual(["10.0.0.1"]);
    await expiring.list();
    await expiring.list();
    // ttl=0 expires immediately: every call refetches.
    expect(calls).toBe(3);
  });

  it("passes the timeout to the fetch and refetches after reset()", async () => {
    const timeouts: number[] = [];
    const provider = cachedProvider(
      "probe",
      async (timeoutMs) => {
        timeouts.push(timeoutMs);
        return [];
      },
      60_000,
      1234,
    );

    await provider.list();
    provider.reset();
    await provider.list();

    expect(timeouts).toEqual([1234, 1234]);
  });

  it("resolves to an empty list when the fetch throws — never rejects", async () => {
    const provider = cachedProvider(
      "probe",
      async () => {
        throw new Error("boom");
      },
      60_000,
      2_000,
    );

    await expect(provider.list()).resolves.toEqual([]);
  });
});

describe("netbirdProvider", () => {
  // Real `netbird status --json` shape (upstream OutputOverview): our address
  // is the top-level `netbirdIp`, peers live under `peers.details`.
  const NETBIRD_JSON = JSON.stringify({
    cliVersion: "0.60.5",
    daemonVersion: "0.60.5",
    management: { url: "https://nb.example.com", connected: true },
    netbirdIp: "100.119.62.6/16",
    publicKey: "k1",
    fqdn: "laptop.netbird.cloud",
    peers: {
      total: 1,
      connected: 1,
      details: [
        {
          fqdn: "server.netbird.cloud",
          netbirdIp: "100.75.232.118",
          status: "Connected",
        },
      ],
    },
  });

  it("extracts this machine's netbird IP and ignores the peers'", async () => {
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "netbird") cb(null, NETBIRD_JSON, "");
      },
    );

    expect(await netbirdProvider.list()).toEqual(["100.119.62.6"]);
  });

  it("bounds the subprocess with a 2s timeout", async () => {
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "netbird") cb(null, NETBIRD_JSON, "");
      },
    );
    await netbirdProvider.list();

    // A wedged netbird daemon must not hang mesh_status forever.
    expect(execFileMocks.execFile).toHaveBeenCalledWith(
      "netbird",
      ["status", "--json"],
      expect.objectContaining({ timeout: 2000 }),
      expect.any(Function),
    );
  });

  it("returns empty when the CLI errors or the output is malformed", async () => {
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "netbird") cb(new Error("not found"), "", "");
      },
    );
    expect(await netbirdProvider.list()).toEqual([]);

    resetProviderCaches();
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "netbird") cb(null, "not-json", "");
      },
    );
    expect(await netbirdProvider.list()).toEqual([]);
  });

  it("falls back to alternate self-address fields defensively", () => {
    // Newer/older builds may name the field differently; peers are still
    // never consulted.
    expect(parseNetbirdStatus(JSON.stringify({ netbirdIP: "100.64.10.5/24" }))).toEqual([
      "100.64.10.5",
    ]);
    expect(parseNetbirdStatus(JSON.stringify({ ips: ["100.64.10.5/24"] }))).toEqual([
      "100.64.10.5",
    ]);
    expect(parseNetbirdStatus(JSON.stringify({ netbirdIps: ["100.64.10.5"] }))).toEqual([
      "100.64.10.5",
    ]);
    expect(parseNetbirdStatus(JSON.stringify({ self: { ip: "100.64.10.5" } }))).toEqual([
      "100.64.10.5",
    ]);
    expect(parseNetbirdStatus(JSON.stringify({ self: { netbirdIp: "100.64.10.5" } }))).toEqual([
      "100.64.10.5",
    ]);
    // Placeholders never surface.
    expect(parseNetbirdStatus(JSON.stringify({ netbirdIp: "0.0.0.0/16" }))).toEqual([]);
    expect(parseNetbirdStatus(JSON.stringify({ netbirdIp: "" }))).toEqual([]);
  });
});

describe("zerotierProvider", () => {
  // Real `zerotier-cli listnetworks` output: rows start with
  // "200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ZT assigned ips>".
  const ZT_TEXT = [
    "200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ZT assigned ips>",
    "200 listnetworks 8056c2e21c000001 CORPO-NET be:88:11:22:33:44 OK PRIVATE ztabcdef12 172.28.100.5/24,fd80:41cd:a2c8::5/48",
    "200 listnetworks 6ab56c0000cccccc labs 12:34:56:78:9a:bc OK PUBLIC zt1 192.168.191.5/24,10.10.10.5/24",
    "200 listnetworks 0cccb752f71aaaaa other aa:53:91:9e:2e:38 ACCESS_DENIED PRIVATE zt0 -",
    "200 listnetworks 9bee8941b5bbbbbb off 02:00:00:00:00:00 PORT_ERROR - -",
    "200 listnetworks",
  ].join("\n");

  it("parses the assigned-ip column: prefix stripped, IPv4 only, header skipped", () => {
    expect(parseZerotierNetworks(ZT_TEXT)).toEqual(["172.28.100.5", "192.168.191.5", "10.10.10.5"]);
  });

  it("extracts this machine's ZeroTier IPs via the CLI", async () => {
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "zerotier-cli") cb(null, ZT_TEXT, "");
      },
    );

    expect(await zerotierProvider.list()).toEqual(["172.28.100.5", "192.168.191.5", "10.10.10.5"]);
    expect(execFileMocks.execFile).toHaveBeenCalledWith(
      "zerotier-cli",
      ["listnetworks"],
      expect.objectContaining({ timeout: 2000 }),
      expect.any(Function),
    );
  });

  it("returns empty when the CLI errors or lists no IPv4 network", async () => {
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "zerotier-cli") cb(new Error("not found"), "", "");
      },
    );
    expect(await zerotierProvider.list()).toEqual([]);

    resetProviderCaches();
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "zerotier-cli") cb(null, "200 listnetworks <nwid> <name>", "");
      },
    );
    expect(await zerotierProvider.list()).toEqual([]);
  });
});

describe("listOwnAddresses", () => {
  it("concatenates enabled providers and static config, deduplicated", async () => {
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "tailscale") {
          cb(null, JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.1", "100.64.0.2"] } }), "");
        } else if (cmd === "netbird") {
          cb(null, JSON.stringify({ netbirdIp: "100.64.0.2/16" }), "");
        } else if (cmd === "zerotier-cli") {
          cb(
            null,
            "200 listnetworks abcdef0123456789 n 00:00:00:00:00:00 OK PRIVATE zt0 10.10.0.5/24",
            "",
          );
        }
      },
    );

    expect(await listOwnAddresses({ addresses: ["10.8.0.2", "100.64.0.1"] })).toEqual([
      "100.64.0.1",
      "100.64.0.2",
      "10.10.0.5",
      "10.8.0.2",
    ]);
  });

  it("does not call a provider disabled in config", async () => {
    execFileMocks.execFile.mockImplementation(
      (cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => {
        if (cmd === "tailscale") cb(null, JSON.stringify({ Self: { TailscaleIPs: [] } }), "");
        else if (cmd === "netbird") cb(null, "{}", "");
        else if (cmd === "zerotier-cli") cb(null, "200 listnetworks", "");
      },
    );

    await listOwnAddresses({ providers: { netbird: false } });

    const cmds = execFileMocks.execFile.mock.calls.map((call) => call[0]);
    expect(cmds).not.toContain("netbird");
    expect(cmds).toContain("tailscale");
    expect(cmds).toContain("zerotier-cli");
  });

  it("skips every provider when all are disabled and still renders static addresses", async () => {
    expect(
      await listOwnAddresses({
        providers: { tailscale: false, netbird: false, zerotier: false },
        addresses: ["10.8.0.9"],
      }),
    ).toEqual(["10.8.0.9"]);
    expect(execFileMocks.execFile).not.toHaveBeenCalled();
  });

  it("returns an empty list with no config and no CLIs — never throws", async () => {
    execFileMocks.execFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: ExecCb) => cb(new Error("ENOENT"), "", ""),
    );

    await expect(listOwnAddresses({})).resolves.toEqual([]);
  });
});
