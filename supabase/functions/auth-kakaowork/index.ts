import { serviceClient } from "../_shared/db.ts";

const env = (k: string) => Deno.env.get(k);
const AUTH_URL = "https://auth.kakaowork.com/oauth2/authorize";
const TOKEN_URL = "https://auth.kakaowork.com/oauth2/token";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");
  const selfUrl = `${env("SUPABASE_URL")}/functions/v1/auth-kakaowork?action=callback`;

  if (action === "login") {
    const q = new URLSearchParams({ client_id: env("KAKAOWORK_CLIENT_ID")!,
      redirect_uri: selfUrl, response_type: "code", state: crypto.randomUUID() });
    return Response.redirect(`${AUTH_URL}?${q}`, 302);
  }

  if (action === "callback") {
    let profile: { email: string; user_id: string; name?: string };
    const mock = env("MOCK_KAKAO_PROFILE");
    if (mock) {
      // 테스트 전용: MOCK_KAKAO_PROFILE env가 설정된 경우에만 쿼리 파라미터로 mock 프로필의 email을
      // 오버라이드할 수 있게 한다(env 없는 프로덕션에서는 이 분기 자체에 도달하지 않으므로 완전 무시됨).
      // user_id도 email에 종속해 함께 바꿔 kakaowork_user_id unique 제약과 충돌하지 않게 한다.
      profile = JSON.parse(mock);
      const mockEmail = u.searchParams.get("mock_email");
      if (mockEmail) {
        profile = { ...profile, email: mockEmail, user_id: `kw-${mockEmail}` };
      }
    } else {
      const code = u.searchParams.get("code")!;
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
    const role = profile.email === env("ADMIN_KAKAOWORK_ID") ? "admin" : "staff";
    const { data: existing } = await db.from("employees").select("*").eq("email", profile.email).maybeSingle();
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
      role: existing?.role ?? role,
      department_id: existing?.department_id ?? null,
    }, { onConflict: "email" });

    const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: profile.email });
    const tokenHash = link.properties.hashed_token;
    return Response.redirect(`${env("APP_BASE_URL")}/auth/callback#token_hash=${tokenHash}`, 302);
  }

  return new Response("bad request", { status: 400 });
});
