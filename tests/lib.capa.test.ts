import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openMeshDb } from "../src/lib/db.js";
import { insertWorker, setWorkerStatus } from "../src/lib/workers.js";
import {
  CAPA_TTL_MS,
  createHostCapa,
  parseNvidiaSmi,
  type GpuInfo,
  type HostCapa,
} from "../src/lib/capa.js";

const execFileMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: execFileMocks.execFile,
}));

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

const RTX: GpuInfo = { model: "NVIDIA GeForce RTX 3080", vramTotalMb: 10240, vramUsedMb: 2345 };

describe("parseNvidiaSmi", () => {
  it("parses the first csv row (name, memory.total, memory.used)", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 3080, 10240, 2345\n")).toEqual(RTX);
  });

  it("keeps commas inside the model name (only the last two fields are numbers)", () => {
    expect(parseNvidiaSmi("Card, Rev 2, 8192, 512")).toEqual({
      model: "Card, Rev 2",
      vramTotalMb: 8192,
      vramUsedMb: 512,
    });
  });

  it("returns null on garbage or empty output", () => {
    expect(parseNvidiaSmi("")).toBeNull();
    expect(parseNvidiaSmi("no gpu here")).toBeNull();
    expect(parseNvidiaSmi("Card, abc, 512")).toBeNull();
  });
});

describe("createHostCapa", () => {
  beforeEach(() => {
    execFileMocks.execFile.mockReset();
    // Default: no nvidia-smi on PATH (ENOENT) — the normal desktop case.
    execFileMocks.execFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: ExecCb) =>
        cb(new Error("ENOENT"), "", ""),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes os stats shapes with zero subprocess", async () => {
    const db = openMeshDb(":memory:");
    const sessionsRunning = vi.fn(() => 2);
    const capa = createHostCapa({ db, sessionsRunning });
    const snap: HostCapa = await capa.get();

    expect(snap.cpu.cores).toBeGreaterThanOrEqual(1);
    expect(snap.cpu.loadAvg).toBeGreaterThanOrEqual(0);
    expect(snap.ram.totalMb).toBeGreaterThan(0);
    expect(snap.ram.usedMb).toBeGreaterThanOrEqual(0);
    expect(snap.ram.usedMb).toBeLessThanOrEqual(snap.ram.totalMb);
    expect(snap.workersInFlight).toBe(0);
    expect(snap.sessionsRunning).toBe(2);
    expect(snap.gpu).toBeUndefined(); // no nvidia-smi in the test env
    expect(sessionsRunning).toHaveBeenCalledOnce();
    db.close();
  });

  it("renders a missing gpu as no gpu field, never an error", async () => {
    const db = openMeshDb(":memory:");
    const capa = createHostCapa({
      db,
      gpuFn: async () => null, // absent CLI or probe error resolves to null
      gpuTimeoutMs: 2000,
    });
    const snap = await capa.get();
    expect("gpu" in snap).toBe(false);
    db.close();
  });

  it("counts running mesh workers only", async () => {
    const db = openMeshDb(":memory:");
    insertWorker(db, { task: "t1", worktree_path: "/w1", branch: "b1", pid: 123 });
    insertWorker(db, { task: "t2", worktree_path: "/w2", branch: "b2", pid: 456 });
    const worker = insertWorker(db, { task: "t3", worktree_path: "/w3", branch: "b3", pid: 789 });
    setWorkerStatus(db, worker.id, "completed");
    const capa = createHostCapa({ db, gpuFn: async () => null });
    expect((await capa.get()).workersInFlight).toBe(2);
    db.close();
  });

  it("caches the snapshot for the TTL and refetches past it", async () => {
    const db = openMeshDb(":memory:");
    let calls = 0;
    const capa = createHostCapa({
      db,
      gpuFn: async () => {
        calls += 1;
        return RTX;
      },
      ttlMs: 0, // expires immediately: every get() refetches
    });
    const first = await capa.get();
    await capa.get();
    expect(calls).toBe(2);
    expect(first.gpu).toEqual(RTX);
    db.close();
  });

  it("serves two readers from one cache within the TTL", async () => {
    const db = openMeshDb(":memory:");
    let calls = 0;
    const capa = createHostCapa({
      db,
      gpuFn: async () => {
        calls += 1;
        return RTX;
      },
    });
    // /status and /metrics read the same provider back to back: one probe.
    const [a, b] = [await capa.get(), await capa.get()];
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    db.close();
  });

  it("uses the documented 60 s default TTL", () => {
    expect(CAPA_TTL_MS).toBe(60_000);
  });
});
