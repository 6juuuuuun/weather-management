import { describe, expect, it, beforeAll } from "vitest";
import { Client } from "pg";

const url = process.env.DATABASE_URL!;
let db: Client;

// 마이그레이션에서 뽑은 최종 목록이다(create 29건에서 drop으로 사라진 2건을 뺀 27건).
// 이관 중 마이그레이션이 조용히 실패하면 여기서 걸린다.
const EXPECTED_POLICIES = [
  "action_guidelines.r_guidelines", "action_guidelines.w_admin_all",
  "alert_recipients.r_all", "alert_recipients.w_admin_all",
  "alert_settings.r_all", "alert_settings.w_admin",
  "departments.r_all", "departments.w_admin_del", "departments.w_admin_ins", "departments.w_admin_upd",
  "dispatches.r_all",
  "employees.r_all", "employees.w_admin_del", "employees.w_admin_ins", "employees.w_admin_upd",
  "heartbeats.r_all",
  "messages.r_messages", "messages.w_approver",
  "recipients.r_all", "recipients.w_admin_all",
  "site_settings.r_all", "site_settings.w_admin",
  "weather_criteria.r_all", "weather_criteria.w_admin", "weather_criteria.w_admin_ins",
  "weather_events.r_all",
  "weather_observations.r_all",
];

beforeAll(async () => {
  db = new Client({ connectionString: url });
  await db.connect();
});

describe("자체 호스팅 스키마", () => {
  // 이 시스템의 개인정보 안전망은 DB 안에 있다. 이식하면서 정책이 유실되면
  // 코드에 검사가 없는 상태로 명부가 열린다 — 가장 먼저 확인해야 할 것이다.
  // 개수만 세면 정책 이름이 바뀌어도 통과한다. (테이블, 정책명) 쌍을 통째로 비교한다.
  it("권한 정책 27개가 이름까지 그대로 있다", async () => {
    const { rows } = await db.query(
      "select tablename, policyname from pg_policies where schemaname = 'public' order by tablename, policyname",
    );
    const actual = rows.map((r) => `${r.tablename}.${r.policyname}`);
    expect(actual).toEqual(EXPECTED_POLICIES);
  });

  it("auth.uid()가 세션 변수를 읽는다", async () => {
    await db.query("begin");
    await db.query("set local app.current_user_id = '11111111-1111-1111-1111-111111111111'");
    const { rows } = await db.query("select auth.uid() as uid");
    await db.query("commit");
    expect(rows[0].uid).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("세션 변수가 없으면 auth.uid()가 null이다", async () => {
    const { rows } = await db.query("select auth.uid() as uid");
    expect(rows[0].uid).toBeNull();
  });

  it("app_service는 정책을 우회하고 app_user는 우회하지 않는다", async () => {
    const { rows } = await db.query(
      "select rolname, rolbypassrls from pg_roles where rolname in ('app_user','app_service') order by rolname",
    );
    expect(rows).toEqual([
      { rolname: "app_service", rolbypassrls: true },
      { rolname: "app_user", rolbypassrls: false },
    ]);
  });
});
