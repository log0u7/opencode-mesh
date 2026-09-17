export type SendTarget = {
  url: string;
  token: string;
  from: string;
  subject: string;
  body: string;
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
      body: JSON.stringify({ from: target.from, subject: target.subject, body: target.body }),
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
