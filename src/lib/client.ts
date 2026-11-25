import { request as httpsRequest } from "node:https";
import { X509Certificate } from "node:crypto";
import { type PeerCertificate, TLSSocket } from "node:tls";

export type SendTarget = {
  url: string;
  token: string;
  from: string;
  subject: string;
  body: string;
  /** Target mailbox on the peer, when the mail is addressed to a box. */
  to?: string;
  /** The sending node's own mailbox name, when it has one. */
  from_box?: string;
  /** Message id this mail replies to. */
  reply_to?: string;
  /** Anti-loop trail: node ids already traversed by the fanout. */
  via?: string[];
  /** Origin message id (cross-host broadcast dedup). */
  origin_id?: string;
  /** Deliberate broadcast: wake every recipient on the peer (Slack model,
   * 0.17.0). Direct mail always wakes; the flag only matters for
   * pool/all broadcasts. */
  wake?: boolean;
  /** `<base64 spki>.<base64 ed25519 signature>` over node_id:token. */
  proof?: string;
  /** Target serves TLS (implied by an https:// url too). */
  tls?: boolean;
  /** Expected peer certificate SPKI (base64). Present = the connection is
   * pinned; absent = TOFU (first contact, e.g. code pairing). */
  pk?: string;
};

export type SendResult =
  | "ok"
  | "unreachable"
  | "unauthorized"
  | "error"
  /** TLS refused the peer: the pinned SPKI no longer matches what the peer presents
   * (its identity rotated or was re-paired). Reporting it as plain "unreachable"
   * hides the remedy — the peer is up, the pin is stale. */
  | "pin-mismatch"
  /** The peer's port answered in PLAINTEXT (HTTP) where TLS was expected: a 0.10.x
   * peer not yet upgraded to the TLS-only 0.11 transport. The remedy is an upgrade,
   * not a re-pair. */
  | "plaintext-peer";

// TLS is implied by the scheme; the flag covers callers that state it twice.
function isTls(target: { url: string; tls?: boolean }): boolean {
  return target.tls === true || target.url.startsWith("https:");
}

