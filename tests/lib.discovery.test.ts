import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tailnetAddresses } from "../src/lib/discovery.js";

const execFileMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: execFileMocks.execFile,
}));

beforeEach(() => {
  execFileMocks.execFile.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tailnetAddresses", () => {
  it("returns empty when tailscale is not installed", async () => {
    execFileMocks.execFile.mockImplementation((_cmd, _args, cb) =>
      cb(new Error("not found"), "", ""),
    );

    expect(await tailnetAddresses()).toEqual([]);
  });

  it("collects self addresses from tailscale status", async () => {
    execFileMocks.execFile.mockImplementation((_cmd, _args, cb) => {
      cb(null, JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"] } }), "");
    });

    expect(await tailnetAddresses()).toEqual(["100.64.0.1", "fd7a:115c:a1e0::1"]);
  });
});
