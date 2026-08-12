import type { NotificationChannel } from "./channel.ts";
export type { NotificationChannel };

const API = "https://api.kakaowork.com/v1";

export class KakaoWorkChannel implements NotificationChannel {
  constructor(private botKey: string, private fetchFn: typeof fetch = fetch) {}
  private async call(path: string, body: unknown): Promise<any> {
    const res = await this.fetchFn(`${API}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.botKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }
  async send(userId: string, text: string) {
    const open = await this.call("conversations.open", { user_id: userId });
    if (!open.success) return { ok: false, error: open.error?.message ?? "conversations.open failed" };
    const sent = await this.call("messages.send", { conversation_id: open.conversation.id, text });
    return sent.success ? { ok: true } : { ok: false, error: sent.error?.message ?? "messages.send failed" };
  }
}

export class ConsoleChannel implements NotificationChannel {
  async send(userId: string, text: string) {
    console.log(`[console-channel] to=${userId}\n${text}`);
    return { ok: true };
  }
}

export function getChannel(env: { NOTIFY_CHANNEL?: string; KAKAOWORK_BOT_KEY?: string }): NotificationChannel {
  if (env.NOTIFY_CHANNEL === "console" || !env.KAKAOWORK_BOT_KEY) return new ConsoleChannel();
  return new KakaoWorkChannel(env.KAKAOWORK_BOT_KEY);
}

export async function resolveKakaoworkUserIdByEmail(
  botKey: string, email: string, fetchFn: typeof fetch = fetch,
): Promise<string|null> {
  const res = await fetchFn(`${API}/users.find_by_email?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${botKey}` },
  });
  const json = await res.json();
  return json.success ? String(json.user.id) : null;
}
