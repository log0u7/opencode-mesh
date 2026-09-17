import { describe, expect, it } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { listLocks, releaseLock, tryLock } from "../src/lib/locks.js";

describe("locks", () => {
  it("grants exclusive lock: second owner blocked until release", () => {
    const db = openMeshDb(":memory:");

    expect(
      tryLock(db, {
        path: "src/api.ts",
        owner_node: "n1",
        owner_session: "s1",
        ttl_ms: 60_000,
        now: 1000,
      }),
    ).toBe(true);
    expect(
      tryLock(db, {
        path: "src/api.ts",
        owner_node: "n2",
        owner_session: "s2",
        ttl_ms: 60_000,
        now: 2000,
      }),
    ).toBe(false);

    expect(releaseLock(db, { path: "src/api.ts", owner_node: "n1" })).toBe(true);
    expect(
      tryLock(db, {
        path: "src/api.ts",
        owner_node: "n2",
        owner_session: "s2",
        ttl_ms: 60_000,
        now: 2000,
      }),
    ).toBe(true);

    db.close();
  });

  it("same owner re-locking is idempotent", () => {
    const db = openMeshDb(":memory:");

    expect(
      tryLock(db, {
        path: "src/api.ts",
        owner_node: "n1",
        owner_session: "s1",
        ttl_ms: 60_000,
        now: 1000,
      }),
    ).toBe(true);
    expect(
      tryLock(db, {
        path: "src/api.ts",
        owner_node: "n1",
        owner_session: "s1",
        ttl_ms: 60_000,
        now: 2000,
      }),
    ).toBe(true);

    db.close();
  });

  it("expired locks are released for new owners", () => {
    const db = openMeshDb(":memory:");

    tryLock(db, {
      path: "src/api.ts",
      owner_node: "n1",
      owner_session: "s1",
      ttl_ms: 1000,
      now: 1000,
    });
    expect(
      tryLock(db, {
        path: "src/api.ts",
        owner_node: "n2",
        owner_session: "s2",
        ttl_ms: 60_000,
        now: 1500,
      }),
    ).toBe(false);
    expect(
      tryLock(db, {
        path: "src/api.ts",
        owner_node: "n2",
        owner_session: "s2",
        ttl_ms: 60_000,
        now: 2500,
      }),
    ).toBe(true);

    db.close();
  });

  it("lists only live locks", () => {
    const db = openMeshDb(":memory:");

    tryLock(db, { path: "a", owner_node: "n1", owner_session: "s1", ttl_ms: 60_000, now: 1000 });
    tryLock(db, { path: "b", owner_node: "n1", owner_session: "s1", ttl_ms: 10, now: 1000 });

    const live = listLocks(db, { now: 2000 });
    expect(live.map((l) => l.path)).toEqual(["a"]);
    db.close();
  });
});
