// supabase/functions/_shared/kakaowork_test.ts 이관.
import { describe, expect, it } from "vitest";
import { KakaoWorkChannel, ConsoleChannel, getChannel, isLocalUrl } from "../../src/shared/kakaowork.ts";

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return ((url: string) => {
    const key = Object.keys(routes).find(k => String(url).includes(k))!;
    return Promise.resolve(new Response(JSON.stringify(routes[key]), { status: 200 }));
  }) as unknown as typeof fetch;
}

describe("카카오워크 채널", () => {
  it("KakaoWorkChannel: 방 열고 메시지 전송", async () => {
    const ch = new KakaoWorkChannel("key", mockFetch({
      "conversations.open": { success: true, conversation: { id: "c1" } },
      "messages.send": { success: true },
    }));
    expect(await ch.send("kw1", "hello")).toEqual({ ok: true });
  });
  it("KakaoWorkChannel: API 실패 시 ok=false + error", async () => {
    const ch = new KakaoWorkChannel("key", mockFetch({
      "conversations.open": { success: false, error: { message: "invalid user" } },
    }));
    const r = await ch.send("bad", "hello");
    expect(r.ok).toBe(false);
  });
  it("getChannel: NOTIFY_CHANNEL=console이면 ConsoleChannel", () => {
    expect(getChannel({ NOTIFY_CHANNEL: "console" }) instanceof ConsoleChannel).toBe(true);
  });
  it("KakaoWorkChannel: 네트워크 오류 시 throw 없이 ok=false", async () => {
    const ch = new KakaoWorkChannel("key", (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch);
    const r = await ch.send("kw1", "hello");
    expect(r.ok).toBe(false);
  });

  it("isLocalUrl: 127.0.0.1/localhost/kong:8000은 로컬로 판정", () => {
    expect(isLocalUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLocalUrl("http://localhost:5173")).toBe(true);
    expect(isLocalUrl("http://kong:8000")).toBe(true);
  });
  it("isLocalUrl: 프로덕션 도메인/undefined는 로컬 아님", () => {
    expect(isLocalUrl("https://weather.example.com")).toBe(false);
    expect(isLocalUrl("https://xyzcompany.supabase.co")).toBe(false);
    expect(isLocalUrl(undefined)).toBe(false);
  });
});
