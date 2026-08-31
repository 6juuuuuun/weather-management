// supabase/functions/_shared/rls_test.ts가 검증하던 "정책 자체"를 자체 호스팅으로 옮긴 것.
//
// 왜 라우트 테스트로는 대신할 수 없는가:
//   - `PUT /api/criteria`는 requireAdmin이 **질의에 닿기 전에** 403을 낸다. 그래서
//     weather_criteria의 w_admin 정책을 통째로 지워도 실패하는 라우트 테스트가 하나도 없다.
//     지금 실효 방어가 미들웨어 한 겹뿐인데도 심층 방어가 있다고 착각하게 된다.
//   - dispatches 쓰기는 애초에 HTTP 경로가 없다(서버 작업이 withService로만 쓴다).
//     그래도 정책이 지켜지는지는 검증할 수 있다 — withUser로 직접 질의하면 된다.
//
// 두 경우 모두 라우트를 거치지 않고 withUser(= app_user 롤, 정책 적용)로 직접 질의해
// 정책 경로를 탄다. withService(app_service, bypassrls)와의 대비를 양성 대조군으로 함께
// 둔다 — "0행/거부"만 단언하면 질의가 엉뚱해서 아무것도 안 걸린 경우에도 통과한다.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withUser, withService } from "../src/db.ts";

// 시드 값(db/seed.sql): rain watch = {"rain_mm_per_hr":20}
const SEED_RAIN_WATCH = { rain_mm_per_hr: 20 };

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from dispatches");
    await q.query("delete from messages");
    await q.query("delete from weather_events");
    await q.query("delete from auth_sessions");
    await q.query("delete from alert_recipients");
    await q.query("delete from recipients");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees");
  });
});

afterEach(async () => {
  // weather_criteria는 시드가 8개 조합을 전부 소유한다. 아래 양성 대조군이 값을 바꾸므로
  // 지우지 않고 시드 값으로 되돌린다.
  await withService((q) =>
    q.query("update weather_criteria set threshold = $1::jsonb where kind='rain' and grade='watch'", [
      JSON.stringify(SEED_RAIN_WATCH),
    ]),
  );
});

/**
 * 가입 라우트로 계정+직원 행을 한 쌍 만든다. withUser에 넘겨야 하는 값은
 * employees.id가 아니라 auth_accounts.id다(= auth.uid()의 원본, req.user.accountId).
 * 직접 insert로 만들면 그 연결을 손으로 흉내 내야 해서 실제 로그인 경로와 어긋난다.
 */
async function makeAccount(email: string, role: "staff" | "approver" | "admin") {
  await request(app).post("/api/auth/signup").send({ email, password: "rls-password-1", name: "테스트" });
  return withService(async (q) => {
    const { rows } = await q.query(
      "update employees set role = $2 where email = $1 returning id, auth_user_id",
      [email, role],
    );
    return { employeeId: rows[0].id as string, accountId: rows[0].auth_user_id as string };
  });
}

