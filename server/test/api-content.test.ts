import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

async function agentAs(role: "staff" | "admin" | "approver", email: string) {
  const who = { email, password: "some-password-1", name: "테스트" };
  await request(app).post("/api/auth/signup").send(who);
  await withService(async (q) => {
    await q.query("update employees set role=$2 where email=$1", [email, role]);
  });
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: who.password });
  return agent;
}

// db/seed.sql이 심어 둔 부서(4루트+12자식)·특보 기준·alert_settings·site_settings는
// 절대 건드리지 않는다 — 이 접두사로 만든 부서만 지운다. weather_events는 messages를
// on delete cascade로 끌고 오지만 messages -> dispatches는 cascade가 없어(FK만
// 있음) weather_events보다 먼저 지워야 FK 위반이 나지 않는다.
const DEPT_PREFIX = "zztest-dept-";

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("delete from dispatches");
    await q.query("delete from messages");
    await q.query("delete from weather_events");
    await q.query("delete from action_guidelines");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees");
    await q.query("delete from departments where name like $1", [`${DEPT_PREFIX}%`]);
  });
});

async function makeDept(name: string) {
  return withService(async (q) => {
    const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
      `${DEPT_PREFIX}${name}`,
    ]);
    return rows[0].id as string;
  });
}

describe("행동지침", () => {
  it("저장하면 같은 키의 기존 지침을 덮어쓴다 (staff_actions/guest_notice)", async () => {
    const agent = await agentAs("admin", "g@gonjiam.com");
    const deptId = await makeDept("시설");

    const row = {
      department_id: deptId,
      kind: "rain",
      grade: "watch",
      staff_actions: ["배수로 점검"],
      guest_notice: "우천 안내",
    };
    expect((await agent.put("/api/guidelines").send({ rows: [row] })).status).toBe(204);
    expect(
      (
        await agent.put("/api/guidelines").send({
          rows: [{ ...row, staff_actions: ["배수로 점검", "보고"], guest_notice: "우천 안내(개정)" }],
        })
      ).status,
    ).toBe(204);

    const res = await agent.get("/api/guidelines");
    expect(res.status).toBe(200);
    // upsert 대상이 (department_id, kind, grade) 하나뿐이므로 행이 늘지 않고 그대로
    // 하나여야 한다 — 이 길이 검사가 없으면 on conflict가 빠져 매번 새 행이
    // 쌓이는 회귀를 놓친다.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].staff_actions).toEqual(["배수로 점검", "보고"]);
    expect(res.body[0].guest_notice).toBe("우천 안내(개정)");
  });

  it("일반 직원은 지침을 바꿀 수 없다", async () => {
    const agent = await agentAs("staff", "h@gonjiam.com");
    const deptId = await makeDept("객실");
    const res = await agent.put("/api/guidelines").send({
      rows: [{ department_id: deptId, kind: "rain", grade: "watch", staff_actions: [], guest_notice: "" }],
    });
    expect(res.status).toBe(403);
    // 403이 role 게이트에서 난 것이지 다른 이유(예: 빈 배열이라 아무것도 안 함)로
    // 우연히 그런 게 아님을 DB로 직접 확인한다.
    const count = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from action_guidelines where department_id = $1", [
        deptId,
      ]);
      return rows[0].n;
    });
    expect(count).toBe(0);
  });

  it("kind가 잘못되면 400이고, 배치의 유효한 행도 함께 거부된다", async () => {
    const agent = await agentAs("admin", "i@gonjiam.com");
    const deptId = await makeDept("보안");
    const res = await agent.put("/api/guidelines").send({
      rows: [
        { department_id: deptId, kind: "rain", grade: "watch", staff_actions: [], guest_notice: "정상 행" },
        { department_id: deptId, kind: "typhoon", grade: "watch", staff_actions: [], guest_notice: "나쁜 kind" },
      ],
    });
    expect(res.status).toBe(400);
    // 배치 전체가 거부됐는지 — 유효했던 첫 행조차 저장되지 않아야 한다.
    // (한 행씩 순서대로 insert했다면 첫 행은 이미 커밋돼 이 검사가 실패한다.)
    const count = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from action_guidelines where department_id = $1", [
        deptId,
      ]);
      return rows[0].n;
    });
    expect(count).toBe(0);
  });

  it("grade가 잘못되면 400이고 아무것도 저장되지 않는다", async () => {
    const agent = await agentAs("admin", "j@gonjiam.com");
    const deptId = await makeDept("조경");
    const res = await agent.put("/api/guidelines").send({
      rows: [{ department_id: deptId, kind: "rain", grade: "severe", staff_actions: [], guest_notice: "" }],
    });
    expect(res.status).toBe(400);
    const count = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from action_guidelines where department_id = $1", [
        deptId,
      ]);
      return rows[0].n;
    });
    expect(count).toBe(0);
  });

  // department_id는 UUID 형식 검사(위 두 테스트와 같은 자리)만으로는 못 막는다 —
  // 형식은 맞지만 실존하지 않는 부서를 그대로 insert하면 외래키 위반(23503)이라
  // 검증 없이 두면 index.ts의 공용 에러 핸들러가 그냥 500으로 뭉갠다.
  it("존재하지 않는 department_id면 400이고 아무것도 저장되지 않는다", async () => {
    const agent = await agentAs("admin", "i2@gonjiam.com");
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const res = await agent.put("/api/guidelines").send({
      rows: [{ department_id: ghostId, kind: "rain", grade: "watch", staff_actions: [], guest_notice: "" }],
    });
    // 500(외래키 위반이 그대로 샌 경우)이 아니라 400이어야 한다 — 이 단언이 없으면
    // "그냥 에러 핸들러가 잡아 어쨌든 에러 응답은 났다"는 상태로도 통과해 버린다.
    expect(res.status).toBe(400);
    const count = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from action_guidelines where department_id = $1", [
        ghostId,
      ]);
      return rows[0].n;
    });
    expect(count).toBe(0);
  });

  // r_guidelines 정책(0002_rls.sql): admin·approver는 전체, staff는 자기 부서만.
  // 핸들러가 withUser 대신 withService(정책 우회)를 쓰는 회귀를 이 테스트가 잡는다 —
  // withService로 바뀌면 staff 응답에도 남의 부서 지침이 섞여 나와 실패한다.
  it("일반 직원은 자기 부서의 지침만 조회된다", async () => {
    const deptA = await makeDept("A부서");
    const deptB = await makeDept("B부서");
    const admin = await agentAs("admin", "k@gonjiam.com");
    await admin.put("/api/guidelines").send({
      rows: [
        { department_id: deptA, kind: "rain", grade: "watch", staff_actions: [], guest_notice: "A" },
        { department_id: deptB, kind: "rain", grade: "watch", staff_actions: [], guest_notice: "B" },
      ],
    });

    const staff = await agentAs("staff", "l@gonjiam.com");
    await withService(async (q) => {
      await q.query("update employees set department_id = $1 where email = $2", [deptA, "l@gonjiam.com"]);
    });

    const res = await staff.get("/api/guidelines");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].department_id).toBe(deptA);
  });

  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/guidelines")).status).toBe(401);
    expect((await request(app).put("/api/guidelines").send({ rows: [] })).status).toBe(401);
  });
});