// Deliver a message to a peer's /mail endpoint. Never throws: the model reads
// the result string and reacts.
export async function sendMail(target: SendTarget): Promise<SendResult> {
  const payload = JSON.stringify({
    from: target.from,
    subject: target.subject,
    body: target.body,
    ...(target.to !== undefined ? { to: target.to } : {}),
    ...(target.from_box !== undefined ? { from_box: target.from_box } : {}),
    ...(target.reply_to !== undefined ? { reply_to: target.reply_to } : {}),
    ...(target.via !== undefined ? { via: target.via } : {}),
    ...(target.origin_id !== undefined ? { origin_id: target.origin_id } : {}),
    ...(target.wake === true ? { wake: true } : {}),
    ...(target.proof !== undefined ? { proof: target.proof } : {}),
  });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${target.token}`,
  };
  try {
    const response = isTls(target)
      ? await tlsRequest({
          url: `${target.url}/mail`,
          ...(target.pk !== undefined ? { pk: target.pk } : {}),
          method: "POST",
          headers,
          body: payload,
          timeoutMs: 5000,
        })
      : await plainRequest(`${target.url}/mail`, {
          method: "POST",
          headers,
          body: payload,
          timeoutMs: 5000,
        });
    if (response.status === 200) {
      return "ok";
    }
    return response.status === 401 ? "unauthorized" : "error";
  } catch (cause) {
    // pinCheck rejects the handshake with a precise message; collapsing it into
    // "unreachable" made a rotated peer identity look like a dead host. A plaintext
    // listener (0.10.x peer) fails TLS with "wrong version number": the host is up,
    // it just predates the TLS-only transport.
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("peer certificate key mismatch")) {
      return "pin-mismatch";
    }
    if (message.includes("wrong version number")) {
      return "plaintext-peer";
    }
    // An oversized (bounded) response is a protocol-level garbage answer from
    // a reachable host: "error", not "unreachable".
    if (message.includes("response body exceeds")) {
      return "error";
    }
    return "unreachable";
  }
}

// Push the local shareable-memory outbox to a peer's /memory-sync endpoint. The
// body is opaque bytes (JSONL written by the opencode-memory plugin): the mesh
// transports it, it never parses it. Sender identity and pairing proof travel in
// headers (the payload must stay opaque), mirroring the mail fields they correspond
// to: the first accepted push binds the pairing token on the peer, as the first
// mail does. The sender header deliberately reads x-mesh-sender rather than the
// mail field name: the static import audit scans dist for the keyword-from + quote
// pattern, and a header ending in that word would forge a match.
export async function pushMemorySync(target: {
  url: string;
  token: string;
  from: string;
  proof?: string;
  tls?: boolean;
  pk?: string;
  body: string;
}): Promise<SendResult> {
  const headers = {
    "content-type": "application/x-ndjson",
    authorization: `Bearer ${target.token}`,
    "x-mesh-sender": target.from,
    ...(target.proof !== undefined ? { "x-mesh-proof": target.proof } : {}),
  };
  try {
    const response = isTls(target)
      ? await tlsRequest({
          url: `${target.url}/memory-sync`,
          ...(target.pk !== undefined ? { pk: target.pk } : {}),
          method: "POST",
          headers,
          body: target.body,
          timeoutMs: 10_000,
        })
      : await plainRequest(`${target.url}/memory-sync`, {
          method: "POST",
          headers,
          body: target.body,
          timeoutMs: 10_000,
        });
    if (response.status === 200) {
      return "ok";
    }
    return response.status === 401 ? "unauthorized" : "error";
  } catch (cause) {
    // pinCheck rejects the handshake with a precise message; collapsing it into
    // "unreachable" made a rotated peer identity look like a dead host. A plaintext
    // listener (0.10.x peer) fails TLS with "wrong version number": the host is up,
    // it just predates the TLS-only transport.
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("peer certificate key mismatch")) {
      return "pin-mismatch";
    }
    if (message.includes("wrong version number")) {
      return "plaintext-peer";
    }
    // An oversized (bounded) response is a protocol-level garbage answer from
    // a reachable host: "error", not "unreachable".
    if (message.includes("response body exceeds")) {
      return "error";
    }
    return "unreachable";
  }
}

// Fetch a peer's local pool map. Never throws: null = unreachable or error.
export async function getPools(target: {
  url: string;
  token: string;
  tls?: boolean;
  pk?: string;
}): Promise<{ pools: Record<string, string[]> } | null> {
  const headers = { authorization: `Bearer ${target.token}` };
  try {
    const response = isTls(target)
      ? await tlsRequest({
          url: `${target.url}/pools`,
          ...(target.pk !== undefined ? { pk: target.pk } : {}),
          method: "GET",
          headers,
          timeoutMs: 2000,
        })
      : await plainRequest(`${target.url}/pools`, { method: "GET", headers, timeoutMs: 2000 });
    if (response.status !== 200) return null;
    const body = JSON.parse(response.body) as { pools?: Record<string, string[]> };
    return typeof body.pools === "object" && body.pools !== null ? { pools: body.pools } : null;
  } catch {
    return null;
  }
}

// Pairing bootstrap: present a 6-digit code + our own offer blob to a peer's
// /pair-code endpoint. Unauthenticated by design — the code IS the capability.
// Over TLS this is the TOFU moment: the peer's self-signed cert is accepted
// WITHOUT a pin (first contact) and its SPKI is returned as `peer_pk`; the
// caller pins it (it must equal the counter-offer's pk, i.e. the node key).
// Returns the peer's counter-offer blob, or null (bad code, unreachable).
export async function postPairCode(target: {
  url: string;
  code: string;
  offer: string;
  tls?: boolean;
}): Promise<{ counter_offer: string; peer_pk?: string } | null> {
  try {
    const response = isTls(target)
      ? await tlsRequest({
          url: `${target.url}/pair-code`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: target.code, offer: target.offer }),
          timeoutMs: 5000,
        })
      : await plainRequest(`${target.url}/pair-code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: target.code, offer: target.offer }),
          timeoutMs: 5000,
        });
    if (response.status !== 200) return null;
    const body = JSON.parse(response.body) as { counter_offer?: string };
    if (typeof body.counter_offer !== "string") return null;
    return {
      counter_offer: body.counter_offer,
      ...(response.peerPk !== null ? { peer_pk: response.peerPk } : {}),
    };
  } catch {
    return null;
  }
}

