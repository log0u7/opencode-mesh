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

  it("rejects a port outside [0, 65535] or not an integer", () => {
    for (const port of [-1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseOptions({ port }), `port: ${port}`).toThrow(/port/);
    }
  });

  it("rejects a non-numeric port", () => {
    expect(() => parseOptions({ port: "4399" as unknown as number })).toThrow(/port/);
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
