import { createClient } from "npm:@supabase/supabase-js@2";
import { assertEquals, assert } from "jsr:@std/assert";

const URL = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL, SR);

async function makeUser(email: string, role: string) {
  const { data: u } = await admin.auth.admin.createUser({ email, password: "pw123456!", email_confirm: true });
  await admin.from("employees").insert({ auth_user_id: u.user!.id, name: email, email, role });
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email, password: "pw123456!" });
  return c;
}

Deno.test("RLS: staff는 기준을 수정할 수 없다", async () => {
  const staff = await makeUser("staff@t.co", "staff");
  const { data } = await staff.from("weather_criteria")
    .update({ threshold: { rain_mm_per_hr: 1 } }).eq("kind", "rain").eq("grade", "watch").select();
  assertEquals(data, []);   // RLS로 0행 매칭
});

Deno.test("RLS: approver는 messages를 수정할 수 있으나 dispatches는 쓸 수 없다", async () => {
  const ap = await makeUser("ap@t.co", "approver");
  const { error } = await ap.from("dispatches")
    .insert({ message_id: crypto.randomUUID(), event_id: crypto.randomUUID(), results: [] });
  assert(error !== null);
});

Deno.test("RLS: admin은 부서를 생성할 수 있다", async () => {
  const ad = await makeUser("adm@t.co", "admin");
  const { error } = await ad.from("departments").insert({ name: "테스트부서" });
  assertEquals(error, null);
});
