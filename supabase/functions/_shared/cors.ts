// 브라우저에서 직접 호출하는 Edge Function은 CORS를 스스로 처리해야 한다.
//
// 로컬 개발에서는 이게 없어도 동작해서 오래 눈에 띄지 않았다 — `supabase start`가 띄우는
// Kong 게이트웨이가 CORS 헤더를 대신 붙여주기 때문이다. 호스팅된 Edge Function 앞에는 그
// 게이트웨이가 없으므로, 프리플라이트(OPTIONS)가 400으로 떨어지고 브라우저가 본 요청을
// 아예 보내지 않는다(2026-08-13 운영 배포 후 실측).
//
// 주의: CORS는 브라우저만 지키는 규칙이라 인증 경계가 아니다(curl은 무시한다). 실제 권한
// 검사는 각 함수의 JWT·역할 확인이 담당하고, 여기서는 허용 오리진을 좁혀 두는 정도의
// 심층 방어만 한다.

const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

/** 요청 오리진이 허용 목록에 있으면 그 값을, 아니면 null을 돌려준다. */
export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const appBase = Deno.env.get("APP_BASE_URL")?.replace(/\/$/, "");
  if (appBase && origin === appBase) return origin;
  if (DEV_ORIGINS.includes(origin)) return origin;
  return null;
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = allowedOrigin(req.headers.get("Origin"));
  if (!origin) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * 핸들러를 감싸 프리플라이트를 처리하고 모든 응답에 CORS 헤더를 덧붙인다.
 * 응답 지점이 여러 곳인 함수에서 지점마다 헤더를 붙이다 빠뜨리는 일을 막는다.
 */
export function withCors(
  handler: (req: Request) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const headers = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const res = await handler(req);
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
  };
}
