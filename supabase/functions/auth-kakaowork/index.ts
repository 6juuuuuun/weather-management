// 카카오워크 서드파티 OAuth는 존재하지 않음(auth.kakaowork.com DNS 없음, 2026-08-12 실측)이 확인되어
// OAuth 왕복 인증을 폐기하고, 카카오워크 봇 DM으로 Supabase 매직링크를 보내는 방식으로 전환했다.
// 봇 API(users.find_by_email · conversations.open · messages.send)는 실계정으로 동작이 확인됐다.
//
// 콜백(수신 링크 클릭 후 세션 확립)은 이 함수가 아니라 웹의 AuthCallback.tsx가 담당한다 — DM에 실리는
// 링크가 이미 `${APP_BASE_URL}/auth/callback#token_hash=...` 형태의 프런트엔드 URL이라, 브라우저가
// 곧장 그 페이지로 진입해 supabase-js verifyOtp()를 호출한다. 이 함수에 별도의 콜백 라우트가 있으면
// (예: email을 쿼리로 받아 magiclink를 발급) 인증 없이 임의 이메일로 로그인 링크를 발급하는 경로가
// 하나 더 생기는 셈이라 보안상 두지 않는다.
import { serviceClient } from "../_shared/db.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import { resolveKakaoworkUserIdByEmail } from "../_shared/kakaowork.ts";

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");

  if (action === "request" && req.method === "POST") {
    return handleRequest(req);
  }

  return new Response("bad request", { status: 400 });
});

async function handleRequest(req: Request): Promise<Response> {
  let email: string | undefined;
  try {
    const body = await req.json();
    email = typeof body?.email === "string" ? body.email.trim() : undefined;
  } catch {
    // 잘못된 body도 열거 공격 방지를 위해 동일하게 ok:true로 응답한다.
  }

  const ok = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  if (!email) return ok;

  const botKey = env("KAKAOWORK_BOT_KEY");
  // 봇 키가 있으면 실제 워크스페이스 멤버인지 조회해 존재 여부를 절대 노출하지 않는다(비멤버는 조용히 ok만 반환).
  // 봇 키가 없는 로컬 개발(ConsoleChannel 경로)에서는 멤버십을 조회할 수 없으므로 모든 이메일을 허용해
  // 링크가 콘솔에 출력되도록 한다.
  let kakaoworkUserId: string | null = null;
  if (botKey) {
    kakaoworkUserId = await resolveKakaoworkUserIdByEmail(botKey, email);
    if (!kakaoworkUserId) return ok;
  }

  const db = serviceClient();
  const { data: existing } = await db.from("employees").select("*").eq("email", email).maybeSingle();
  // ADMIN_KAKAOWORK_ID와 일치하면 기존 사용자 여부와 무관하게 항상 admin을 보장한다(강등은 하지 않음).
  const role = email === env("ADMIN_KAKAOWORK_ID") ? "admin" : (existing?.role ?? "staff");
  let authUserId = existing?.auth_user_id;
  if (!authUserId) {
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email, email_confirm: true,
    });
    if (createErr || !created?.user) {
      console.error(`auth-kakaowork: createUser 실패 email=${email} error=${createErr?.message}`);
      return ok;
    }
    authUserId = created.user.id;
  }
  await db.from("employees").upsert({
    email,
    auth_user_id: authUserId,
    name: existing?.name ?? email,
    kakaowork_user_id: kakaoworkUserId ?? existing?.kakaowork_user_id ?? null,
    role,
    department_id: existing?.department_id ?? null,
  }, { onConflict: "email" });

  const { data: link, error: linkErr } = await db.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (!tokenHash) {
    console.error(`auth-kakaowork: 매직링크 발급 실패 email=${email} error=${linkErr?.message}`);
    return ok;
  }

  const loginUrl = `${env("APP_BASE_URL")}/auth/callback#token_hash=${tokenHash}`;
  const text = `[날씨경영] 로그인 링크입니다. 5분 내 만료되며 1회만 사용됩니다.\n${loginUrl}`;

  const channel = getChannel({
    NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
    KAKAOWORK_BOT_KEY: botKey ?? undefined,
  });
  const sendResult = await channel.send(kakaoworkUserId ?? email, text);
  if (!sendResult.ok) {
    console.error(`auth-kakaowork: DM 발송 실패 email=${email} error=${sendResult.error}`);
  }

  return ok;
}
