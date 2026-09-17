import type { Bonjour, Service } from "bonjour-service";

import { upsertDiscoveredPeer } from "./peers.js";
import type { MeshDb } from "./db.js";

export const MESH_SERVICE_TYPE = "opencode-mesh";

export type AdvertiseHandle = {
  close(): void;
};

// Advertise this node on the LAN. TXT carries only the node id and key
// fingerprint: never secrets.
export function advertiseMesh(options: {
  bonjour: Bonjour;
  port: number;
  node_id: string;
  fingerprint: string;
}): AdvertiseHandle {
  const service = options.bonjour.publish({
    name: options.node_id,
    type: MESH_SERVICE_TYPE,
    port: options.port,
    txt: { id: options.node_id, fp: options.fingerprint },
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
      addresses: service.addresses ?? [],
    });
  });

  return {
    close() {
      browser.stop();
    },
  };
}

// Feed a discovered peer into the local peer table (unpaired until mesh_pair).
export function rememberPeer(db: MeshDb, peer: DiscoveredPeer): void {
  upsertDiscoveredPeer(db, peer);
}

// Tailnet addresses let peers connect across subnets when tailscale runs.
// Absent CLI = empty list, never an error.
export async function tailnetAddresses(): Promise<string[]> {
  const { execFile } = await import("node:child_process");

  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], (error: Error | null, stdout: string) => {
      if (error) {
        resolve([]);
        return;
      }
      try {
        const status = JSON.parse(stdout) as { Self?: { TailscaleIPs?: string[] } };
        const ips = status.Self?.TailscaleIPs;
        resolve(Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === "string") : []);
      } catch {
        resolve([]);
      }
    });
  });
}

export type { Service } from "bonjour-service";
