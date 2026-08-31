import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import { runWeatherTick } from "../src/jobs/weatherTick.ts";
import { runRemindTick } from "../src/jobs/remindTick.ts";
import { runSend } from "../src/jobs/send.ts";
import type { NotificationChannel } from "../src/shared/channel.ts";

// HTTP 경로(POST /api/send)는 채널을 주입받지 않고 env로 고른다. 루트 .env에는
// KAKAOWORK_BOT_KEY가 들어 있어서 이걸 그대로 두면 테스트가 실제 카카오워크 API로
// 나간다 — 콘솔 채널로 못박는다.
process.env.NOTIFY_CHANNEL = "console";

const DEPT_PREFIX = "zzjob-dept-";

// 발송 내용을 그대로 모아 두는 채널. "발송했다/안 했다"를 눈으로 볼 수 있어야
// 권한 검사가 실제로 막고 있는지 증명할 수 있다.
function recorder() {
  const sent: { to: string; text: string }[] = [];
  const channel: NotificationChannel = {
    async send(to: string, text: string) {
      sent.push({ to, text });
      return { ok: true };
    },
  };
  return { sent, channel };
}

function kmaResponse(items: Array<Record<string, string | undefined>>) {
  return { response: { header: { resultCode: "00" }, body: { items: { item: items } } } };
}

function stubKma(items: Array<Record<string, string | undefined>>) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(kmaResponse(items))))));
}

const RAIN_32MM = [
  { category: "RN1", obsrValue: "32.5", baseDate: "20260812", baseTime: "0800" },
  { category: "T1H", obsrValue: "22" }, { category: "WSD", obsrValue: "2" },
  { category: "REH", obsrValue: "80" }, { category: "PTY", obsrValue: "1" },
];

