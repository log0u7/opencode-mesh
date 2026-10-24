// Negative-path tests for the static import-graph audit in
// scripts/smoke-dist.mjs. The guard must FAIL when a v1-only package becomes
// statically reachable again, when the dynamic import() disappears, or when an
// undeclared bare dependency appears, and PASS on a pristine dual-entrypoint
// package. Each case builds a synthetic package in a temp dir, copies the real
// auditor next to its own dist (the script resolves the package root from its
// own location), and runs it under plain Node.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const auditor = fileURLToPath(new URL("../scripts/smoke-dist.mjs", import.meta.url));

const dirs: string[] = [];

function buildFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-mesh-audit-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  cpSync(auditor, join(root, "scripts", "smoke-dist.mjs"));
  return root;
}

function runAuditor(root: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "scripts", "smoke-dist.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

const PRISTINE_INDEX = `const load = () => import("./plugin.js");
export default {
  id: "fixture",
  setup: async () => () => {},
  async server(...args) {
    const { plugin } = await load();
    return plugin(...args);
  },
};
`;

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  version: "0.0.0",
  type: "module",
  main: "./dist/index.js",
});

// Minimal stubs for the runtime smoke checks the mesh auditor performs beyond
// the entry shape (SQLite engine, locks, identity). The audit never walks them
// (they are reached only dynamically), they only need to satisfy the script.
const LIB_STUBS = {
  "dist/lib/db.js": "export function openMeshDb(_path) {\n  return { close() {} };\n}\n",
  "dist/lib/locks.js": "export function tryLock() {\n  return true;\n}\n",
  "dist/lib/identity.js":
    'export function loadOrCreateIdentity() {\n  return { node_id: "n", fingerprint: "f" };\n}\n',
};

function baseFixture(indexJs: string): Record<string, string> {
  return {
    "package.json": PACKAGE_JSON,
    "dist/index.js": indexJs,
    "dist/plugin.js": "export const plugin = async () => ({});\n",
    ...LIB_STUBS,
  };
}

describe("smoke-dist static import-graph audit", () => {
  it("passes on a pristine dual-entrypoint package", () => {
    const root = buildFixture(baseFixture(PRISTINE_INDEX));
    const result = runAuditor(root);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("smoke-dist: OK");
    expect(result.status).toBe(0);
  });

  it("fails when @opencode-ai/plugin is statically imported", () => {
    const root = buildFixture({
      "package.json": PACKAGE_JSON,
      ...baseFixture(`import { tool } from "@opencode-ai/plugin";\n${PRISTINE_INDEX}`),
    });
    const result = runAuditor(root);
    expect(result.stderr).toContain("static import graph imports @opencode-ai/plugin");
    expect(result.status).toBe(1);
  });

  it("fails when dist/plugin.js is statically reachable", () => {
    const root = buildFixture({
      "package.json": PACKAGE_JSON,
      ...baseFixture(`import { plugin } from "./plugin.js";\n${PRISTINE_INDEX}`),
    });
    const result = runAuditor(root);
    expect(result.stderr).toContain(
      "dist/plugin.js (v1 implementation) is reachable from the static import graph",
    );
    expect(result.status).toBe(1);
  });

  it("fails when the entrypoint has no dynamic import of ./plugin.js", () => {
    const root = buildFixture({
      "package.json": PACKAGE_JSON,
      ...baseFixture(
        'export default {\n  id: "fixture",\n  setup: async () => () => {},\n  server: async () => ({}),\n};\n',
      ),
    });
    const result = runAuditor(root);
    expect(result.stderr).toContain("entrypoint never dynamically imports ./plugin.js");
    expect(result.status).toBe(1);
  });

  it("fails on a bare import that is neither @opencode/plugin nor declared", () => {
    const root = buildFixture({
      "package.json": PACKAGE_JSON,
      ...baseFixture(`import { z } from "zod";\n${PRISTINE_INDEX}`),
    });
    const result = runAuditor(root);
    expect(result.stderr).toContain('static import of "zod"');
    expect(result.status).toBe(1);
  });
});
