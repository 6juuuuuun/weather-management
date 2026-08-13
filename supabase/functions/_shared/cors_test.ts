import { assertEquals } from "jsr:@std/assert@1";
import { allowedOrigin, corsHeaders, withCors } from "./cors.ts";

const APP = "https://weather.gonjiam.workers.dev";

function withAppBase<T>(fn: () => T): T {
  const prev = Deno.env.get("APP_BASE_URL");
  Deno.env.set("APP_BASE_URL", APP);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("APP_BASE_URL");
    else Deno.env.set("APP_BASE_URL", prev);
  }
}

const req = (origin: string | null, method = "POST") =>
  new Request("https://x/functions/v1/send", {
    method,
    headers: origin ? { Origin: origin } : {},
  });

Deno.test("APP_BASE_URL 오리진을 허용한다", () => {
  withAppBase(() => assertEquals(allowedOrigin(APP), APP));
});

Deno.test("APP_BASE_URL 끝의 슬래시는 무시한다", () => {
  const prev = Deno.env.get("APP_BASE_URL");
  Deno.env.set("APP_BASE_URL", `${APP}/`);
  try {
    assertEquals(allowedOrigin(APP), APP);
  } finally {
    if (prev === undefined) Deno.env.delete("APP_BASE_URL");
    else Deno.env.set("APP_BASE_URL", prev);
  }
});

Deno.test("로컬 개발 오리진을 허용한다", () => {
  withAppBase(() => assertEquals(allowedOrigin("http://localhost:5173"), "http://localhost:5173"));
});

Deno.test("허용 목록에 없는 오리진은 거부한다", () => {
  withAppBase(() => {
    assertEquals(allowedOrigin("https://evil.example.com"), null);
    assertEquals(allowedOrigin(null), null);
  });
});

Deno.test("허용 오리진에는 CORS 헤더를 붙인다", () => {
  withAppBase(() => {
    const h = corsHeaders(req(APP));
    assertEquals(h["Access-Control-Allow-Origin"], APP);
    assertEquals(h["Access-Control-Allow-Headers"].includes("authorization"), true);
    assertEquals(h["Access-Control-Allow-Headers"].includes("apikey"), true);
    assertEquals(h["Vary"], "Origin");
  });
});

Deno.test("비허용 오리진에는 Allow-Origin을 붙이지 않는다", () => {
  withAppBase(() => {
    const h = corsHeaders(req("https://evil.example.com"));
    assertEquals(h["Access-Control-Allow-Origin"], undefined);
  });
});

// 회귀: 프리플라이트가 핸들러까지 내려가 400으로 떨어지면 브라우저가 본 요청을 보내지 않는다
// (2026-08-13 운영에서 실제 발생 — 로그인·발송이 전부 막혔다).
Deno.test("OPTIONS 프리플라이트는 핸들러를 타지 않고 204로 응답한다", async () => {
  await withAppBase(async () => {
    let handlerCalled = false;
    const handler = withCors(() => {
      handlerCalled = true;
      return new Response("bad request", { status: 400 });
    });
    const res = await handler(req(APP, "OPTIONS"));
    assertEquals(res.status, 204);
    assertEquals(handlerCalled, false);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), APP);
    await res.body?.cancel();
  });
});

Deno.test("핸들러 응답의 본문·상태를 보존하며 CORS 헤더를 덧붙인다", async () => {
  await withAppBase(async () => {
    const handler = withCors(() => Response.json({ ok: false, error: "409다" }, { status: 409 }));
    const res = await handler(req(APP));
    assertEquals(res.status, 409);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), APP);
    assertEquals(await res.json(), { ok: false, error: "409다" });
  });
});
