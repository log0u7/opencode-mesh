export type Peer = {
  node_id: string;
  hostname: string;
  fingerprint: string;
  addresses: string[];
  paired: boolean;
  token: string | null;
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
