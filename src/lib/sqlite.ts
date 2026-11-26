export interface SqliteConn {
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  run(sql: string, params?: unknown[]): { changes: number };
  exec(sql: string): void;
  /** Is a transaction open on this connection? A leaked BEGIN pins the WAL
   * snapshot forever — the phantom-unread class — so callers assert on it. */
  inTransaction(): boolean;
  close(): void;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface BunSqliteDatabase {
  query(sql: string): SqliteStatement;
  run(sql: string, params?: unknown[]): unknown;
  /** bun:sqlite exposes a GETTER named inTransaction (bun-types 1.3.x).
   * db.isTransaction does NOT exist on bun — reading it returns undefined
   * and silently disarms every guard (the 0.27.1 class: node green, prod
   * engine differs). Verified on bun 1.3.14. */
  inTransaction: boolean;
  close(): void;
}

interface NodeSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  /** node:sqlite exposes isTransaction (added v22.16/v24). bun:sqlite does
   * NOT — the two engines name the same state differently. */
  isTransaction: boolean;
  close(): void;
}

function createPreparedConn(db: NodeSqliteDatabase): SqliteConn {
  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      const stmt = db.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    },
    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const stmt = db.prepare(sql);
      return (stmt.get(...(params ?? [])) as T | undefined) ?? null;
    },
    run(sql: string, params?: unknown[]): { changes: number } {
      const stmt = db.prepare(sql);
      const res = stmt.run(...(params ?? [])) as { changes?: number | bigint } | undefined;
      return { changes: Number(res?.changes ?? 0) };
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    inTransaction(): boolean {
      return db.isTransaction;
    },
    close(): void {
      db.close();
    },
  };
}

function createBunConn(db: BunSqliteDatabase): SqliteConn {
  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      return db.query(sql).all(...(params ?? [])) as T[];
    },
    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      return (db.query(sql).get(...(params ?? [])) as T | undefined) ?? null;
    },
    run(sql: string, params?: unknown[]): { changes: number } {
      const res = db.run(sql, params ?? []) as { changes?: number | bigint } | undefined;
      return { changes: Number(res?.changes ?? 0) };
    },
    exec(sql: string): void {
      db.run(sql);
    },
    inTransaction(): boolean {
      return db.inTransaction;
    },
    close(): void {
      db.close();
    },
  };
}

// Engine resolution at module load: OpenCode's compiled runtime (Bun 1.3.x)
// exposes neither `globalThis.Bun.sqlite` nor `node:sqlite` to hot-loaded
// plugins, but the `bun:sqlite` module itself IS available there. Node (tests,
// CI) has no bun:sqlite and falls back to node:sqlite via dynamic import:
// a static import would throw at module load on Bun before the fallback runs.
interface BunSqliteLike {
  Database: new (path: string) => BunSqliteDatabase;
}

let BunSqliteEngine: BunSqliteLike | null = null;
try {
  const specifier = "bun:sqlite";
  BunSqliteEngine = (await import(specifier)) as BunSqliteLike;
} catch {
  BunSqliteEngine = null;
}

interface NodeSqliteLike {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

let NodeSqliteEngine: NodeSqliteLike | null = null;
try {
  NodeSqliteEngine =
    ((await import("node:sqlite")) as { default?: NodeSqliteLike }).default ??
    ((await import("node:sqlite")) as NodeSqliteLike);
} catch {
  NodeSqliteEngine = null;
}

export function openSqlite(path: string): SqliteConn {
  const globalRuntime = globalThis as {
    Bun?: { sqlite?: { Database: BunSqliteLike["Database"] } };
  };

  if (globalRuntime.Bun?.sqlite?.Database) {
    return createBunConn(new globalRuntime.Bun.sqlite.Database(path));
  }

  if (BunSqliteEngine) {
    return createBunConn(new BunSqliteEngine.Database(path));
  }

  // node:sqlite ships with Node >= 22.5; a failed import leaves the engine
  // null, so tests get a clear error instead of a hidden require() ReferenceError.
  if (!NodeSqliteEngine) {
    throw new Error("no sqlite engine available: expected bun:sqlite or node:sqlite");
  }
  return createPreparedConn(new NodeSqliteEngine.DatabaseSync(path));
}