describe("메시지", () => {
  // one_open_event 부분 유니크 인덱스(0001_schema.sql)가 kind+grade당 열린 특보를
  // 하나로 제한한다 — 같은 (kind,grade)로 두 이벤트를 만들면 충돌한다. 테스트마다
  // kind/grade 조합을 다르게 줘 서로 부딪히지 않게 한다.
  async function makeEvent(kind = "rain", grade = "watch") {
    return withService(async (q) => {
      const { rows } = await q.query(
        "insert into weather_events (kind, grade) values ($1, $2) returning id",
        [kind, grade],
      );
      return rows[0].id as string;
    });
  }

  it("event_id가 없으면 400이다", async () => {
    const agent = await agentAs("staff", "m@gonjiam.com");
    expect((await agent.get("/api/messages")).status).toBe(400);
  });

  it("event_id로 필터링해 그 특보의 메시지만 돌려준다", async () => {
    const evA = await makeEvent("rain", "watch");
    const evB = await makeEvent("snow", "warning");
    await withService(async (q) => {
      await q.query("insert into messages (event_id, content) values ($1, $2)", [evA, JSON.stringify([{ a: 1 }])]);
      await q.query("insert into messages (event_id, content) values ($1, $2)", [evB, JSON.stringify([{ b: 2 }])]);
    });

    const agent = await agentAs("staff", "n@gonjiam.com");
    const res = await agent.get("/api/messages").query({ event_id: evA });
    expect(res.status).toBe(200);
    // event_id 필터가 실제로 걸려 있는지 — 걸려 있지 않으면 evB의 메시지까지
    // 섞여 길이가 2가 된다.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].event_id).toBe(evA);
    expect(res.body[0].content).toEqual([{ a: 1 }]);
  });

  it("로그인하지 않으면 401이다", async () => {
    const evA = await makeEvent();
    expect((await request(app).get("/api/messages").query({ event_id: evA })).status).toBe(401);
  });
});

