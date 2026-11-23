import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { SpawnFn } from "./lib/spawn.js";
import type { WorktreeClient } from "./lib/worktree.js";

// Shared option plumbing for both host generations. This module sits in the
// STATIC import graph of the package (the v2 adapter imports it directly), so
// it must never import a host-provided package: see scripts/smoke-dist.mjs.

export type PluginOptions = {
  dataDir?: string;
  port?: number;
  bind?: "loopback" | "lan";
  advertise?: boolean;
  /** Optional declarative mailbox for this instance (re-bound at every TUI
   * bind, after the dynamic instance-keyed boxes: last act wins). */
  mailbox?: string;
  /** Informational role stored with the declarative mailbox. */
  mailboxRole?: string;
  /** Disable the mailbox wake loop (default: enabled). */
  wake?: boolean;
  /** Wake poll interval in ms (default 5000). */
  wakeIntervalMs?: number;
  /** Serve TLS on the mesh port (default true). */
  tls?: boolean;
  /** Open a documented plain-HTTP side channel on port+1 (default false). */
  insecureHttp?: boolean;
  /** Push the local shareable-memory outbox to paired peers (default true).
   * Reception of peers' pushes is always on: only the outbound loop is gated. */
  memorySync?: boolean;
  /** Outbox push cadence in minutes (default 15). 0 disables the push loop. */
  memorySyncInterval?: number;
  worktreeClient?: WorktreeClient;
  spawnFn?: SpawnFn;
};

// Validate the host-supplied options once, at the boundary. A typo'd port or
// bind used to surface as a late, cryptic failure (EADDRINUSE, a bind on the
// wrong interface, or a data dir at the filesystem root); fail clearly here.
export function parseOptions(raw: PluginOptions | undefined): PluginOptions {
  const options: PluginOptions = {};
  // `null` is treated as "no options" (the old code tolerated it); a non-object
  // is a programming error. Unknown keys are ignored on purpose: a host may pass
  // its own option bag, and forward-compat beats rejecting a typo'd `datadir`.
  if (raw === undefined || raw === null) {
    return options;
  }
  if (typeof raw !== "object") {
    throw new Error("opencode-mesh: options must be an object");
  }
  if (raw.dataDir !== undefined) {
    if (typeof raw.dataDir !== "string" || raw.dataDir.length === 0) {
      throw new Error("opencode-mesh: options.dataDir must be a non-empty string");
    }
    options.dataDir = raw.dataDir;
  }
  if (raw.port !== undefined) {
    if (
      typeof raw.port !== "number" ||
      !Number.isInteger(raw.port) ||
      raw.port < 0 ||
      raw.port > 65535
    ) {
      throw new Error("opencode-mesh: options.port must be an integer between 0 and 65535");
    }
    options.port = raw.port;
  }
  if (raw.bind !== undefined) {
    if (raw.bind !== "loopback" && raw.bind !== "lan") {
      throw new Error('opencode-mesh: options.bind must be "loopback" or "lan"');
    }
    options.bind = raw.bind;
  }
  if (raw.advertise !== undefined) {
    if (typeof raw.advertise !== "boolean") {
      throw new Error("opencode-mesh: options.advertise must be a boolean");
    }
    options.advertise = raw.advertise;
  }
  if (raw.wake !== undefined) {
    if (typeof raw.wake !== "boolean") {
      throw new Error("opencode-mesh: options.wake must be a boolean");
    }
    options.wake = raw.wake;
  }
  if (raw.mailbox !== undefined) {
    if (typeof raw.mailbox !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(raw.mailbox)) {
      throw new Error(
        "opencode-mesh: options.mailbox must be 1-64 chars of letters, digits, . _ -",
      );
    }
    options.mailbox = raw.mailbox;
  }
  if (raw.mailboxRole !== undefined) {
    if (typeof raw.mailboxRole !== "string" || raw.mailboxRole.length === 0) {
      throw new Error("opencode-mesh: options.mailboxRole must be a non-empty string");
    }
    options.mailboxRole = raw.mailboxRole;
  }
  if (raw.wakeIntervalMs !== undefined) {
    if (
      typeof raw.wakeIntervalMs !== "number" ||
      !Number.isInteger(raw.wakeIntervalMs) ||
      raw.wakeIntervalMs <= 0
    ) {
      throw new Error("opencode-mesh: options.wakeIntervalMs must be a positive integer");
    }
    options.wakeIntervalMs = raw.wakeIntervalMs;
  }
  if (raw.tls !== undefined) {
    if (typeof raw.tls !== "boolean") {
      throw new Error("opencode-mesh: options.tls must be a boolean");
    }
    options.tls = raw.tls;
  }
  if (raw.insecureHttp !== undefined) {
    if (typeof raw.insecureHttp !== "boolean") {
      throw new Error("opencode-mesh: options.insecureHttp must be a boolean");
    }
    options.insecureHttp = raw.insecureHttp;
  }
  if (raw.memorySync !== undefined) {
    if (typeof raw.memorySync !== "boolean") {
      throw new Error("opencode-mesh: options.memorySync must be a boolean");
    }
    options.memorySync = raw.memorySync;
  }
  if (raw.memorySyncInterval !== undefined) {
    if (
      typeof raw.memorySyncInterval !== "number" ||
      !Number.isInteger(raw.memorySyncInterval) ||
      raw.memorySyncInterval < 0
    ) {
      throw new Error(
        "opencode-mesh: options.memorySyncInterval must be a non-negative integer (minutes, 0 = off)",
      );
    }
    options.memorySyncInterval = raw.memorySyncInterval;
  }
  // Opaque collaborators are passed through untouched: the plugin cannot
  // validate a client or spawn function beyond its nominal type.
  if (raw.worktreeClient !== undefined) {
    options.worktreeClient = raw.worktreeClient;
  }
  if (raw.spawnFn !== undefined) {
    options.spawnFn = raw.spawnFn;
  }
  return options;
}

export function defaultDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homeDir(), ".local", "share");
  return join(dataHome, "opencode-mesh");
}

// `os.homedir()` / `os.tmpdir()` replace the old empty-string fallback, which
// produced a path at the filesystem root (`/.local/share/...`) when HOME was
// unset or blank.
function homeDir(): string {
  return process.env.HOME || homedir() || tmpdir();
}
