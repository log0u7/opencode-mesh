// Loads the built package under plain Node ESM, outside vitest. Vitest's module
// runner injects a `require` that hides `require is not defined` bugs in the
// shipped ESM output; this script has no such shim, so the published artifact
// is exercised exactly as a consumer loads it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const distUrl = new URL("../dist/index.js", import.meta.url);

let exitCode = 0;

function fail(message) {
  process.stderr.write(`smoke-dist: FAIL ${message}\n`);
  exitCode = 1;
}

try {
  const module = await import(distUrl.href);

  if (typeof module.default !== "object" || module.default === null) {
    fail("default export is not an object");
  }
  if (typeof module.default.server !== "function") {
    fail("default export has no server() plugin factory (v1 entry)");
  }
  if (typeof module.MeshPlugin !== "function") {
    fail("named export MeshPlugin is missing");
  }
  // The v2 entry: a host that loads the package for setup() must find it.
  if (typeof module.default.setup !== "function") {
    fail("default export has no setup() plugin factory (v2 entry)");
  }
  if (typeof module.default.id !== "string" || module.default.id.length === 0) {
    fail("default export has no plugin id (v2 entry)");
  }

  // The Node fallback paths: identity generation and the SQLite engine both
  // must run under plain Node with no Bun runtime present.
  const dbMod = await import(new URL("../dist/lib/db.js", import.meta.url).href);
  const identityMod = await import(new URL("../dist/lib/identity.js", import.meta.url).href);

  const db = dbMod.openMeshDb(":memory:");
  const locks = await import(new URL("../dist/lib/locks.js", import.meta.url).href);
  if (
    !locks.tryLock(db, { path: "a", owner_node: "n", owner_session: "s", ttl_ms: 1000, now: 0 })
  ) {
    fail("tryLock returned false on a fresh database");
  }
  db.close();

  const dir = mkdtempSync(join(tmpdir(), "opencode-mesh-smoke-"));
  try {
    const identity = identityMod.loadOrCreateIdentity(dir);
    if (!identity.node_id || !identity.fingerprint) {
      fail("loadOrCreateIdentity returned no node_id/fingerprint");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  fail(error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error));
}

if (exitCode === 0) {
  process.stdout.write("smoke-dist: OK\n");
}
process.exit(exitCode);