describe("메시지 갱신 (임시 저장)", () => {
  async function makeEvent(kind = "rain", grade = "watch") {
    return withService(async (q) => {
      const { rows } = await q.query(
        "insert into weather_events (kind, grade) values ($1, $2) returning id",
        [kind, grade],
      );
      return rows[0].id as string;
    });
  }

  async function makeMessage(content: unknown[] = []) {
    const eventId = await makeEvent();
    const messageId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into messages (event_id, content) values ($1, $2) returning id",
        [eventId, JSON.stringify(content)],
      );
      return rows[0].id as string;
    });
    return { eventId, messageId };
  }

  // 0007_approver_from_alert_recipients.sql이 w_approver 정책을 role='approver'가
  // 아니라 current_emp_is_approver()(= alert_recipients 등록 여부)로 바꿔 놓았다 —
  // 화면(Criteria.tsx)이 "Alert 수신자 = 승인 권한자"라고 안내하는 것과 실제 게이트를
  // 맞추기 위해서다(2026-08-13 스펙). role만으로 helper를 만들면 이 정책을 제대로
  // 검증하지 못한다 — alert_recipients에 실제로 등록하는 헬퍼를 따로 둔다.
  async function alertRecipientAgent(email: string) {
    const agent = await agentAs("approver", email);
    const empId = await withService(async (q) => {
      const { rows } = await q.query("select id from employees where email = $1", [email]);
      return rows[0].id;
    });
    await withService((q) =>
      q.query("insert into alert_recipients (employee_id) values ($1) on conflict do nothing", [empId]),
    );
    return agent;
  }

  it("로그인하지 않으면 401이다", async () => {
    const { messageId } = await makeMessage();
    expect(
      (await request(app).patch(`/api/messages/${messageId}`).send({ content: [] })).status,
    ).toBe(401);
  });

  it("staff는 저장할 수 없다", async () => {
    const staff = await agentAs("staff", "msg-staff@gonjiam.com");
    const { messageId } = await makeMessage([{ a: 1 }]);
    const res = await staff.patch(`/api/messages/${messageId}`).send({ content: [{ a: 2 }] });
    expect(res.status).toBe(403);
    const content = await withService(async (q) => {
      const { rows } = await q.query("select content from messages where id = $1", [messageId]);
      return rows[0].content;
    });
    expect(content).toEqual([{ a: 1 }]);
  });

  // 회귀 대상: role='approver'이기만 하고 alert_recipients에는 없는 사람은 막혀야
  // 한다 — 이 구분이 없으면 "승인 요청 DM은 받는데 승인은 못 하는" 원래 버그
  // (0007 마이그레이션의 배경)가 이 엔드포인트에서 재발한 것과 같다.
  it("role이 approver여도 alert_recipients에 없으면 저장할 수 없다", async () => {
    const notRecipient = await agentAs("approver", "msg-role-only@gonjiam.com");
    const { messageId } = await makeMessage([{ a: 1 }]);
    const res = await notRecipient.patch(`/api/messages/${messageId}`).send({ content: [{ a: 9 }] });
    expect(res.status).toBe(403);
  });

  it("alert_recipients에 등록된 사람은 content를 저장할 수 있다", async () => {
    const approver = await alertRecipientAgent("msg-approver@gonjiam.com");
    const { messageId } = await makeMessage([{ a: 1 }]);
    const newContent = [{ a: 2, department_name: "시설" }];
    const res = await approver.patch(`/api/messages/${messageId}`).send({ content: newContent });
    expect(res.status).toBe(200);
    expect(res.body.content).toEqual(newContent);

    const stored = await withService(async (q) => {
      const { rows } = await q.query("select content from messages where id = $1", [messageId]);
      return rows[0].content;
    });
    expect(stored).toEqual(newContent);
  });

  it("content가 배열이 아니면 400이다", async () => {
    const approver = await alertRecipientAgent("msg-badbody-approver@gonjiam.com");
    const { messageId } = await makeMessage();
    const res = await approver.patch(`/api/messages/${messageId}`).send({ content: "아무거나" });
    expect(res.status).toBe(400);
  });

  it("id 형식이 잘못되면 400이다", async () => {
    const approver = await alertRecipientAgent("msg-badid-approver@gonjiam.com");
    const res = await approver.patch("/api/messages/not-a-uuid").send({ content: [] });
    expect(res.status).toBe(400);
  });

  it("없는 메시지면 404다", async () => {
    const approver = await alertRecipientAgent("msg-404-approver@gonjiam.com");
    const res = await approver
      .patch("/api/messages/00000000-0000-0000-0000-000000000000")
      .send({ content: [] });
    expect(res.status).toBe(404);
  });

  // 승인된 메시지는 이미 발송 파이프라인이 읽어 간 내용이다. 이후 수정은 실제로
  // 나간 문구와 화면에 보이는 문구를 어긋나게 만들 뿐 발송을 되돌리지 못한다.
  it("이미 승인된 메시지는 수정할 수 없다 (409)", async () => {
    const approver = await alertRecipientAgent("msg-approved@gonjiam.com");
    const { messageId } = await makeMessage([{ a: 1 }]);
    await withService((q) => q.query("update messages set status = 'approved' where id = $1", [messageId]));

    const res = await approver.patch(`/api/messages/${messageId}`).send({ content: [{ a: 99 }] });
    expect(res.status).toBe(409);

    // 409가 실제 게이트에서 났는지 — 내용이 그대로여야 한다.
    const stored = await withService(async (q) => {
      const { rows } = await q.query("select content from messages where id = $1", [messageId]);
      return rows[0].content;
    });
    expect(stored).toEqual([{ a: 1 }]);
  });
});

