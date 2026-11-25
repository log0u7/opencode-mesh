import type { Bonjour } from "bonjour-service";

export const MESH_SERVICE_TYPE = "opencode-mesh";

export type AdvertiseHandle = {
  close(): void;
};

// Advertise this node on the LAN. TXT carries the node id, key fingerprint and
// the pairing public key (pk): never secrets. `tls: "1"` marks the 0.11+
// TLS-only mesh port.
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
    txt: { id: options.node_id, fp: options.fingerprint, pk: options.public_key, tls: "1" },
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
  /** The advertised mesh port speaks TLS (0.11+). */
  tls?: boolean;
};

export function browseMesh(options: {
  bonjour: Bonjour;
  onDiscovered: (peer: DiscoveredPeer) => void;
}): { close(): void; refresh(): void } {
  // A browser caches the services it has seen: `up` fires once per fqdn, and
  // an IP-only change (DHCP churn) fires no event at all (srv-update only
  // watches host/port), so a paired peer's new address never reaches
  // onDiscovered again. `refresh()` swaps in a fresh browser whose cache is
  // empty: the peer's next mDNS response fires `up` and the discovered row is
  // upserted with the current addresses.
  let browser: { stop(): void } | null = null;
  const start = () => {
    browser = options.bonjour.find({ type: MESH_SERVICE_TYPE }, (service) => {
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
        ...(service.txt?.tls === "1" ? { tls: true } : {}),
      });
    });
  };
  start();

  return {
    close() {
      browser?.stop();
    },
    refresh() {
      browser?.stop();
      start();
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

// Tailnet addresses moved to the modular provider mold in lib/providers.js
// (0.15.0): same semantics (60s cache, 2s timeout, absent CLI = empty list,
// never an error), same exported names for the existing call sites and tests.
export { tailnetAddresses, resetTailnetCache } from "./providers.js";
