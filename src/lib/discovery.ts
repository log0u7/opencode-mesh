import type { Bonjour } from "bonjour-service";

export const MESH_SERVICE_TYPE = "opencode-mesh";

export type AdvertiseHandle = {
  close(): void;
};

// Advertise this node on the LAN. TXT carries the node id, key fingerprint and
// the pairing public key (pk): never secrets.
export function advertiseMesh(options: {
  bonjour: Bonjour;
  port: number;
  node_id: string;
  fingerprint: string;
  public_key: string;
}): AdvertiseHandle {
  const service = options.bonjour.publish({
    name: options.node_id,
    type: MESH_SERVICE_TYPE,
    port: options.port,
    txt: { id: options.node_id, fp: options.fingerprint, pk: options.public_key },
  });

  return {
    close() {
      service.stop();
    },
  };
}

export type DiscoveredPeer = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses: string[];
  public_key?: string;
};

export function browseMesh(options: {
  bonjour: Bonjour;
  onDiscovered: (peer: DiscoveredPeer) => void;
}): { close(): void } {
  const browser = options.bonjour.find({ type: MESH_SERVICE_TYPE }, (service) => {
    const id = service.txt?.id;
    const fp = service.txt?.fp;
    if (typeof id !== "string" || typeof fp !== "string" || id.length === 0) {
      return;
    }
    options.onDiscovered({
      node_id: id,
      hostname: service.host ?? service.name,
      fingerprint: fp,
      addresses: socketAddresses(service.addresses, service.port),
      ...(typeof service.txt?.pk === "string" && service.txt.pk.length > 0
        ? { public_key: service.txt.pk }
        : {}),
    });
  });

  return {
    close() {
      browser.stop();
    },
  };
}

// An mDNS A/AAAA record is a bare IP: the peer's listening port comes from the
// SRV record in the same service. Guessing the port from the local node is
// wrong whenever the peer fell back to an ephemeral port, so a record without
// a port yields no address at all rather than a wrong one.
function socketAddresses(ips: string[] | undefined, port: number | undefined): string[] {
  if (port === undefined) {
    return [];
  }
  return (ips ?? []).map((ip) => (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`));
}

// Tailnet addresses let peers connect across subnets when tailscale runs.
// Absent CLI = empty list, never an error. The result is cached: mesh_status is
// a hot tool call and `tailscale status --json` is a subprocess we must not pay
// on every invocation.
const TAILNET_TTL_MS = 60_000;
const TAILNET_TIMEOUT_MS = 2000;

let tailnetCache: { addresses: string[]; expiresAt: number } | null = null;

export function resetTailnetCache(): void {
  tailnetCache = null;
}

export async function tailnetAddresses(): Promise<string[]> {
  if (tailnetCache !== null && tailnetCache.expiresAt > Date.now()) {
    return tailnetCache.addresses;
  }

  const { execFile } = await import("node:child_process");

  const addresses = await new Promise<string[]>((resolve) => {
    execFile(
      "tailscale",
      ["status", "--json"],
      { timeout: TAILNET_TIMEOUT_MS },
      (error: Error | null, stdout: string) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          const status = JSON.parse(stdout) as { Self?: { TailscaleIPs?: string[] } };
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

  tailnetCache = { addresses, expiresAt: Date.now() + TAILNET_TTL_MS };
  return addresses;
}
