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
  /** `<base64 spki>.<base64 ed25519 signature>` over node_id:token. */
  proof?: string;
};

export type SendResult = "ok" | "unreachable" | "unauthorized" | "error";

// Deliver a message to a peer's /mail endpoint. Never throws: the model reads
// the result string and reacts.
export async function sendMail(target: SendTarget): Promise<SendResult> {
  try {
    const response = await fetch(`${target.url}/mail`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({
        from: target.from,
        subject: target.subject,
        body: target.body,
        ...(target.to !== undefined ? { to: target.to } : {}),
        ...(target.from_box !== undefined ? { from_box: target.from_box } : {}),
        ...(target.reply_to !== undefined ? { reply_to: target.reply_to } : {}),
        ...(target.via !== undefined ? { via: target.via } : {}),
        ...(target.origin_id !== undefined ? { origin_id: target.origin_id } : {}),
        ...(target.proof !== undefined ? { proof: target.proof } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return "ok";
    }
    if (response.status === 401) {
      return "unauthorized";
    }
    return "error";
  } catch {
    return "unreachable";
  }
}

// Fetch a peer's local pool map. Never throws: null = unreachable or error.
export async function getPools(target: {
  url: string;
  token: string;
}): Promise<{ pools: Record<string, string[]> } | null> {
  try {
    const response = await fetch(`${target.url}/pools`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { pools?: Record<string, string[]> };
    return typeof body.pools === "object" && body.pools !== null ? { pools: body.pools } : null;
  } catch {
    return null;
  }
}
