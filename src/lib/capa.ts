// Host capabilities: what THIS machine + mesh instance currently holds.
// One provider, one 60 s cache, shared by every reader (mesh_status tool, the
// /status endpoint, the /metrics endpoint) so a scrape never doubles the work.
// os.cpus/loadavg/totalmem/freemem cost zero subprocesses; the only probe is
// nvidia-smi for VRAM, and its absence (a CPU-only machine) is a normal state
// that simply leaves the `gpu` field out — the same contract as the address
// providers, whose cachedProvider mold this file mirrors.

import { execFile } from "node:child_process";
import os from "node:os";

import type { MeshDb } from "./db.js";

export type GpuInfo = {
  model: string;
  vramTotalMb: number;
  vramUsedMb: number;
};

export type HostCapa = {
  cpu: { cores: number; loadAvg: number };
  ram: { totalMb: number; usedMb: number };
  /** Present only when nvidia-smi answers (absent/errored probe = no field). */
  gpu?: GpuInfo;
  /** mesh_workers rows still `running`. */
  workersInFlight: number;
  /** Sessions mid-turn (the plugin-v2 `running` set from session.status/session.idle). */
  sessionsRunning: number;
};

export type HostCapaOptions = {
  db: MeshDb;
  /** Live mid-turn session count; plugin-v2 passes () => running.size. */
  sessionsRunning?: () => number;
  /** GPU probe override (tests); default nvidiaSmiGpu. */
  gpuFn?: (timeoutMs: number) => Promise<GpuInfo | null>;
  /** Snapshot cache TTL ms (default 60 s; 0 refetches on every get). */
  ttlMs?: number;
  gpuTimeoutMs?: number;
};

export type HostCapaProvider = {
  get(): Promise<HostCapa>;
  reset(): void;
};

export const CAPA_TTL_MS = 60_000;
export const GPU_TIMEOUT_MS = 2_000;

// `nvidia-smi --format=csv,noheader,nounits` renders one row per GPU:
// "NVIDIA GeForce RTX 3080, 10240, 2345". Only the LAST two fields are
// numbers, so model names containing commas survive the split. The first GPU
// is the one that matters (single-host mesh node).
export function parseNvidiaSmi(stdout: string): GpuInfo | null {
  const line = stdout.split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return null;
  const fields = line.split(",").map((f) => f.trim());
  if (fields.length < 3) return null;
  const usedMb = Number(fields[fields.length - 1]);
  const totalMb = Number(fields[fields.length - 2]);
  if (!Number.isFinite(totalMb) || !Number.isFinite(usedMb)) return null;
  return {
    model: fields.slice(0, -2).join(", "),
    vramTotalMb: totalMb,
    vramUsedMb: usedMb,
  };
}

function nvidiaSmiGpu(timeoutMs: number): Promise<GpuInfo | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
      { timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        resolve(error ? null : parseNvidiaSmi(String(stdout)));
      },
    );
  });
}

function workerCount(db: MeshDb): number {
  return (
    db.conn.get<{ count: number }>("SELECT COUNT(*) AS count FROM workers WHERE status = 'running'")
      ?.count ?? 0
  );
}

export function createHostCapa(options: HostCapaOptions): HostCapaProvider {
  const ttlMs = options.ttlMs ?? CAPA_TTL_MS;
  const gpuTimeoutMs = options.gpuTimeoutMs ?? GPU_TIMEOUT_MS;
  const gpuFn = options.gpuFn ?? nvidiaSmiGpu;
  let cache: { value: HostCapa; expiresAt: number } | null = null;

  return {
    async get(): Promise<HostCapa> {
      if (cache !== null && cache.expiresAt > Date.now()) {
        return cache.value;
      }
      // GPU first and never fatal: a missing CLI, a timeout or a malformed
      // row all resolve to "no gpu field" (aconitum is CPU-only, gpu3080 is not).
      const gpu = await gpuFn(gpuTimeoutMs).catch(() => null);
      const value: HostCapa = {
        cpu: { cores: os.cpus().length, loadAvg: os.loadavg()[0] ?? 0 },
        ram: {
          totalMb: Math.round(os.totalmem() / (1024 * 1024)),
          usedMb: Math.round((os.totalmem() - os.freemem()) / (1024 * 1024)),
        },
        workersInFlight: workerCount(options.db),
        sessionsRunning: options.sessionsRunning?.() ?? 0,
        ...(gpu !== null ? { gpu } : {}),
      };
      cache = { value, expiresAt: Date.now() + ttlMs };
      return value;
    },
    reset() {
      cache = null;
    },
  };
}
