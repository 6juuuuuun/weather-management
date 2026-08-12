import { assertEquals } from "jsr:@std/assert";
import { serviceClient } from "../_shared/db.ts";

// 전제: supabase start + db reset + 아래 env로 `supabase functions serve --env-file .env.test` 실행 중
//   MOCK_KAKAO_PROFILE={"email":"new@t.co","user_id":"kw-new","name":"신규"}
//   ADMIN_KAKAOWORK_ID=boss@t.co
// 두 번째 테스트는 MOCK_KAKAO_PROFILE의 email을 재기동 없이 오버라이드하기 위해
// index.ts가 지원하는 테스트 전용 쿼리 파라미터 `mock_email`을 사용한다(MOCK_KAKAO_PROFILE env가
// 설정되어 있을 때에만 동작 — 프로덕션에선 무시됨).
const FN = "http://127.0.0.1:54321/functions/v1/auth-kakaowork";

async function cleanup(db: ReturnType<typeof serviceClient>, email: string) {
  const { data: emp } = await db.from("employees").select("auth_user_id").eq("email", email).maybeSingle();
  await db.from("employees").delete().eq("email", email);
  if (emp?.auth_user_id) await db.auth.admin.deleteUser(emp.auth_user_id);
}

Deno.test("callback: 신규 사용자는 staff·부서 미지정으로 자동 가입", async () => {
  const db = serviceClient();
  await cleanup(db, "new@t.co");

  const res = await fetch(`${FN}?action=callback&code=x`, { redirect: "manual" });
  assertEquals(res.status, 302);
  const loc = res.headers.get("location")!;
  assertEquals(loc.includes("token_hash="), true);

  const { data: emp } = await db.from("employees").select("*").eq("email", "new@t.co").single();
  assertEquals(emp.role, "staff");
  assertEquals(emp.department_id, null);
  assertEquals(emp.kakaowork_user_id, "kw-new");

  await cleanup(db, "new@t.co");
});

Deno.test("callback: ADMIN_KAKAOWORK_ID와 일치하면 admin", async () => {
  const db = serviceClient();
  await cleanup(db, "boss@t.co");

  const res = await fetch(`${FN}?action=callback&code=x&mock_email=boss@t.co`, { redirect: "manual" });
  assertEquals(res.status, 302);
  const loc = res.headers.get("location")!;
  assertEquals(loc.includes("token_hash="), true);

  const { data: emp } = await db.from("employees").select("*").eq("email", "boss@t.co").single();
  assertEquals(emp.role, "admin");
  assertEquals(emp.department_id, null);
  assertEquals(emp.kakaowork_user_id, "kw-boss@t.co");

  await cleanup(db, "boss@t.co");
});
