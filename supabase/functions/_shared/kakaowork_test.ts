import { assertEquals } from "jsr:@std/assert";
import { KakaoWorkChannel, ConsoleChannel, getChannel } from "./kakaowork.ts";

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
