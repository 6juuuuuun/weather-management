import { assertEquals } from "jsr:@std/assert";
import { KakaoWorkChannel, ConsoleChannel, getChannel, isLocalUrl } from "./kakaowork.ts";

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return ((url: string) => {
    const key = Object.keys(routes).find(k => String(url).includes(k))!;
    return Promise.resolve(new Response(JSON.stringify(routes[key]), { status: 200 }));
  }) as typeof fetch;
}

Deno.test("KakaoWorkChannel: 방 열고 메시지 전송", async () => {
  const ch = new KakaoWorkChannel("key", mockFetch({
    "conversations.open": { success: true, conversation: { id: "c1" } },
    "messages.send": { success: true },
  }));
  assertEquals(await ch.send("kw1", "hello"), { ok: true });
});
Deno.test("KakaoWorkChannel: API 실패 시 ok=false + error", async () => {
  const ch = new KakaoWorkChannel("key", mockFetch({
    "conversations.open": { success: false, error: { message: "invalid user" } },
  }));
  const r = await ch.send("bad", "hello");
  assertEquals(r.ok, false);
});
Deno.test("getChannel: NOTIFY_CHANNEL=console이면 ConsoleChannel", () => {
  assertEquals(getChannel({ NOTIFY_CHANNEL: "console" }) instanceof ConsoleChannel, true);
});
Deno.test("KakaoWorkChannel: 네트워크 오류 시 throw 없이 ok=false", async () => {
  const ch = new KakaoWorkChannel("key", (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch);
  const r = await ch.send("kw1", "hello");
  assertEquals(r.ok, false);
});

Deno.test("isLocalUrl: 127.0.0.1/localhost/kong:8000은 로컬로 판정", () => {
  assertEquals(isLocalUrl("http://127.0.0.1:54321"), true);
  assertEquals(isLocalUrl("http://localhost:5173"), true);
  assertEquals(isLocalUrl("http://kong:8000"), true);
});
Deno.test("isLocalUrl: 프로덕션 도메인/undefined는 로컬 아님", () => {
  assertEquals(isLocalUrl("https://weather.example.com"), false);
  assertEquals(isLocalUrl("https://xyzcompany.supabase.co"), false);
  assertEquals(isLocalUrl(undefined), false);
});
