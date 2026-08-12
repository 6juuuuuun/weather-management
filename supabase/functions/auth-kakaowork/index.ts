import { serviceClient } from "../_shared/db.ts";

const env = (k: string) => Deno.env.get(k);
const AUTH_URL = "https://auth.kakaowork.com/oauth2/authorize";
const TOKEN_URL = "https://auth.kakaowork.com/oauth2/token";
const STATE_COOKIE = "kw_oauth_state";

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");
  const selfUrl = `${env("SUPABASE_URL")}/functions/v1/auth-kakaowork?action=callback`;

  if (action === "login") {
    // 로그인 CSRF 방지: state를 HttpOnly 쿠키로 심어두고 callback에서 쿼리 state와 대조한다.
    const state = crypto.randomUUID();
    const q = new URLSearchParams({ client_id: env("KAKAOWORK_CLIENT_ID")!,
      redirect_uri: selfUrl, response_type: "code", state });
    return new Response(null, { status: 302, headers: {
      Location: `${AUTH_URL}?${q}`,
      "Set-Cookie": `${STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`,
    } });
  }

  if (action === "callback") {
    const code = u.searchParams.get("code");
    if (!code) return new Response("missing code", { status: 400 });

    let profile: { email: string; user_id: string; name?: string };
    const mock = env("MOCK_KAKAO_PROFILE");
    if (mock) {
      // 테스트 전용: MOCK_KAKAO_PROFILE env가 설정된 경우에만 쿼리 파라미터로 mock 프로필의 email을
      // 오버라이드할 수 있게 한다(env 없는 프로덕션에서는 이 분기 자체에 도달하지 않으므로 완전 무시됨).
      // user_id도 email에 종속해 함께 바꿔 kakaowork_user_id unique 제약과 충돌하지 않게 한다.
      // state 검증도 이 경로에서는 생략한다(테스트 편의 — env 게이트 뒤라 안전).
      profile = JSON.parse(mock);
      const mockEmail = u.searchParams.get("mock_email");
      if (mockEmail) {
        profile = { ...profile, email: mockEmail, user_id: `kw-${mockEmail}` };
      }
    } else {
      // 실 OAuth 경로에서만 state를 검증한다: login에서 심어둔 쿠키와 쿼리 state가 일치해야 진행.
      const stateParam = u.searchParams.get("state");
      const cookieState = cookieValue(req, STATE_COOKIE);
      if (!stateParam || !cookieState || stateParam !== cookieState) {
        return new Response("invalid oauth state", { status: 403 });
      }
      const tokenRes = await fetch(TOKEN_URL, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code,
          client_id: env("KAKAOWORK_CLIENT_ID")!, client_secret: env("KAKAOWORK_CLIENT_SECRET")!,
          redirect_uri: selfUrl }) });
      const { access_token } = await tokenRes.json();
      const me = await (await fetch("https://api.kakaowork.com/v1/users.me",
        { headers: { Authorization: `Bearer ${access_token}` } })).json();
      profile = { email: me.user.email, user_id: String(me.user.id), name: me.user.display_name };
    }

    const db = serviceClient();
    const { data: existing } = await db.from("employees").select("*").eq("email", profile.email).maybeSingle();
    // ADMIN_KAKAOWORK_ID와 일치하면 기존 사용자 여부와 무관하게 항상 admin을 보장한다(강등은 하지 않음 —
    // 일치하지 않는 기존 사용자는 기존 role 유지). env 설정 전/오타 상태로 먼저 가입해 staff로 굳어진 뒤
    // env를 바로잡아도 영원히 staff로 남아 admin이 0명인 교착을 방지하기 위한 스펙 오너 판정.
    const role = profile.email === env("ADMIN_KAKAOWORK_ID") ? "admin" : (existing?.role ?? "staff");
    let authUserId = existing?.auth_user_id;
    if (!authUserId) {
      const { data: created } = await db.auth.admin.createUser({
        email: profile.email, email_confirm: true });
      authUserId = created.user!.id;
    }
    await db.from("employees").upsert({
      email: profile.email, auth_user_id: authUserId,
      name: existing?.name ?? profile.name ?? profile.email,
      kakaowork_user_id: profile.user_id,
      role,
      department_id: existing?.department_id ?? null,
    }, { onConflict: "email" });

    const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: profile.email });
    const tokenHash = link.properties.hashed_token;
    return Response.redirect(`${env("APP_BASE_URL")}/auth/callback#token_hash=${tokenHash}`, 302);
  }

  return new Response("bad request", { status: 400 });
});