describe("발송 이력", () => {
  async function makeEventAndMessage() {
    return withService(async (q) => {
      const { rows: ev } = await q.query(
        "insert into weather_events (kind, grade) values ('rain','watch') returning id",
      );
      const { rows: msg } = await q.query("insert into messages (event_id, content) values ($1, $2) returning id", [
        ev[0].id,
        JSON.stringify([]),
      ]);
      return { eventId: ev[0].id as string, messageId: msg[0].id as string };
    });
  }

  it("최신순으로 정렬해 돌려준다", async () => {
    const { eventId, messageId } = await makeEventAndMessage();
    await withService(async (q) => {
      await q.query(
        `insert into dispatches (message_id, event_id, sent_at, repeat_no, results)
         values ($1, $2, now() - interval '2 hours', 1, '[]'), ($1, $2, now() - interval '1 hour', 2, '[]')`,
        [messageId, eventId],
      );
    });
    const agent = await agentAs("staff", "o@gonjiam.com");
    const res = await agent.get("/api/dispatches");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // sent_at desc — 정렬이 빠지면(삽입 순서 그대로면) repeat_no가 [1,2]로 나온다.
    expect(res.body.map((d: any) => d.repeat_no)).toEqual([2, 1]);
  });

  it("since로 그 시각 이후 발송만 걸러낸다", async () => {
    const { eventId, messageId } = await makeEventAndMessage();
    const cutoff = new Date(Date.now() - 90 * 60_000).toISOString(); // 1.5시간 전
    await withService(async (q) => {
      await q.query(
        `insert into dispatches (message_id, event_id, sent_at, repeat_no, results)
         values ($1, $2, now() - interval '3 hours', 1, '[]'), ($1, $2, now() - interval '30 minutes', 2, '[]')`,
        [messageId, eventId],
      );
    });
    const agent = await agentAs("staff", "p@gonjiam.com");
    const res = await agent.get("/api/dispatches").query({ since: cutoff });
    expect(res.status).toBe(200);
    // since를 무시하면(필터가 빠지면) 3시간 전 것도 함께 나와 길이가 2가 된다.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].repeat_no).toBe(2);
  });

  it("limit으로 개수를 제한한다", async () => {
    const { eventId, messageId } = await makeEventAndMessage();
    await withService(async (q) => {
      await q.query(
        `insert into dispatches (message_id, event_id, sent_at, repeat_no, results)
         values ($1, $2, now() - interval '3 hours', 1, '[]'),
                ($1, $2, now() - interval '2 hours', 2, '[]'),
                ($1, $2, now() - interval '1 hours', 3, '[]')`,
        [messageId, eventId],
      );
    });
    const agent = await agentAs("staff", "q@gonjiam.com");
    const res = await agent.get("/api/dispatches").query({ limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((d: any) => d.repeat_no)).toEqual([3, 2]);
  });

  // History.tsx(apps/web)는 dispatches 자체 컬럼만으로는 표의 "특보"·"특보 발생"
  // 열과 상세 모달 제목을 못 채운다 — weather_events(kind, grade, detected_at)를
  // 조인해서 받는다. 이 필드들이 빠지면(또는 조인이 깨지면) undefined로 나와
  // 이 단언들이 실패한다.
  it("weather_events를 조인해 kind·grade·detected_at을 함께 돌려준다", async () => {
    const { eventId, messageId, kind, grade, detectedAt } = await withService(async (q) => {
      const { rows: ev } = await q.query(
        "insert into weather_events (kind, grade, detected_at) values ('wind','warning', now() - interval '5 hours') returning id, kind, grade, detected_at",
      );
      const { rows: msg } = await q.query(
        "insert into messages (event_id, content) values ($1, $2) returning id",
        [ev[0].id, JSON.stringify([])],
      );
      return {
        eventId: ev[0].id as string,
        messageId: msg[0].id as string,
        kind: ev[0].kind as string,
        grade: ev[0].grade as string,
        detectedAt: (ev[0].detected_at as Date).toISOString(),
      };
    });
    await withService(async (q) => {
      await q.query(
        "insert into dispatches (message_id, event_id, sent_at, repeat_no, results) values ($1, $2, now(), 1, '[]')",
        [messageId, eventId],
      );
    });
    const agent = await agentAs("staff", "r@gonjiam.com");
    const res = await agent.get("/api/dispatches");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].kind).toBe(kind);
    expect(res.body[0].grade).toBe(grade);
    expect(new Date(res.body[0].detected_at).toISOString()).toBe(detectedAt);
  });

  // dispatches.content는 0004 마이그레이션이 나중에 추가한 nullable 스냅샷
  // 컬럼이라 그 이전 발송 이력에는 값이 없다 — History.tsx가 그때 messages.content로
  // 폴백하는 것과 같은 이유로, 서버는 폴백용 원본 필드를 message_content라는
  // 이름으로(내려주는 dispatches.content와 겹치지 않게) 함께 내려줘야 한다.
  it("content가 비어 있는 과거 발송 건은 message_content로 폴백할 원본을 함께 준다", async () => {
    const { eventId, messageId } = await makeEventAndMessage();
    const messageContent = [{ department_name: "시설", selected: true }];
    await withService(async (q) => {
      // messages.content를 makeEventAndMessage가 넣은 빈 배열 대신 실제 값으로 바꾼다.
      await q.query("update messages set content = $2 where id = $1", [messageId, JSON.stringify(messageContent)]);
      // dispatches.content는 명시적으로 null — 0004 이전 발송 이력을 흉내낸다.
      await q.query(
        "insert into dispatches (message_id, event_id, sent_at, repeat_no, results, content) values ($1, $2, now(), 1, '[]', null)",
        [messageId, eventId],
      );
    });
    const agent = await agentAs("staff", "s@gonjiam.com");
    const res = await agent.get("/api/dispatches");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // content 자체는 그대로 null이어야 한다 — 서버가 대신 채워 버리면(폴백을
    // 서버가 미리 해버리면) 화면의 "스냅샷 우선, 없으면 폴백" 판단 로직과
    // 어긋난다. 폴백은 별도 필드로만 제공한다.
    expect(res.body[0].content).toBeNull();
    expect(res.body[0].message_content).toEqual(messageContent);
  });

  // History.tsx(apps/web)는 `.eq("is_test", false)`로 테스트 발송을 아예 조회하지
  // 않는다 — "그때 누구에게 보냈나"를 확인하는 화면이라 테스트 발송이 실제
  // 발송처럼 섞이면 안 된다. 기본 호출(파라미터 없음)이 이 동작을 그대로
  // 유지하는지 확인한다: 실제 발송 1건 + 테스트 발송 1건을 만들고, 기본
  // 조회에는 실제 발송만 잡히는지, include_test=true를 주면 둘 다 잡히는지 본다.
  it("기본 조회는 테스트 발송을 제외하고, include_test=true면 포함한다", async () => {
    const { eventId, messageId } = await makeEventAndMessage();
    await withService(async (q) => {
      await q.query(
        `insert into dispatches (message_id, event_id, sent_at, repeat_no, results, is_test)
         values ($1, $2, now() - interval '2 hours', 1, '[]', false),
                ($1, $2, now() - interval '1 hours', 1, '[]', true)`,
        [messageId, eventId],
      );
    });
    const agent = await agentAs("staff", "t@gonjiam.com");

    const defaultRes = await agent.get("/api/dispatches");
    expect(defaultRes.status).toBe(200);
    // is_test 필터가 빠지면 두 건 다 나와 길이가 2가 된다.
    expect(defaultRes.body).toHaveLength(1);
    expect(defaultRes.body[0].is_test).toBe(false);

    const includeRes = await agent.get("/api/dispatches").query({ include_test: "true" });
    expect(includeRes.status).toBe(200);
    expect(includeRes.body).toHaveLength(2);
  });

  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/dispatches")).status).toBe(401);
  });
});
