import { assertEquals, assertExists } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../_shared/db.ts";

// 전제: supabase start + db reset + 아래 env로 `supabase functions serve --env-file .env.test` 실행 중
//   NOTIFY_CHANNEL=console, KAKAOWORK_BOT_KEY 없음, SUPABASE_URL/APP_BASE_URL 둘 다 로컬
//   → 멤버십 조회 없이(fail-closed 예외 경로) 모든 이메일 허용
//   ADMIN_KAKAOWORK_ID=boss@t.co
//
// 계정 생성·매직링크 발급·DM 발송은 응답 이후 백그라운드(EdgeRuntime.waitUntil)로 넘어가므로,
// 요청 직후 employees를 조회하면 아직 반영 전일 수 있다 → waitForEmployee로 폴링한다.
// "봇 키 없음 + 비로컬 URL이면 계정이 생성되지 않는다"(fail-closed)는 이 로컬 통합 테스트 하네스가
// 항상 로컬 URL로만 뜨기 때문에 여기서 직접 재현할 수 없다 — 그 분기 로직(isLocalUrl)은
// `_shared/kakaowork_test.ts`에서 결정적으로 단위 테스트한다.
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

async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 5000, intervalMs = 50 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("pollUntil: 타임아웃 — 백그라운드 작업이 끝나지 않음");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function waitForEmployee(db: ReturnType<typeof serviceClient>, email: string) {
  return pollUntil(async () => {
    const { data } = await db.from("employees").select("*").eq("email", email).maybeSingle();
    return data;
  });
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

  const emp = await waitForEmployee(db, "new@t.co");
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

  const emp = await waitForEmployee(db, "boss@t.co");
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

  const emp = await pollUntil(async () => {
    const { data } = await db.from("employees").select("*").eq("email", "boss@t.co").maybeSingle();
    return data?.role === "admin" ? data : null;
  });
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
  await waitForEmployee(db, "linktest@t.co"); // 백그라운드 프로비저닝 완료를 기다림

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
