import { assertEquals, assertExists } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../_shared/db.ts";

// 전제: supabase start + db reset + 아래 env로 `supabase functions serve --env-file .env.test` 실행 중
//   NOTIFY_CHANNEL=console (KAKAOWORK_BOT_KEY 없음 → 멤버십 조회 없이 모든 이메일 허용)
//   ADMIN_KAKAOWORK_ID=boss@t.co
const FN = "http://127.0.0.1:54321/functions/v1/auth-kakaowork";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

async function requestLink(email: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${FN}?action=request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return res.json();
}

async function cleanup(db: ReturnType<typeof serviceClient>, email: string) {
  const { data: emp } = await db.from("employees").select("auth_user_id").eq("email", email).maybeSingle();
  await db.from("employees").delete().eq("email", email);
  if (emp?.auth_user_id) await db.auth.admin.deleteUser(emp.auth_user_id);
}

Deno.test("request: 신규 워크스페이스 멤버는 staff·부서 미지정으로 자동 가입 + ok:true", async () => {
  const db = serviceClient();
  await cleanup(db, "new@t.co");

  const res = await requestLink("new@t.co");
  assertEquals(res, { ok: true });

  const { data: emp } = await db.from("employees").select("*").eq("email", "new@t.co").single();
  assertEquals(emp.role, "staff");
  assertEquals(emp.department_id, null);
  assertExists(emp.auth_user_id);

  await cleanup(db, "new@t.co");
});

Deno.test("request: ADMIN_KAKAOWORK_ID와 일치하면 admin으로 가입", async () => {
  const db = serviceClient();
  await cleanup(db, "boss@t.co");

  const res = await requestLink("boss@t.co");
  assertEquals(res, { ok: true });

  const { data: emp } = await db.from("employees").select("*").eq("email", "boss@t.co").single();
  assertEquals(emp.role, "admin");
  assertEquals(emp.department_id, null);

  await cleanup(db, "boss@t.co");
});

Deno.test("request: 기존에 staff로 가입된 ADMIN_KAKAOWORK_ID 사용자는 재요청 시 admin으로 승격", async () => {
  const db = serviceClient();
  await cleanup(db, "boss@t.co");
  // env 미설정/오타 상태에서 먼저 staff로 가입해 굳어진 상황을 재현
  await db.from("employees").insert({
    name: "boss@t.co", email: "boss@t.co", kakaowork_user_id: "kw-boss-preexisting", role: "staff",
  });

  const res = await requestLink("boss@t.co");
  assertEquals(res, { ok: true });

  const { data: emp } = await db.from("employees").select("*").eq("email", "boss@t.co").single();
  assertEquals(emp.role, "admin");

  await cleanup(db, "boss@t.co");
});

Deno.test("request: 빈 body/이메일 없이 요청해도 ok:true (열거 공격 방지 — 에러로 정보 노출 안 함)", async () => {
  const res = await fetch(`${FN}?action=request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(await res.json(), { ok: true });
});

Deno.test("callback 세션 확립: 발급된 magiclink token_hash로 verifyOtp하면 세션이 만들어진다", async () => {
  const db = serviceClient();
  await cleanup(db, "linktest@t.co");

  const res = await requestLink("linktest@t.co");
  assertEquals(res, { ok: true });

  // 발송 채널(console)이 실제로 보내는 것과 동일한 링크를 서버에서 재발급해 token_hash를 얻는다
  // (DM 본문 자체는 이 테스트 프로세스에서 캡처할 수 없으므로, 웹의 AuthCallback.tsx가 수행하는
  //  verifyOtp 호출이 실제로 세션을 만들어내는지를 검증한다).
  const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: "linktest@t.co" });
  const tokenHash = link?.properties?.hashed_token;
  assertExists(tokenHash);

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: verified, error } = await anon.auth.verifyOtp({ type: "email", token_hash: tokenHash! });
  assertEquals(error, null);
  assertExists(verified.session);
  assertEquals(verified.user?.email, "linktest@t.co");

  await cleanup(db, "linktest@t.co");
});