describe("RLS: weather_criteria 쓰기", () => {
  // 원본 rls_test.ts "staff는 기준을 수정할 수 없다".
  // RLS의 UPDATE 거부는 에러가 아니라 "0행 영향"으로 나타난다.
  it("관리자가 아니면 기준을 수정할 수 없다 (라우트가 아니라 정책이 막는다)", async () => {
    const staff = await makeAccount("rls-staff@gonjiam.com", "staff");
    const updated = await withUser(staff.accountId, async (q) => {
      const { rows } = await q.query(
        `update weather_criteria set threshold = '{"rain_mm_per_hr":1}'::jsonb
          where kind = 'rain' and grade = 'watch' returning kind`,
      );
      return rows;
    });
    expect(updated).toEqual([]);

    const stored = await withService(async (q) => {
      const { rows } = await q.query("select threshold from weather_criteria where kind='rain' and grade='watch'");
      return rows[0].threshold;
    });
    expect(stored).toEqual(SEED_RAIN_WATCH);
  });

  // 양성 대조군. 이게 없으면 위 테스트는 where가 아무것도 못 맞혀도(오타·잘못된 테이블)
  // 똑같이 "0행"으로 통과한다 — 정책이 실제로 판정에 관여했는지 알 수 없다.
  it("관리자는 같은 질의로 기준을 수정할 수 있다 (정책이 역할로 갈린다는 증거)", async () => {
    const admin = await makeAccount("rls-admin@gonjiam.com", "admin");
    const updated = await withUser(admin.accountId, async (q) => {
      const { rows } = await q.query(
        `update weather_criteria set threshold = '{"rain_mm_per_hr":1}'::jsonb
          where kind = 'rain' and grade = 'watch' returning kind`,
      );
      return rows;
    });
    expect(updated).toHaveLength(1);
  });

  // 로그인하지 않은 접속(app.current_user_id 미설정)은 auth.uid()가 null이라
  // 정책이 아무 행도 통과시키지 않는다 — 0008의 "안전한 기본값" 주장을 실제로 확인한다.
  it("app_user로 붙어도 사용자 없이는 아무 행도 수정하지 못한다", async () => {
    const updated = await withUser("00000000-0000-0000-0000-000000000000", async (q) => {
      const { rows } = await q.query(
        `update weather_criteria set threshold = '{"rain_mm_per_hr":1}'::jsonb
          where kind = 'rain' and grade = 'watch' returning kind`,
      );
      return rows;
    });
    expect(updated).toEqual([]);
  });
});

describe("RLS: dispatches 쓰기", () => {
  // 원본 rls_test.ts "Alert 수신자도 dispatches에는 쓸 수 없다".
  // dispatches에는 insert/update/delete 정책이 하나도 없고(0002_rls.sql), RLS가 켜진
  // 테이블은 정책이 없으면 기본 거부다. 거부가 "0행"이 아니라 에러로 나타난다.
  it("알림 수신자여도 dispatches에 직접 쓸 수 없다", async () => {
    const recip = await makeAccount("rls-dispatch@gonjiam.com", "staff");
    await withService((q) =>
      q.query("insert into alert_recipients (employee_id) values ($1)", [recip.employeeId]));

    // 정책 말고 다른 이유(외래키 위반 등)로 실패하면 테스트가 엉뚱한 걸 증명하게 된다.
    // 실제로 존재하는 event/message를 만들어 두고, 남는 거부 사유가 정책뿐이게 한다.
    const { messageId, eventId } = await withService(async (q) => {
      const { rows: ev } = await q.query(
        "insert into weather_events (kind, grade) values ('rain','watch') returning id");
      const { rows: msg } = await q.query(
        "insert into messages (event_id, content) values ($1, '[]'::jsonb) returning id", [ev[0].id]);
      return { messageId: msg[0].id as string, eventId: ev[0].id as string };
    });

    const insert = (q: { query(t: string, p?: unknown[]): Promise<{ rows: any[] }> }) =>
      q.query(
        `insert into dispatches (message_id, event_id, repeat_no, results)
         values ($1, $2, 1, '[]'::jsonb) returning id`,
        [messageId, eventId],
      );

    await expect(withUser(recip.accountId, insert)).rejects.toThrow(/row-level security/i);

    // 양성 대조군: 같은 행을 withService(bypassrls)로는 넣을 수 있다 — 즉 위 실패는
    // 행이 잘못돼서가 아니라 정책 때문이다. (넣은 뒤 바로 지운다.)
    const inserted = await withService(async (q) => {
      const { rows } = await insert(q);
      await q.query("delete from dispatches where id = $1", [rows[0].id]);
      return rows;
    });
    expect(inserted).toHaveLength(1);

    // 거부가 "에러는 났지만 행은 들어감"이 아니었는지 확인한다.
    const count = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from dispatches");
      return rows[0].n;
    });
    expect(count).toBe(0);
  });
});
