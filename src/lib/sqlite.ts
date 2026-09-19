export interface SqliteConn {
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
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
  close(): void;
}

interface BunSqliteModule {
  Database: new (path: string) => BunSqliteDatabase;
}

interface NodeSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
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
    run(sql: string, params?: unknown[]): void {
      const stmt = db.prepare(sql);
      stmt.run(...(params ?? []));
    },
    exec(sql: string): void {
      db.exec(sql);
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
    run(sql: string, params?: unknown[]): void {
      db.run(sql, params ?? []);
    },
    exec(sql: string): void {
      db.run(sql);
    },
    close(): void {
      db.close();
    },
  };
}

// Engine resolution at module load: OpenCode's compiled runtime (Bun 1.3.x)
// exposes neither `globalThis.Bun.sqlite` nor `node:sqlite` to hot-loaded
// plugins, but the `bun:sqlite` module itself IS available there. Node (tests,
// CI) has no bun:sqlite and falls back to node:sqlite via createRequire.
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

  // node:sqlite ships with Node >= 22.5; require keeps non-node runtimes from
  // failing at module load and gives tests a clear error if the engine is absent.
  const { DatabaseSync } = require("node:sqlite") as NodeSqliteExports;
  return createPreparedConn(new DatabaseSync(path));
}

interface NodeSqliteExports {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}
