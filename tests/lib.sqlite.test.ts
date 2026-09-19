describe("openSqlite runtime guard", () => {
  it("falls back to node:sqlite when Bun exists without bun:sqlite", () => {
    const globalRuntime = globalThis as { Bun?: unknown };
    const original = globalRuntime.Bun;
    // opencode's compiled runtime exposes Bun without sqlite in some builds.
    globalRuntime.Bun = { version: "1.0.0" };

    try {
      const conn = openSqlite(":memory:");
      conn.run("CREATE TABLE t (a TEXT)");
      conn.run("INSERT INTO t VALUES (?)", ["works"]);
      expect(conn.get<{ a: string }>("SELECT a FROM t")?.a).toBe("works");
      conn.close();
    } finally {
      if (original === undefined) {
        delete globalRuntime.Bun;
      } else {
        globalRuntime.Bun = original;
      }
    }
  });
});
