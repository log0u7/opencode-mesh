import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pluginLogPath, pluginWarn, storeLogDir } from "../src/lib/plugin-log.js";

describe("pluginWarn", () => {
  const cwdLog = join(process.cwd(), "plugin.log");
  afterEach(() => rmSync(cwdLog, { force: true }));

  it("writes nothing without a store directory (never into the cwd)", () => {
    rmSync(cwdLog, { force: true });
    pluginWarn(undefined, "nowhere");
    expect(existsSync(cwdLog)).toBe(false);
  });

  it("resolves no log directory for an in-memory store", () => {
    expect(storeLogDir(":memory:")).toBeUndefined();
    expect(storeLogDir(undefined)).toBeUndefined();
    expect(storeLogDir("/var/lib/mesh/mesh.db")).toBe("/var/lib/mesh");
  });

  it("appends a timestamped line beside the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-plugin-log-"));
    pluginWarn(dir, "hello");
    expect(readFileSync(pluginLogPath(dir), "utf8")).toMatch(/^\d{4}-\d\d-\d\dT.* hello\n$/);
    rmSync(dir, { recursive: true, force: true });
  });
});
