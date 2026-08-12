import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { assertEquals, assert } from "jsr:@std/assert";

const URL = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL, SR);

// 하드코딩 이메일로 유저를 만들고 정리하지 않으면 db reset 없이 재실행할 때 전부 실패한다.
// 매 실행마다 랜덤 이메일을 쓰고, 테스트가 끝나면 employees + auth 유저를 반드시 지운다.
function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@rls.test`;
}

async function makeUser(email: string, role: string): Promise<SupabaseClient> {
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password: "pw123456!", email_confirm: true,
  });
  if (error || !u?.user) throw new Error(`createUser 실패: ${error?.message}`);
  const { error: empErr } = await admin.from("employees")
    .insert({ auth_user_id: u.user.id, name: email, email, role });
  if (empErr) throw new Error(`employees insert 실패: ${empErr.message}`);
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email, password: "pw123456!" });
  return c;
}

async function cleanupUser(email: string) {
  const { data: emp } = await admin.from("employees")
    .select("auth_user_id").eq("email", email).maybeSingle();
  await admin.from("employees").delete().eq("email", email);
  if (emp?.auth_user_id) await admin.auth.admin.deleteUser(emp.auth_user_id);
}

// 테스트 본문을 유저 생성/정리로 감싸 어떤 결과에도 잔여물이 남지 않게 한다(멱등 보장).
async function withUser(prefix: string, role: string, fn: (c: SupabaseClient) => Promise<void>) {
  const email = uniqueEmail(prefix);
  try {
    await fn(await makeUser(email, role));
  } finally {
    await cleanupUser(email);
  }
}

Deno.test("RLS: staff는 기준을 수정할 수 없다", async () => {
  await withUser("staff", "staff", async (staff) => {
    const { data } = await staff.from("weather_criteria")
      .update({ threshold: { rain_mm_per_hr: 1 } }).eq("kind", "rain").eq("grade", "watch").select();
    assertEquals(data, []);   // RLS로 0행 매칭
  });
});

Deno.test("RLS: approver는 messages를 수정할 수 있으나 dispatches는 쓸 수 없다", async () => {
  await withUser("ap", "approver", async (ap) => {
    const { error } = await ap.from("dispatches")
      .insert({ message_id: crypto.randomUUID(), event_id: crypto.randomUUID(), results: [] });
    assert(error !== null);
  });
});

Deno.test("RLS: admin은 부서를 생성할 수 있다", async () => {
  await withUser("adm", "admin", async (ad) => {
    const deptName = `테스트부서-${crypto.randomUUID().slice(0, 8)}`;
    const { error } = await ad.from("departments").insert({ name: deptName });
    assertEquals(error, null);
    await admin.from("departments").delete().eq("name", deptName);
  });
});