// Push a signed distant-spawn request to a peer's /spawn endpoint. The body is
// fully built and signed by the caller (lib/distant-spawn.ts): this function is
// transport only — TLS with SPKI pinning, the pairing bearer token, and a
// parsed verdict. 403 carries the peer's explicit refusal message
// ("spawn refused: …"), which the tool surfaces verbatim.
export type SpawnPostResult =
  | { kind: "ok"; worker_id: string; hostname?: string; name?: string }
  | { kind: "refused"; status: number; error: string }
  | { kind: "unreachable"; error: string };

export async function postSpawn(target: {
  url: string;
  token: string;
  /** The pre-serialized SpawnRequestBody (JSON, already signed). */
  body: string;
  tls?: boolean;
  pk?: string;
}): Promise<SpawnPostResult> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${target.token}`,
  };
  let response: WireResponse;
  try {
    response = isTls(target)
      ? await tlsRequest({
          url: `${target.url}/spawn`,
          ...(target.pk !== undefined ? { pk: target.pk } : {}),
          method: "POST",
          headers,
          body: target.body,
          timeoutMs: 10_000,
        })
      : await plainRequest(`${target.url}/spawn`, {
          method: "POST",
          headers,
          body: target.body,
          timeoutMs: 10_000,
        });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("peer certificate key mismatch")) {
      return { kind: "unreachable", error: "pin-mismatch" };
    }
    if (message.includes("wrong version number")) {
      return { kind: "unreachable", error: "plaintext-peer" };
    }
    return { kind: "unreachable", error: "peer unreachable" };
  }
  if (response.status === 200) {
    try {
      const parsed = JSON.parse(response.body) as {
        ok?: unknown;
        worker_id?: unknown;
        hostname?: unknown;
        name?: unknown;
      };
      if (typeof parsed.worker_id !== "string") {
        return { kind: "refused", status: response.status, error: "peer sent no worker id" };
      }
      return {
        kind: "ok",
        worker_id: parsed.worker_id,
        ...(typeof parsed.hostname === "string" ? { hostname: parsed.hostname } : {}),
        ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      };
    } catch {
      return { kind: "refused", status: response.status, error: "unparseable peer response" };
    }
  }
  let error = `spawn failed: ${response.status}`;
  try {
    const parsed = JSON.parse(response.body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      error = parsed.error;
    }
  } catch {
    // Keep the fallback: an unreadable body leaves at least the status code
    // instead of a bare message (the 0.24.5 lesson).
  }
  return { kind: "refused", status: response.status, error };
}

type WireResponse = { status: number; body: string; peerPk: string | null };

// Response bodies are bounded (0.18.0): a compromised or hostile peer must
// not balloon the host's memory through a trusted-but-unbounded read. 2 MiB
// covers any real mesh payload (mail JSON, /pools, pairing blobs, memory-sync
// acks); the memory-sync REQUEST limit is 1 MiB on the receiving side.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function plainRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
): Promise<WireResponse> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  // Read with a cap: over the limit the stream is cancelled and the read
  // fails (the caller maps any failure to a plain error result).
  const reader = response.body?.getReader();
  if (!reader) {
    return { status: response.status, body: "", peerPk: null };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return { status: response.status, body: Buffer.concat(chunks).toString("utf8"), peerPk: null };
}

// ---- TLS transport ----

type TlsRequest = {
  url: string;
  /** SPKI (base64) the peer certificate must present; absent = accept (TOFU). */
  pk?: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

// One https request with SPKI pinning. The mesh cert is self-signed by the
// peer's Ed25519 identity key: public-CA chain validation can never pass, so
// rejectUnauthorized is off and trust comes ENTIRELY from the pin. The pin is
// enforced twice: checkServerIdentity (fires when the chain is valid) and a
// secureConnect guard (fires in every case, including self-signed, where the
// default identity check would be skipped). Either path rejects BEFORE the
// response body is read.
async function tlsRequest(req: TlsRequest): Promise<WireResponse> {
  const url = new URL(req.url);
  const check = pinCheck(req.pk);
  // Captured at handshake: the peer cert is guaranteed available right after
  // `secureConnect`, but may already be detached by the time the body ends.
  let peerPk: string | null = null;
  return new Promise<WireResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        ...(url.port !== "" ? { port: Number(url.port) } : {}),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: req.headers,
        rejectUnauthorized: false,
        checkServerIdentity: (_host: string, cert: PeerCertificate) => check(cert) ?? undefined,
        signal: AbortSignal.timeout(req.timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            peerPk,
          });
        });
        response.on("error", reject);
      },
    );
    request.on("socket", (socket) => {
      if (socket instanceof TLSSocket) {
        socket.once("secureConnect", () => {
          peerPk = certSpki(socket.getPeerCertificate());
          const error = check(socket.getPeerCertificate());
          if (error !== null) {
            request.destroy(error);
          }
        });
      }
    });
    request.on("error", reject);
    if (req.body !== undefined) {
      request.write(req.body);
    }
    request.end();
  });
}

// The SPKI (base64 DER) of the peer's leaf certificate; null when none. The
// DER is re-parsed from `cert.raw`: the compact certificate view does not
// always carry the parsed key, but `raw` is always present after handshake.
function certSpki(cert: PeerCertificate | Record<string, never>): string | null {
  if (cert === null || cert.raw === undefined) {
    return null;
  }
  return new X509Certificate(cert.raw).publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

// SPKI pin: no pin (undefined) = TOFU, accept; a pin must match the presented
// certificate exactly. Returns the rejection error, or null when accepted.
function pinCheck(pk: string | undefined): (cert: PeerCertificate) => Error | null {
  if (pk === undefined) {
    return () => null;
  }
  return (cert) => {
    const spki = certSpki(cert);
    if (spki === null) {
      return new Error("peer presented no certificate");
    }
    if (spki !== pk) {
      return new Error(
        `peer certificate key mismatch: pinned ${pk.slice(0, 16)}…, presented ${spki.slice(0, 16)}…`,
      );
    }
    return null;
  };
}

/** The registry federation push (0.30.0): POST the sender's LOCAL mailbox
 * rows to a paired peer's /registry-sync endpoint (the same TLS + token +
 * proof machinery as /mail). Returns "ok" or the transport failure string —
 * the caller treats a failure as non-fatal (the next rebind retries). */
export async function postRegistrySync(target: {
  url: string;
  token: string;
  from: string;
  proof: string;
  tls?: boolean;
  pk?: string;
  registry: Array<{
    name: string;
    session_id: string;
    role: string | null;
    pools: string;
    primary_pool: string | null;
    registered_at: number;
  }>;
}): Promise<SendResult> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${target.token}`,
    "x-mesh-sender": target.from,
    "x-mesh-proof": target.proof,
  };
  const body = JSON.stringify({ from: target.from, registry: target.registry });
  try {
    const response = isTls(target)
      ? await tlsRequest({
          url: `${target.url}/registry-sync`,
          ...(target.pk !== undefined ? { pk: target.pk } : {}),
          method: "POST",
          headers,
          body,
          timeoutMs: 5000,
        })
      : await plainRequest(`${target.url}/registry-sync`, {
          method: "POST",
          headers,
          body,
          timeoutMs: 5000,
        });
    if (response.status === 200) {
      return "ok";
    }
    return response.status === 401 ? "unauthorized" : "error";
  } catch {
    return "unreachable";
  }
}
