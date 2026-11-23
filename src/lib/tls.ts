// TLS material derived from the node identity: the Ed25519 key that already
// signs pairing proofs also mints the node's self-signed X.509 certificate, so
// TLS adds zero new trust. No hand-rolled crypto — node:crypto signs the DER;
// this file only encodes RFC 5280 structures (a ~9-field TBSCertificate).

import { createPrivateKey, randomBytes, sign, X509Certificate } from "node:crypto";

import { loadOrCreateIdentity } from "./identity.js";

export type TlsMaterial = { keyPem: string; certPem: string };

// DER tags used by the certificate.
const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const UTF8_STRING = 0x0c;
const BOOLEAN = 0x01;
const UTC_TIME = 0x17;
const EXPLICIT_VERSION = 0xa0; // [0] EXPLICIT
const EXPLICIT_EXTENSIONS = 0xa3; // [3] EXPLICIT

// Object identifiers.
const OID_ED25519 = "1.3.101.112"; // id-Ed25519 (RFC 8410)
const OID_COMMON_NAME = "2.5.4.3"; // id-at-commonName
const OID_BASIC_CONSTRAINTS = "2.5.29.19"; // id-ce-basicConstraints

const CERT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** DER TLV: one tag, one length, one content. */
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(SEQUENCE, Buffer.concat(parts));
}

function setOf(...parts: Buffer[]): Buffer {
  return tlv(SET, Buffer.concat(parts));
}

function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const first = arcs[0] ?? 0;
  const second = arcs[1] ?? 0;
  const bytes: number[] = [first * 40 + second];
  for (const arc of arcs.slice(2)) {
    const groups: number[] = [arc & 0x7f];
    let rest = arc >> 7;
    while (rest > 0) {
      groups.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    bytes.push(...groups);
  }
  return tlv(OID, Buffer.from(bytes));
}

function integer(content: Buffer): Buffer {
  return tlv(INTEGER, content);
}

function utcTime(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const value =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(UTC_TIME, Buffer.from(value, "ascii"));
}

// Name ::= SEQUENCE { SET { SEQUENCE { OID, UTF8String } } } — one RDN, CN.
function name(commonName: string): Buffer {
  const cn = sequence(oid(OID_COMMON_NAME), tlv(UTF8_STRING, Buffer.from(commonName, "utf8")));
  return sequence(setOf(cn));
}

// X.509 base64-PEM wrapper (64 chars per line, RFC 7468).
function pem(label: string, der: Buffer): string {
  const body = (der.toString("base64").match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Build the identity's self-signed certificate material. Pure function of the
 * identity (serial + validity excepted): same key, same certificate content. */
export function buildTlsMaterial(identity: {
  hostname: string;
  public_key: string;
  private_key: string;
}): TlsMaterial {
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.private_key, "base64"),
    format: "der",
    type: "pkcs8",
  });
  // The SPKI is already the pinned pairing key (base64 SPKI DER) — pass through.
  const spki = Buffer.from(identity.public_key, "base64");

  const now = new Date();
  // Serial: 16 random bytes, forced positive and minimal (first byte 1..0x7f).
  const serial = randomBytes(16);
  // Forced positive and minimal: first byte 1..0x7f.
  const firstByte = serial[0] ?? 0x01;
  serial[0] = firstByte & 0x7f;
  if (serial[0] === 0) {
    serial[0] = 0x01;
  }

  const signatureAlgorithm = sequence(oid(OID_ED25519));
  const validity = sequence(utcTime(now), utcTime(new Date(now.getTime() + CERT_LIFETIME_MS)));
  // basicConstraints: critical, CA:TRUE — the node cert is its own trust anchor.
  const basicConstraints = sequence(
    oid(OID_BASIC_CONSTRAINTS),
    tlv(BOOLEAN, Buffer.from([0xff])),
    tlv(OCTET_STRING, sequence(tlv(BOOLEAN, Buffer.from([0xff])))),
  );

  const tbs = sequence(
    tlv(EXPLICIT_VERSION, integer(Buffer.from([0x02]))), // v3
    integer(serial),
    signatureAlgorithm,
    name(identity.hostname), // issuer = subject (self-signed)
    validity,
    name(identity.hostname),
    spki,
    tlv(EXPLICIT_EXTENSIONS, sequence(basicConstraints)),
  );

  const signature = sign(null, tbs, privateKey);
  const certificate = sequence(
    tbs,
    signatureAlgorithm,
    tlv(BIT_STRING, Buffer.concat([Buffer.from([0x00]), signature])), // no unused bits
  );

  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certPem: pem("CERTIFICATE", certificate),
  };
}

// One material per data dir per process: boot-time cost only.
const MATERIAL_CACHE = new Map<string, TlsMaterial>();

/** The node's TLS material, derived from (and cached with) its identity file. */
export function nodeTlsMaterial(dataDir: string): TlsMaterial {
  const cached = MATERIAL_CACHE.get(dataDir);
  if (cached !== undefined) {
    return cached;
  }
  const material = buildTlsMaterial(loadOrCreateIdentity(dataDir));
  MATERIAL_CACHE.set(dataDir, material);
  return material;
}

/** The certificate's SubjectPublicKeyInfo (base64 DER) — what clients pin. */
export function certPkSpki(certPem: string): string {
  return new X509Certificate(certPem).publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
}
