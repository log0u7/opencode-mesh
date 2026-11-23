// Modular address providers: "which overlay IPs does THIS machine hold".
// One provider = one function rendering this machine's addresses for one
// overlay (tailscale, netbird, zerotier). Tunnels without a CLI
// (WireGuard/IPsec/any SSL VPN) are covered by static `addresses` in the
// plugin config. Adding a new overlay = one function + one array entry, by PR —
// deliberately no runtime plugin system.

import { execFile } from "node:child_process";

export type AddressProvider = {
  name: string;
  list: () => Promise<string[]>;
};

/** Per-provider toggles; absent key = enabled (an uninstalled CLI resolves to
 * an empty list on its own, so leaving everything on is harmless). */
export type ProvidersConfig = {
  tailscale?: boolean;
  netbird?: boolean;
  zerotier?: boolean;
};

export type AddressOptions = {
  providers?: ProvidersConfig;
  /** Static addresses declared in config (this machine's WireGuard/IPsec/any
   * tunnel IPs), rendered as-is. */
  addresses?: string[];
};

// The shared-cache mold, extracted from the tailscale pattern: cache the
// result for ttlMs, run the subprocess under a hard timeout, and resolve
// absent CLI / timeout / malformed output to [] — never an error — because an
// unconfigured overlay is a normal state, not a failure.
export function cachedProvider(
  name: string,
  listFn: (timeoutMs: number) => Promise<string[]>,
  ttlMs: number,
  timeoutMs: number,
): AddressProvider & { reset(): void } {
  let cache: { addresses: string[]; expiresAt: number } | null = null;
  return {
    name,
    async list(): Promise<string[]> {
      if (cache !== null && cache.expiresAt > Date.now()) {
        return cache.addresses;
      }
      let addresses: string[] = [];
      try {
        const fetched = await listFn(timeoutMs);
        addresses = Array.isArray(fetched) ? fetched.filter((ip) => typeof ip === "string") : [];
      } catch {
        addresses = [];
      }
      cache = { addresses, expiresAt: Date.now() + ttlMs };
      return addresses;
    },
    reset() {
      cache = null;
    },
  };
}

// Strip an "/24"-style prefix and drop placeholders ("", "0.0.0.0").
function cleanAddress(addr: string): string | null {
  const ip = addr.split("/")[0]?.trim() ?? "";
  return ip.length > 0 && ip !== "0.0.0.0" && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : null;
}

function pushAddress(into: string[], raw: unknown): void {
  if (typeof raw === "string") {
    const ip = cleanAddress(raw);
    if (ip !== null) into.push(ip);
  } else if (Array.isArray(raw)) {
    for (const item of raw) pushAddress(into, item);
  }
}

// netbird: `netbird status --json` renders the upstream OutputOverview. This
// machine's address is the top-level `netbirdIp` (e.g. "100.119.62.6/16");
// peers live under `peers.details[].netbirdIp` and are deliberately never
// read. Defensive fallbacks cover older/newer builds that name the field
// differently (netbirdIP, ips/netbirdIps arrays, self.ip/self.netbirdIp).
function parseNetbirdStatusDoc(doc: Record<string, unknown>): string[] {
  const addresses: string[] = [];
  pushAddress(addresses, doc["netbirdIp"]);
  pushAddress(addresses, doc["netbirdIP"]);
  pushAddress(addresses, doc["ips"]);
  pushAddress(addresses, doc["netbirdIps"]);
  const self = doc["self"];
  if (self !== null && typeof self === "object") {
    const selfDoc = self as Record<string, unknown>;
    pushAddress(addresses, selfDoc["ip"]);
    pushAddress(addresses, selfDoc["netbirdIp"]);
  }
  return addresses;
}

export function parseNetbirdStatus(stdout: string): string[] {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return [];
  }
  return parseNetbirdStatusDoc(doc);
}

async function netbirdStatus(timeoutMs: number): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    execFile(
      "netbird",
      ["status", "--json"],
      { timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        resolve(error ? [] : parseNetbirdStatus(String(stdout)));
      },
    );
  });
}

// zerotier: `zerotier-cli listnetworks` prints tabular text — one status line
// plus one row per network, each shaped
// "200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ZT assigned ips>".
// The assigned IPs are the LAST column, comma-separated "ip/prefix" values.
// Rows are recognized by a 16-hex-char nwid in the third token, which also
// skips the "<nwid>" header line; "-" (no address) and non-IPv4 values drop
// out on their own.
export function parseZerotierNetworks(stdout: string): string[] {
  const addresses: string[] = [];
  for (const line of stdout.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] !== "200" || tokens[1] !== "listnetworks") continue;
    const nwid = tokens[2];
    if (nwid === undefined || !/^[0-9a-f]{16}$/i.test(nwid)) continue;
    const column = tokens[tokens.length - 1];
    if (column === undefined) continue;
    for (const entry of column.split(",")) {
      const ip = entry.split("/")[0]?.trim() ?? "";
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip !== "0.0.0.0") {
        addresses.push(ip);
      }
    }
  }
  return addresses;
}

async function zerotierNetworks(timeoutMs: number): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    execFile(
      "zerotier-cli",
      ["listnetworks"],
      { timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        resolve(error ? [] : parseZerotierNetworks(String(stdout)));
      },
    );
  });
}

// tailscale: the original provider this mold was extracted from.
async function tailscaleStatus(timeoutMs: number): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    execFile(
      "tailscale",
      ["status", "--json"],
      { timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          const status = JSON.parse(String(stdout)) as { Self?: { TailscaleIPs?: string[] } };
          const ips = status.Self?.TailscaleIPs;
          resolve(
            Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === "string") : [],
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

const CLI_TTL_MS = 60_000;
const CLI_TIMEOUT_MS = 2_000;

export const tailscaleProvider = cachedProvider(
  "tailscale",
  tailscaleStatus,
  CLI_TTL_MS,
  CLI_TIMEOUT_MS,
);
export const netbirdProvider = cachedProvider("netbird", netbirdStatus, CLI_TTL_MS, CLI_TIMEOUT_MS);
export const zerotierProvider = cachedProvider(
  "zerotier",
  zerotierNetworks,
  CLI_TTL_MS,
  CLI_TIMEOUT_MS,
);

export const ADDRESS_PROVIDERS: AddressProvider[] = [
  tailscaleProvider,
  netbirdProvider,
  zerotierProvider,
];

export function resetProviderCaches(): void {
  tailscaleProvider.reset();
  netbirdProvider.reset();
  zerotierProvider.reset();
}

// Back-compat aliases: the tailscale logic lived in discovery.ts before 0.15.0
// and discovery.ts still re-exports these names.
export function resetTailnetCache(): void {
  tailscaleProvider.reset();
}

export const tailnetAddresses = (): Promise<string[]> => tailscaleProvider.list();

// Every enabled provider, plus the static config addresses: the union of the
// overlay candidates this machine can be reached on. Deduplicated, stable
// order (providers first, config last).
export async function listOwnAddresses(options?: AddressOptions): Promise<string[]> {
  const enabled = (name: string): boolean =>
    (options?.providers as Record<string, boolean | undefined> | undefined)?.[name] !== false;

  const perProvider = await Promise.all(
    ADDRESS_PROVIDERS.filter((provider) => enabled(provider.name)).map((provider) =>
      provider.list(),
    ),
  );
  return [...new Set([...perProvider.flat(), ...(options?.addresses ?? [])])];
}
