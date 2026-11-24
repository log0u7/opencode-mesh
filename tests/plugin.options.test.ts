import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultDataDir, parseOptions } from "../src/plugin.js";

const savedHome = process.env.HOME;
const savedXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
  restore("HOME", savedHome);
  restore("XDG_DATA_HOME", savedXdg);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("parseOptions", () => {
  it("accepts the documented options and passes opaque clients through", () => {
    const worktreeClient = { create: () => {}, remove: () => {} } as never;
    const spawnFn = (() => {}) as never;

    const options = parseOptions({
      dataDir: "/data",
      port: 4399,
      bind: "lan",
      advertise: false,
      worktreeClient,
      spawnFn,
    });

    expect(options).toMatchObject({ dataDir: "/data", port: 4399, bind: "lan", advertise: false });
    expect(options.worktreeClient).toBe(worktreeClient);
    expect(options.spawnFn).toBe(spawnFn);
  });

  it("treats undefined and null options as an empty set", () => {
    expect(parseOptions(undefined)).toEqual({});
    expect(parseOptions(null as unknown as undefined)).toEqual({});
  });

  it("rejects a non-object option bag", () => {
    expect(() => parseOptions("lan" as unknown as undefined)).toThrow(/options/);
  });

  it("ignores unknown keys for forward compatibility", () => {
    // A host may pass its own option bag; an unrecognised key must not fail
    // setup, but it must not be mistaken for a validated option either.
    const options = parseOptions({ datadir: "/typo", port: 4399 } as never);
    expect(options).toEqual({ port: 4399 });
  });

  it("silently ignores the retired spawnWorkspace option (0.25.1)", () => {
    // A 0.25.0 config may still carry spawnWorkspace: the workspace concept
    // is gone, the residual option must not fail setup nor impose a
    // directory.
    const options = parseOptions({ spawnWorkspace: "~/projets/fleet", port: 4399 } as never);
    expect(options).toEqual({ port: 4399 });
  });

  it("rejects a port outside [0, 65535] or not an integer", () => {
    for (const port of [-1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseOptions({ port }), `port: ${port}`).toThrow(/port/);
    }
  });

  it("rejects a non-numeric port", () => {
    expect(() => parseOptions({ port: "4399" as unknown as number })).toThrow(/port/);
  });

  it("accepts spawnWorktreeBase as a non-empty string (0.24.7)", () => {
    expect(parseOptions({ spawnWorktreeBase: "/srv/spawns" })).toMatchObject({
      spawnWorktreeBase: "/srv/spawns",
    });
    expect(parseOptions({})).not.toHaveProperty("spawnWorktreeBase");
    expect(() => parseOptions({ spawnWorktreeBase: "" })).toThrow(/spawnWorktreeBase/);
    expect(() => parseOptions({ spawnWorktreeBase: 42 as unknown as string })).toThrow(
      /spawnWorktreeBase/,
    );
  });

  it("rejects a bind outside the enum", () => {
    expect(() => parseOptions({ bind: "wan" as unknown as "lan" })).toThrow(/bind/);
  });

  it("rejects a non-boolean advertise", () => {
    expect(() => parseOptions({ advertise: "yes" as unknown as boolean })).toThrow(/advertise/);
  });

  it("accepts wakePools as a boolean (absent = undefined, wake defaults it to false)", () => {
    expect(parseOptions({ wakePools: true })).toMatchObject({ wakePools: true });
    expect(parseOptions({ wakePools: false })).toMatchObject({ wakePools: false });
    expect(parseOptions(undefined).wakePools).toBeUndefined();
  });

  it("rejects a non-boolean wakePools", () => {
    expect(() => parseOptions({ wakePools: "no" as unknown as boolean })).toThrow(/wakePools/);
  });

  it("accepts icons as a boolean (absent = undefined, the panel defaults it to true)", () => {
    expect(parseOptions({ icons: true })).toMatchObject({ icons: true });
    expect(parseOptions({ icons: false })).toMatchObject({ icons: false });
    expect(parseOptions(undefined).icons).toBeUndefined();
  });

  it("rejects a non-boolean icons", () => {
    expect(() => parseOptions({ icons: "no" as unknown as boolean })).toThrow(/icons/);
  });

  it("rejects an empty or non-string dataDir", () => {
    expect(() => parseOptions({ dataDir: "" })).toThrow(/dataDir/);
    expect(() => parseOptions({ dataDir: 5 as unknown as string })).toThrow(/dataDir/);
  });

  it("accepts providers toggles and static addresses", () => {
    const options = parseOptions({
      providers: { netbird: false },
      addresses: ["10.8.0.2", "fd00::2"],
    });
    expect(options.providers).toEqual({ netbird: false });
    expect(options.addresses).toEqual(["10.8.0.2", "fd00::2"]);
  });

  it("rejects a malformed providers bag", () => {
    expect(() => parseOptions({ providers: "on" as never })).toThrow(/providers/);
    expect(() => parseOptions({ providers: { netbird: "no" as never } })).toThrow(
      /providers\.netbird/,
    );
    expect(() => parseOptions({ providers: null as never })).toThrow(/providers/);
  });

  it("rejects malformed static addresses", () => {
    expect(() => parseOptions({ addresses: "10.8.0.2" as never })).toThrow(/addresses/);
    expect(() => parseOptions({ addresses: [42] as never })).toThrow(/addresses/);
    expect(() => parseOptions({ addresses: [""] })).toThrow(/addresses/);
  });

  // CI coverage debt (0.18.1): the validation branches for these options were
  // never exercised. Same contract as the port/bind/advertise tests above.
  it("accepts the wake, tls, insecureHttp, memorySync and mailbox options", () => {
    const options = parseOptions({
      wake: true,
      wakeIntervalMs: 1000,
      tls: false,
      insecureHttp: true,
      memorySync: false,
      memorySyncInterval: 30,
      mailbox: "ops.alert-1",
      mailboxRole: "manager",
    });
    expect(options).toMatchObject({
      wake: true,
      wakeIntervalMs: 1000,
      tls: false,
      insecureHttp: true,
      memorySync: false,
      memorySyncInterval: 30,
      mailbox: "ops.alert-1",
      mailboxRole: "manager",
    });
  });

  it("accepts memorySyncInterval 0 (the documented off switch)", () => {
    expect(parseOptions({ memorySyncInterval: 0 })).toMatchObject({ memorySyncInterval: 0 });
    expect(parseOptions({ wakeIntervalMs: 1 })).toMatchObject({ wakeIntervalMs: 1 });
  });

  it("rejects a non-boolean wake", () => {
    expect(() => parseOptions({ wake: "yes" as unknown as boolean })).toThrow(/wake/);
  });

  it("rejects a wakeIntervalMs that is not a positive integer", () => {
    expect(() => parseOptions({ wakeIntervalMs: 0 })).toThrow(/wakeIntervalMs/);
    expect(() => parseOptions({ wakeIntervalMs: 1.5 })).toThrow(/wakeIntervalMs/);
    expect(() => parseOptions({ wakeIntervalMs: "fast" as unknown as number })).toThrow(
      /wakeIntervalMs/,
    );
  });

  it("rejects a non-boolean tls", () => {
    expect(() => parseOptions({ tls: "on" as unknown as boolean })).toThrow(/tls/);
  });

  it("rejects a non-boolean insecureHttp", () => {
    expect(() => parseOptions({ insecureHttp: 1 as unknown as boolean })).toThrow(/insecureHttp/);
  });

  it("rejects a non-boolean memorySync", () => {
    expect(() => parseOptions({ memorySync: "true" as unknown as boolean })).toThrow(/memorySync/);
  });

  it("rejects a memorySyncInterval that is not a non-negative integer", () => {
    expect(() => parseOptions({ memorySyncInterval: -5 })).toThrow(/memorySyncInterval/);
    expect(() => parseOptions({ memorySyncInterval: 2.5 })).toThrow(/memorySyncInterval/);
    expect(() => parseOptions({ memorySyncInterval: "soon" as unknown as number })).toThrow(
      /memorySyncInterval/,
    );
  });

  it("rejects a mailbox outside the allowed charset or size", () => {
    expect(() => parseOptions({ mailbox: "bad mailbox!" })).toThrow(/mailbox/);
    expect(() => parseOptions({ mailbox: "x".repeat(65) })).toThrow(/mailbox/);
  });

  it("rejects an empty or non-string mailboxRole", () => {
    expect(() => parseOptions({ mailboxRole: "" })).toThrow(/mailboxRole/);
    expect(() => parseOptions({ mailboxRole: 5 as unknown as string })).toThrow(/mailboxRole/);
  });
});

describe("defaultDataDir", () => {
  it("never resolves to a root-level path when HOME is unset", () => {
    delete process.env.HOME;
    delete process.env.XDG_DATA_HOME;

    const dir = defaultDataDir();

    // The old fallback (``${HOME ?? ""}/.local/share``) produced `/.local/share/...`
    // at the filesystem root when HOME was empty.
    expect(dir.startsWith("/.local")).toBe(false);
    expect(isAbsolute(dir)).toBe(true);
    expect(dir.endsWith(join("opencode-mesh"))).toBe(true);
  });

  it("honours XDG_DATA_HOME when set", () => {
    process.env.XDG_DATA_HOME = "/xdg/data";
    expect(defaultDataDir()).toBe(join("/xdg/data", "opencode-mesh"));
  });

  it("never resolves to a root-level path when HOME is blank", () => {
    process.env.HOME = "";
    delete process.env.XDG_DATA_HOME;

    expect(defaultDataDir().startsWith("/.local")).toBe(false);
  });
});
