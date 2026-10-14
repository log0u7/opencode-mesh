export type Peer = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses: string[];
  paired: boolean;
  token: string | null;
  /** Ed25519 SPKI (base64) pinned at pairing time; proof-of-possession key. */
  public_key: string | null;
  last_seen: number;
};

export type MailMessage = {
  id: string;
  from: string;
  subject: string;
  body: string;
  status: "unread" | "read";
  created_at: number;
};

export type Lock = {
  path: string;
  owner: string;
  node_id: string;
  expires_at: number;
};
