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
    try {
      const open = await this.call("conversations.open", { user_id: userId });
      if (!open?.success || !open?.conversation?.id) {
        return { ok: false, error: open?.error?.message ?? "conversations.open failed" };
      }
      const sent = await this.call("messages.send", { conversation_id: open.conversation.id, text });
      return sent?.success ? { ok: true } : { ok: false, error: sent?.error?.message ?? "messages.send failed" };
    } catch (e) {
      return { ok: false, error: `network/parse error: ${String(e)}` };
    }
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

// `kong:8000`은 supabase CLI 로컬 스택이 컨테이너 안에 주입하는 SUPABASE_URL 값이다 — CLI가
// SUPABASE_* env를 --env-file에서 걸러내므로 로컬에서도 127.0.0.1이 아니다. 이 호스트명을 재사용하는
// 셀프호스팅 배포를 위해 호출부에서 APP_BASE_URL까지 로컬일 것을 함께 요구한다.
export function isLocalUrl(u?: string): boolean {
  return !!u && (u.includes("127.0.0.1") || u.includes("localhost") || u.includes("kong:8000"));
}