beforeEach(async () => {
  await withService(async (q) => {
    // 참조 순서대로 지운다(dispatches → messages → events → observations).
    // db/seed.sql이 심는 site_settings·weather_criteria·alert_settings·departments는
    // 건드리지 않는다 — 지우면 판정 입력 자체가 사라진다.
    await q.query("delete from dispatches");
    await q.query("delete from messages");
    await q.query("delete from weather_events");
    await q.query("delete from weather_observations");
    await q.query("delete from heartbeats");
    await q.query("delete from auth_sessions");
    await q.query("delete from alert_recipients");
    await q.query("delete from recipients");
    await q.query("delete from action_guidelines");   // seed.sql은 지침을 심지 않는다
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees");
    await q.query("delete from departments where name like $1", [`${DEPT_PREFIX}%`]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function makeEmployee(opts: { name: string; email: string; kw?: string | null; role?: string }) {
  return withService(async (q) => {
    const { rows } = await q.query(
      "insert into employees (name, email, kakaowork_user_id, role) values ($1, $2, $3, $4) returning id",
      [opts.name, opts.email, opts.kw ?? null, opts.role ?? "staff"],
    );
    return rows[0].id as string;
  });
}

async function makeAlertRecipient(employeeId: string) {
  await withService((q) => q.query("insert into alert_recipients (employee_id) values ($1)", [employeeId]));
}

// 부서 + 지침 + 부서 수신자까지 한 벌 만들어 둔다. 이게 없으면 특보를 만들어도
// 발송 초안(messages.content)이 빈 배열이라 "누구에게 무엇이 나갔나"를 볼 수 없다.
async function makeDeptWithGuideline(kind: string, grade: string, empId: string) {
  return withService(async (q) => {
    const { rows } = await q.query(
      "insert into departments (name) values ($1) returning id", [`${DEPT_PREFIX}객실`]);
    const deptId = rows[0].id as string;
    await q.query(
      `insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice)
       values ($1, $2, $3, $4, $5)`,
      [deptId, kind, grade, ["수건 2개 배포"], "안내문"],
    );
    await q.query("insert into recipients (department_id, employee_id) values ($1, $2)", [deptId, empId]);
    return deptId;
  });
}

describe("관측 수집", () => {
  it("수집에 성공하면 관측을 저장하고 수집 시각을 남긴다", async () => {
    stubKma([]);
    const out = await runWeatherTick({ channel: recorder().channel });
    expect(out.collected).toBe(true);

    const beat = await withService(async (q) => {
      const { rows } = await q.query("select last_run_at, ok from heartbeats where name = 'weather-tick'");
      return rows[0];
    });
    expect(beat).toBeTruthy();
    expect(beat.ok).toBe(true);
  });

  // 기상청이 실패했을 때 조용히 넘어가면 화면은 옛 값을 최신인 양 보여준다.
  it("수집에 실패하면 결측으로 기록한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const out = await runWeatherTick({ channel: recorder().channel });
    expect(out.collected).toBe(false);

    const rows = await withService(async (q) => {
      const { rows } = await q.query("select missing from weather_observations order by observed_at desc limit 1");
      return rows;
    });
    expect(rows[0]?.missing).toBe(true);

    const beat = await withService(async (q) => {
      const { rows } = await q.query("select ok, note from heartbeats where name = 'weather-tick'");
      return rows[0];
    });
    expect(beat.ok).toBe(false);
    expect(beat.note).toBe("missing");
  });

  it("관측값을 파생값(체감온도·신적설)까지 계산해 저장한다", async () => {
    stubKma([
      { category: "RN1", obsrValue: "3", baseDate: "20260212", baseTime: "0800" },
      { category: "T1H", obsrValue: "-5" }, { category: "WSD", obsrValue: "5" },
      { category: "REH", obsrValue: "50" }, { category: "PTY", obsrValue: "3" },  // PTY=3 → 눈
    ]);
    await runWeatherTick({ channel: recorder().channel });
    const row = await withService(async (q) => {
      const { rows } = await q.query("select temp_c, snow_new_cm, feels_c, missing from weather_observations");
      return rows[0];
    });
    expect(row.missing).toBe(false);
    expect(Number(row.temp_c)).toBe(-5);
    // PTY=3(눈)이므로 3mm는 3cm로 환산된다 — 비(PTY=1)였다면 0이어야 한다.
    expect(Number(row.snow_new_cm)).toBe(3);
    // 겨울 체감식(풍속 5m/s)이 실제로 걸렸는지: 기온보다 확실히 낮아야 한다.
    expect(Number(row.feels_c)).toBeLessThan(-9);
  });

  // 결측이 이어지는데 아무도 모르면 화면은 몇 시간이고 옛 값을 붙들고 있게 된다.
  it("결측이 2회까지는 관리자에게 알리지 않는다", async () => {
    await makeEmployee({ name: "관리자", email: "jobs-admin@gonjiam.com", kw: "kw-admin", role: "admin" });
    await withService((q) =>
      q.query("insert into weather_observations (observed_at, missing) values (now() - interval '2 hours', true)"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const rec = recorder();
    await runWeatherTick({ channel: rec.channel });
    expect(rec.sent).toEqual([]);
  });

  it("결측이 3회 연속이면 관리자에게 알린다", async () => {
    await makeEmployee({ name: "관리자", email: "jobs-admin2@gonjiam.com", kw: "kw-admin", role: "admin" });
    // 카카오워크 미연결 관리자는 보낼 곳이 없다 — 수신자 목록에 끼면 안 된다.
    await makeEmployee({ name: "미연결관리자", email: "jobs-admin3@gonjiam.com", kw: null, role: "admin" });
    await withService((q) =>
      q.query(
        `insert into weather_observations (observed_at, missing) values
           (now() - interval '3 hours', true), (now() - interval '2 hours', true)`,
      ),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const rec = recorder();
    await runWeatherTick({ channel: rec.channel });
    expect(rec.sent.map((s) => s.to)).toEqual(["kw-admin"]);
    expect(rec.sent[0]!.text).toContain("3시간 연속");
  });
});

describe("특보 판정", () => {
  it("기준을 넘으면 특보·발송 초안을 만들고 알림 수신자에게 승인 요청을 보낸다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "jobs-staff@gonjiam.com", kw: "kw-staff" });
    const approver = await makeEmployee({ name: "사업부장", email: "jobs-appr@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    await makeDeptWithGuideline("rain", "watch", staff);

    stubKma(RAIN_32MM);
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    expect(out.actions).toEqual([{ type: "create", kind: "rain", grade: "watch" }]);

    const { ev, msg } = await withService(async (q) => {
      const { rows: evRows } = await q.query("select id, kind, grade, status, trigger_observation_id from weather_events");
      const { rows: msgRows } = await q.query("select event_id, status, content from messages");
      return { ev: evRows[0], msg: msgRows[0] };
    });
    expect(ev.status).toBe("PENDING_APPROVAL");
    expect(ev.kind).toBe("rain");
    // 특보가 어떤 관측 때문에 났는지 짚을 수 있어야 한다(화면이 이 id로 관측을 다시 읽는다).
    expect(ev.trigger_observation_id).not.toBe(null);
    expect(msg.status).toBe("draft");
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.recipients).toEqual([
      { employee_id: staff, name: "객실직원", kakaowork_user_id: "kw-staff" },
    ]);

    // 승인 요청은 알림 수신자에게만 간다 — 부서 수신자(kw-staff)에게 미리 나가면 안 된다.
    expect(rec.sent.map((s) => s.to)).toEqual(["kw-appr"]);
    expect(rec.sent[0]!.text).toContain("폭우 주의보");
    expect(rec.sent[0]!.text).toContain(`/events/${ev.id}`);
  });

  it("승인 대기 중 비가 그치면 특보를 자동 종료하고 알림 수신자에게 알린다", async () => {
    const approver = await makeEmployee({ name: "사업부장", email: "jobs-appr2@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    await withService((q) =>
      q.query("insert into weather_events (kind, grade, status) values ('rain','watch','PENDING_APPROVAL')"));

    stubKma([
      { category: "RN1", obsrValue: "0", baseDate: "20260812", baseTime: "0900" },
      { category: "T1H", obsrValue: "22" }, { category: "WSD", obsrValue: "2" }, { category: "REH", obsrValue: "80" },
    ]);
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    expect(out.actions.map((a) => a.type)).toEqual(["resolve"]);

    const ev = await withService(async (q) => {
      const { rows } = await q.query("select status, closed_at from weather_events");
      return rows[0];
    });
    expect(ev.status).toBe("RESOLVED");
    expect(ev.closed_at).not.toBe(null);
    expect(rec.sent.map((s) => s.to)).toEqual(["kw-appr"]);
    expect(rec.sent[0]!.text).toContain("자동 종료");
  });

  it("승인된 특보가 이어지면 회차를 올려 반복 발송하고 이력을 남긴다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "jobs-staff3@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId } = await withService(async (q) => {
      const { rows: ev } = await q.query(
        `insert into weather_events (kind, grade, status, repeat_count)
         values ('rain','watch','ACTIVE', 1) returning id`);
      await q.query(
        "insert into messages (event_id, status, content) values ($1, 'approved', $2::jsonb)",
        [ev[0].id, JSON.stringify([{ department_id: deptId, department_name: "객실",
          staff_actions: ["수건 2개 배포"], guest_notice: "안내문",
          recipients: [{ employee_id: staff, name: "객실직원", kakaowork_user_id: "kw-staff" }],
          selected: true }])],
      );
      return { eventId: ev[0].id as string };
    });

    stubKma(RAIN_32MM);
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    expect(out.actions).toEqual([{ type: "repeat", eventId, kind: "rain", grade: "watch" }]);
    expect(rec.sent.map((s) => s.to)).toEqual(["kw-staff"]);
    expect(rec.sent[0]!.text).toContain("수건 2개 배포");

    const { d, ev } = await withService(async (q) => {
      const { rows: dRows } = await q.query("select repeat_no, results, content, is_test from dispatches");
      const { rows: evRows } = await q.query("select repeat_count from weather_events where id = $1", [eventId]);
      return { d: dRows[0], ev: evRows[0] };
    });
    // 승인 발송이 1회차였으므로 이번 반복은 2회차다(dispatches 건수가 아니라 repeat_count 기준).
    expect(d.repeat_no).toBe(2);
    expect(ev.repeat_count).toBe(2);
    expect(d.is_test).toBe(false);
    expect(d.results).toHaveLength(1);
    expect(d.results[0]!.ok).toBe(true);
    // 발송 시점 스냅샷이 남아야 재발송으로 본문이 바뀌어도 과거 이력이 보존된다.
    expect(d.content).toHaveLength(1);
  });
});

describe("승인 재알림", () => {
  it("재알림 주기가 지난 승인 대기 특보만 재알림한다", async () => {
    const approver = await makeEmployee({ name: "사업부장", email: "jobs-appr4@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    const { oldId, freshId } = await withService(async (q) => {
      const { rows: o } = await q.query(
        `insert into weather_events (kind, grade, status, detected_at)
         values ('rain','watch','PENDING_APPROVAL', now() - interval '2 hours') returning id`);
      const { rows: f } = await q.query(
        `insert into weather_events (kind, grade, status, detected_at)
         values ('snow','watch','PENDING_APPROVAL', now()) returning id`);
      return { oldId: o[0].id as string, freshId: f[0].id as string };
    });

    const rec = recorder();
    const out = await runRemindTick({ channel: rec.channel });
    expect(out.reminded).toBe(1);
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]!.text).toContain("(재알림)");
    expect(rec.sent[0]!.text).toContain(`/events/${oldId}`);

    const rows = await withService(async (q) => {
      const { rows } = await q.query("select id, last_reminded_at from weather_events");
      return rows;
    });
    expect(rows.find((r: any) => r.id === oldId).last_reminded_at).not.toBe(null);
    // 방금 감지된 건은 아직 주기가 지나지 않았다 — 여기가 null이 아니면 필터가 사라진 것이다.
    expect(rows.find((r: any) => r.id === freshId).last_reminded_at).toBe(null);

    const beat = await withService(async (q) => {
      const { rows } = await q.query("select ok from heartbeats where name = 'remind-tick'");
      return rows[0];
    });
    expect(beat.ok).toBe(true);
  });

  it("승인 대기가 아닌 특보는 재알림하지 않는다", async () => {
    const approver = await makeEmployee({ name: "사업부장", email: "jobs-appr5@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    await withService((q) =>
      q.query(
        `insert into weather_events (kind, grade, status, detected_at)
         values ('rain','watch','ACTIVE', now() - interval '2 hours')`));
    const rec = recorder();
    expect((await runRemindTick({ channel: rec.channel })).reminded).toBe(0);
    expect(rec.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/send — 화면이 부르던 functions.invoke("send")의 자리
// ---------------------------------------------------------------------------

// 로그인한 에이전트를 만든다. signup이 employees 행까지 만들어 주므로 그 뒤에
// 역할·카카오워크 id만 손본다.
async function agentAs(opts: { email: string; role?: string; kw?: string | null }) {
  const who = { email: opts.email, password: "send-password-1", name: "테스트" };
  await request(app).post("/api/auth/signup").send(who);
  const employeeId = await withService(async (q) => {
    const { rows } = await q.query(
      "update employees set role = $2, kakaowork_user_id = $3 where email = $1 returning id",
      [opts.email, opts.role ?? "staff", opts.kw ?? null],
    );
    return rows[0].id as string;
  });
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return { agent, employeeId };
}

async function pendingEventWithDraft(deptId: string, staffId: string) {
  return withService(async (q) => {
    const content = [{ department_id: deptId, department_name: "객실",
      staff_actions: ["수건 2개 배포"], guest_notice: "안내문",
      recipients: [{ employee_id: staffId, name: "객실직원", kakaowork_user_id: "kw-staff" }],
      selected: true }];
    const { rows: obs } = await q.query(
      `insert into weather_observations (observed_at, rain_mm_per_hr, temp_c, feels_c, wind_ms)
       values (now(), 32.5, 22, 24, 2) returning id`);
    const { rows: ev } = await q.query(
      `insert into weather_events (kind, grade, status, trigger_observation_id)
       values ('rain','watch','PENDING_APPROVAL', $1) returning id`, [obs[0].id]);
    const { rows: msg } = await q.query(
      "insert into messages (event_id, content) values ($1, $2::jsonb) returning id",
      [ev[0].id, JSON.stringify(content)]);
    return { eventId: ev[0].id as string, messageId: msg[0].id as string, content };
  });
}

const state = () =>
  withService(async (q) => {
    const { rows: ev } = await q.query("select status, repeat_count from weather_events");
    const { rows: msg } = await q.query("select status from messages");
    const { rows: d } = await q.query("select repeat_no, is_test from dispatches");
    return { event: ev[0], message: msg[0], dispatches: d };
  });

describe("POST /api/send — 권한", () => {
  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).post("/api/send").send({ mode: "dismiss", event_id: "x" })).status).toBe(401);
  });

  // 이 검사가 빠지면 로그인한 아무나 전 직원에게 발송할 수 있게 된다.
  it("알림 수신자가 아니면 승인할 수 없고 아무에게도 발송되지 않는다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-staff@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId, content } = await pendingEventWithDraft(deptId, staff);
    // 역할은 approver인데 alert_recipients에는 없다 — 역할이 아니라 등록 여부가 관문이다.
    const { agent } = await agentAs({ email: "send-nonrecip@gonjiam.com", role: "approver" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await agent.post("/api/send").send({ mode: "approve", event_id: eventId, content });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);

    // 403이 다른 이유로 우연히 난 게 아님을 상태로 확인한다.
    const s = await state();
    expect(s.event.status).toBe("PENDING_APPROVAL");
    expect(s.message.status).toBe("draft");
    expect(s.dispatches).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("알림 수신자면 역할이 staff여도 승인·발송할 수 있다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-staff2@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId, content } = await pendingEventWithDraft(deptId, staff);
    const { agent, employeeId } = await agentAs({ email: "send-recip@gonjiam.com", role: "staff" });
    await makeAlertRecipient(employeeId);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await agent.post("/api/send").send({ mode: "approve", event_id: eventId, content });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fail_count).toBe(0);

    const s = await state();
    expect(s.event.status).toBe("ACTIVE");
    // 승인 발송이 1회차 — 회차 채번의 단일 소스는 weather_events.repeat_count다.
    expect(s.event.repeat_count).toBe(1);
    expect(s.message.status).toBe("approved");
    expect(s.dispatches).toEqual([{ repeat_no: 1, is_test: false }]);
    // 실제로 부서 수신자에게 나갔는지 — 관측 줄까지 붙어야 한다(스펙 결정 11).
    const text = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("kw-staff");
    expect(text).toContain("수건 2개 배포");
    expect(text).toContain("시간당 32.5mm");
  });

  // 이 검사가 빠지면 관리자가 아닌 사람도 봇 발송을 마음대로 시험해 볼 수 있다.
  it("관리자가 아니면 테스트 발송을 할 수 없다", async () => {
    // 알림 수신자로 등록까지 해 둔다 — 그래도 막혀야 role 검사가 실제로 걸린 것이다.
    const { agent, employeeId } = await agentAs({ email: "send-nonadmin@gonjiam.com", role: "approver", kw: "kw-me" });
    await makeAlertRecipient(employeeId);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await agent.post("/api/send").send({ mode: "test" });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("관리자는 알림 수신자가 아니어도 테스트 발송을 할 수 있다", async () => {
    const { agent } = await agentAs({ email: "send-admin@gonjiam.com", role: "admin", kw: "kw-admin" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await agent.post("/api/send").send({ mode: "test" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("테스트 메시지입니다");
  });

  it("카카오워크가 연결되지 않은 관리자의 테스트 발송은 400이다", async () => {
    const { agent } = await agentAs({ email: "send-admin2@gonjiam.com", role: "admin", kw: null });
    const res = await agent.post("/api/send").send({ mode: "test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("카카오워크 미연결");
  });
});

describe("POST /api/send — 모드별 동작", () => {
  async function recipientAgent(email: string) {
    const { agent, employeeId } = await agentAs({ email, role: "staff" });
    await makeAlertRecipient(employeeId);
    return agent;
  }

  it("승인 대기가 아닌 특보는 승인할 수 없다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-staff3@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId, content } = await pendingEventWithDraft(deptId, staff);
    await withService((q) => q.query("update weather_events set status='ACTIVE' where id=$1", [eventId]));
    const agent = await recipientAgent("send-recip2@gonjiam.com");

    const res = await agent.post("/api/send").send({ mode: "approve", event_id: eventId, content });
    expect(res.status).toBe(409);
    expect((await state()).dispatches).toEqual([]);
  });

  it("무시는 승인 대기 특보만 처리하고 두 번째는 409다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-staff4@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId } = await pendingEventWithDraft(deptId, staff);
    const agent = await recipientAgent("send-recip3@gonjiam.com");

    expect((await agent.post("/api/send").send({ mode: "dismiss", event_id: eventId })).status).toBe(200);
    expect((await state()).event.status).toBe("DISMISSED");
    const again = await agent.post("/api/send").send({ mode: "dismiss", event_id: eventId });
    expect(again.status).toBe(409);
  });

  it("재발송은 회차를 올려 새 이력을 남긴다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-staff5@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId, messageId, content } = await pendingEventWithDraft(deptId, staff);
    await withService((q) =>
      q.query("update weather_events set status='ACTIVE', repeat_count=1 where id=$1", [eventId]));
    await withService((q) => q.query("update messages set status='approved' where id=$1", [messageId]));
    const agent = await recipientAgent("send-recip4@gonjiam.com");

    const res = await agent.post("/api/send").send({ mode: "resend", message_id: messageId, content });
    expect(res.status).toBe(200);
    expect(res.body.repeat_no).toBe(2);
    const s = await state();
    expect(s.event.repeat_count).toBe(2);
    expect(s.dispatches).toEqual([{ repeat_no: 2, is_test: false }]);
  });

  // 채널이 실패했을 때 4xx로 바꿔 버리면 클라이언트가 throw해서 Settings.tsx의
  // "테스트 발송에 실패했습니다" 분기(result.ok === false)가 영영 돌지 않는다.
  it("테스트 발송이 채널에서 실패하면 200에 ok:false로 돌려준다", async () => {
    const admin = await makeEmployee({ name: "관리자", email: "send-admin3@gonjiam.com", kw: "kw-admin", role: "admin" });
    const out = await runSend({ mode: "test" }, admin, {
      channel: { async send() { return { ok: false, error: "invalid user" }; } },
    });
    expect(out).toEqual({ ok: false, status: 200, error: "invalid user" });
  });

  it("모르는 mode는 400이다", async () => {
    const agent = await recipientAgent("send-recip5@gonjiam.com");
    expect((await agent.post("/api/send").send({ mode: "nope" })).status).toBe(400);
  });
});
