import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import { runWeatherTick, upsertHeartbeat } from "../src/jobs/weatherTick.ts";
import { runRemindTick } from "../src/jobs/remindTick.ts";
import { runSend } from "../src/jobs/send.ts";
import { checkHealth } from "../src/jobs/watchdog.ts";
import type { NotificationChannel } from "../src/shared/channel.ts";

// HTTP 경로(POST /api/send)는 채널을 주입받지 않고 env로 고른다. 루트 .env에는
// KAKAOWORK_BOT_KEY가 들어 있어서 이걸 그대로 두면 테스트가 실제 카카오워크 API로
// 나간다 — 콘솔 채널로 못박는다.
process.env.NOTIFY_CHANNEL = "console";

const DEPT_PREFIX = "zzjob-dept-";
const here = dirname(fileURLToPath(import.meta.url));

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
    // resolve_notice는 시드 기본값이 true다. 아래 해제 알림 테스트가 이 값을 뒤집으므로
    // 매 테스트 시작 시 기본값으로 되돌린다 — 시드를 지우는 게 아니라 되돌리는 것이다.
    await q.query("update site_settings set resolve_notice = true where id = 1");
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

// ---------------------------------------------------------------------------
// 판정 결과를 DB에 반영하는 부분. 판정 엔진이 어떤 액션을 내는지는 engine.test.ts가
// 잡지만, 그 액션을 받아 무엇을 쓰는지는 여기서만 잡힌다.
// ---------------------------------------------------------------------------

describe("특보 승격(escalate)", () => {
  it("경보로 승격하면 기존 주의보를 닫고 경보 초안을 새로 만든다", async () => {
    const approver = await makeEmployee({ name: "사업부장", email: "jobs-esc-appr@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    const staff = await makeEmployee({ name: "객실직원", email: "jobs-esc-staff@gonjiam.com", kw: "kw-staff" });
    await makeDeptWithGuideline("rain", "warning", staff);
    const watchId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into weather_events (kind, grade, status) values ('rain','watch','ACTIVE') returning id");
      return rows[0].id as string;
    });

    // 시드 기준: rain warning은 50mm/h. 55면 watch가 warning으로 승격된다.
    stubKma([
      { category: "RN1", obsrValue: "55", baseDate: "20260812", baseTime: "1000" },
      { category: "T1H", obsrValue: "22" }, { category: "WSD", obsrValue: "2" }, { category: "REH", obsrValue: "90" },
    ]);
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    expect(out.actions).toEqual([{ type: "escalate", eventId: watchId, kind: "rain" }]);

    const rows = await withService(async (q) => {
      const { rows } = await q.query("select id, grade, status, closed_at from weather_events order by grade");
      return rows;
    });
    expect(rows).toHaveLength(2);
    // 승격된 주의보가 닫히지 않으면 같은 kind로 열린 특보가 둘 남아 대시보드에 유령이 생기고,
    // 다음 tick의 판정 입력에도 계속 열린 것으로 실린다.
    const watch = rows.find((r: any) => r.id === watchId);
    expect(watch.status).toBe("ESCALATED");
    expect(watch.closed_at).not.toBe(null);

    const warning = rows.find((r: any) => r.id !== watchId);
    expect(warning.grade).toBe("warning");
    expect(warning.status).toBe("PENDING_APPROVAL");
    // 경보 초안이 실제로 만들어지고 승인 요청까지 나갔는지.
    const msgs = await withService(async (q) => {
      const { rows } = await q.query("select event_id from messages");
      return rows;
    });
    expect(msgs.map((m: any) => m.event_id)).toEqual([warning.id]);
    expect(rec.sent.map((x) => x.to)).toEqual(["kw-appr"]);
    expect(rec.sent[0]!.text).toContain("폭우 경보");
  });
});

describe("해제 알림(resolve_notice)", () => {
  // 승인 발송을 받았던 부서 수신자에게 해제 알림을 보낼지 말지는 site_settings가 정한다.
  // 이 분기가 뒤집혀도 아무도 모르면, 껐는데 전원에게 나가거나 켰는데 아무에게도 안 나간다.
  async function resolvedActiveEvent() {
    const staff = await makeEmployee({ name: "객실직원", email: "jobs-rn-staff@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    await withService(async (q) => {
      const { rows: ev } = await q.query(
        "insert into weather_events (kind, grade, status, repeat_count) values ('rain','watch','ACTIVE',1) returning id");
      await q.query(
        "insert into messages (event_id, status, content) values ($1, 'approved', $2::jsonb)",
        [ev[0].id, JSON.stringify([{ department_id: deptId, department_name: "객실",
          staff_actions: ["수건 2개 배포"], guest_notice: "안내문",
          recipients: [{ employee_id: staff, name: "객실직원", kakaowork_user_id: "kw-staff" }],
          selected: true }])],
      );
    });
    // 비가 그쳤다 → resolve
    stubKma([
      { category: "RN1", obsrValue: "0", baseDate: "20260812", baseTime: "1100" },
      { category: "T1H", obsrValue: "22" }, { category: "WSD", obsrValue: "2" }, { category: "REH", obsrValue: "70" },
    ]);
  }

  it("켜져 있으면 발송받았던 부서 수신자에게 해제 알림을 보낸다", async () => {
    await resolvedActiveEvent();
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    expect(out.actions.map((a) => a.type)).toEqual(["resolve"]);
    expect(rec.sent.map((x) => x.to)).toEqual(["kw-staff"]);
    expect(rec.sent[0]!.text).toContain("해제되었습니다");
  });

  it("꺼져 있으면 해제 알림을 보내지 않는다 (특보는 그대로 종료된다)", async () => {
    await resolvedActiveEvent();
    await withService((q) => q.query("update site_settings set resolve_notice = false where id = 1"));
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    // 알림만 끄는 설정이지 해제 자체를 멈추는 설정이 아니다 — 상태 전이는 그대로여야 한다.
    expect(out.actions.map((a) => a.type)).toEqual(["resolve"]);
    const ev = await withService(async (q) => {
      const { rows } = await q.query("select status from weather_events");
      return rows[0];
    });
    expect(ev.status).toBe("RESOLVED");
    expect(rec.sent).toEqual([]);
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
// 폭설 반복·해제 — 눈이 그쳤는데 자정까지 매시간 반복되던 문제 (QA W-04)
// ---------------------------------------------------------------------------
//
// 폭설 판정은 **당일 누적 적설**(snowToday)을 본다. 그런데 시드의 정책이
// hourly_until_below("매시간 관측이 기준 미만이면 해제")였다. 누적값은 눈이 그쳐도
// 자정까지 줄지 않으므로 반복은 항상 참, 해제는 항상 거짓이 된다 — QA 실측으로
// 신적설 0인데 반복 발송 3회. 정책 값 하나가 바뀌면 동작이 통째로 뒤집히므로,
// **두 정책을 같은 상황에 놓고 대조**해 무엇이 그 차이를 만드는지 고정한다.
describe("폭설 반복·해제", () => {
  let originalPolicy: { policy: string; accum: string | null };

  beforeEach(async () => {
    originalPolicy = await withService(async (q) => {
      const { rows } = await q.query(
        "select repeat_policy, repeat_accum_threshold from alert_settings where kind = 'snow'");
      return { policy: rows[0].repeat_policy as string, accum: rows[0].repeat_accum_threshold as string | null };
    });
  });

  // 시드는 지우지 않는다 — 테스트가 바꾼 값을 원래대로 되돌린다(resolve_notice와 같은 방식).
  afterEach(async () => {
    await withService((q) =>
      q.query(
        "update alert_settings set repeat_policy = $1, repeat_accum_threshold = $2 where kind = 'snow'",
        [originalPolicy.policy, originalPolicy.accum],
      ));
  });

  async function setSnowPolicy(policy: string) {
    await withService((q) =>
      q.query(
        "update alert_settings set repeat_policy = $1, repeat_accum_threshold = null where kind = 'snow'",
        [policy],
      ));
  }

  /** 오늘(KST) 누적 적설 6cm — 폭설 주의보 기준(5cm)을 이미 넘긴 상태를 만든다. */
  async function snowedTodayThenStopped(staffId: string) {
    return withService(async (q) => {
      const { rows: d } = await q.query(
        "insert into departments (name) values ($1) returning id", [`${DEPT_PREFIX}제설`]);
      const deptId = d[0].id as string;
      await q.query("insert into recipients (department_id, employee_id) values ($1, $2)", [deptId, staffId]);
      // 오늘 자정 이후의 유효 관측(누적 6cm).
      await q.query(
        `insert into weather_observations (observed_at, rain_mm_per_hr, snow_new_cm, temp_c, wind_ms, missing)
         values (now() - interval '20 minutes', 6, 6, -1, 2, false)`);
      const { rows: ev } = await q.query(
        `insert into weather_events (kind, grade, status, repeat_count)
         values ('snow','watch','ACTIVE', 1) returning id`);
      await q.query(
        "insert into messages (event_id, status, content) values ($1, 'approved', $2::jsonb)",
        [ev[0].id, JSON.stringify([{ department_id: deptId, department_name: "제설",
          staff_actions: ["제설 장비 투입"], guest_notice: "",
          recipients: [{ employee_id: staffId, name: "제설담당", kakaowork_user_id: "kw-snow" }],
          selected: true }])],
      );
      return ev[0].id as string;
    });
  }

  /** 눈이 그친 관측(PTY=1 비, 강수 0) — 신적설 0이지만 오늘 누적은 그대로 6cm다. */
  const SNOW_STOPPED = [
    { category: "RN1", obsrValue: "0", baseDate: "20260812", baseTime: "1500" },
    { category: "PTY", obsrValue: "1" }, { category: "T1H", obsrValue: "1" },
    { category: "WSD", obsrValue: "2" }, { category: "REH", obsrValue: "80" },
  ];

  it("눈이 그치면 폭설 특보를 해제한다 (반복하지 않는다)", async () => {
    const staff = await makeEmployee({ name: "제설담당", email: "snow-stop@gonjiam.com", kw: "kw-snow" });
    const eventId = await snowedTodayThenStopped(staff);
    await setSnowPolicy("until_daily_accum_below");

    stubKma(SNOW_STOPPED);
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    expect(out.actions).toEqual([{ type: "resolve", eventId, kind: "snow", grade: "watch" }]);

    const { ev, dispatches } = await withService(async (q) => {
      const { rows } = await q.query("select status from weather_events where id = $1", [eventId]);
      const { rows: d } = await q.query("select id from dispatches");
      return { ev: rows[0], dispatches: d };
    });
    expect(ev.status).toBe("RESOLVED");
    // 반복 발송이 한 건도 없어야 한다 — 이게 QA가 본 "신적설 0인데 반복 3회"의 반대다.
    expect(dispatches).toEqual([]);
  });

  // 대조군 겸 회귀 증인: 정책 값이 예전(hourly_until_below)이면 같은 상황에서
  // 해제 대신 반복이 나온다. 이 테스트가 깨지면 QA가 본 버그가 되살아난 것이다.
  it("예전 정책(hourly_until_below)이면 같은 상황에서 반복 발송이 나간다", async () => {
    const staff = await makeEmployee({ name: "제설담당", email: "snow-old@gonjiam.com", kw: "kw-snow" });
    const eventId = await snowedTodayThenStopped(staff);
    await setSnowPolicy("hourly_until_below");

    stubKma(SNOW_STOPPED);
    const out = await runWeatherTick({ channel: recorder().channel });
    expect(out.actions).toEqual([{ type: "repeat", eventId, kind: "snow", grade: "watch" }]);
  });

  it("아직 눈이 내리는 중이면 반복 발송을 계속한다", async () => {
    const staff = await makeEmployee({ name: "제설담당", email: "snow-cont@gonjiam.com", kw: "kw-snow" });
    const eventId = await snowedTodayThenStopped(staff);
    await setSnowPolicy("until_daily_accum_below");

    stubKma([
      { category: "RN1", obsrValue: "2", baseDate: "20260812", baseTime: "1600" },
      { category: "PTY", obsrValue: "3" }, { category: "T1H", obsrValue: "-2" },
      { category: "WSD", obsrValue: "2" }, { category: "REH", obsrValue: "90" },
    ]);
    const rec = recorder();
    const out = await runWeatherTick({ channel: rec.channel });
    expect(out.actions).toEqual([{ type: "repeat", eventId, kind: "snow", grade: "watch" }]);
    // 폭설 메시지에 적설량이 없으면 받는 사람은 얼마나 왔는지 모른다.
    expect(rec.sent[0]!.text).toMatch(/신적설 2cm/);
    expect(rec.sent[0]!.text).toMatch(/오늘 누적 6cm/);
  });

  // 시드 값 자체를 고정한다. 위 두 테스트는 정책을 직접 세팅하므로, 정작 배포되는
  // 기본값이 예전 값으로 되돌아가도 통과한다 — 그 구멍을 파일 내용으로 막는다.
  it("시드와 마이그레이션이 폭설 정책을 누적용으로 심는다", () => {
    const dbDir = join(here, "..", "..", "db");
    const seed = readFileSync(join(dbDir, "seed.sql"), "utf8");
    // 한 줄에 rain과 snow가 함께 있으므로 줄 단위로 보면 안 된다 — rain의
    // until_daily_accum_below 때문에 snow가 옛 값이어도 통과한다(실제로 그 변이가 살아남았다).
    expect(seed).toMatch(/\('snow','until_daily_accum_below'/);
    expect(seed).not.toMatch(/\('snow','hourly_until_below'/);
    // 이미 배포된 데이터베이스는 시드를 다시 돌리지 않는다(ops/migrate.sh) —
    // 마이그레이션이 없으면 운영 DB는 영원히 옛 값 그대로다.
    const mig = readFileSync(join(dbDir, "migrations", "0015_snow_repeat_policy.sql"), "utf8");
    expect(mig).toMatch(/update alert_settings/);
    expect(mig).toMatch(/until_daily_accum_below/);
    expect(mig).toMatch(/kind = 'snow'/);
  });
});

// ---------------------------------------------------------------------------
// 기상청 응답 형식이 바뀌면 — "정상 수집 + 전부 null"로 굳는 조용한 고장
// ---------------------------------------------------------------------------
//
// 공공데이터포털이 category 코드를 바꾸거나(RN1 → RN01) items.item을 빈 배열로 주면
// HTTP 200 + resultCode "00"이라 shared/kma.ts의 파서가 예외 없이 전부 null을 준다.
// weatherTick은 그걸 missing=false로 저장하고, heartbeat은 매시간 신선하다.
// 값만 전부 비어 있어 판정 엔진이 액션을 0건 낸다 — 폭우가 와도 특보가 영원히 안 뜨는데
// 화면·health·워치독이 전부 초록이다. shared/는 바이트 동일성 때문에 못 고치므로
// 워치독이 이 상태를 사유로 잡아야 한다. 파서 단위가 아니라 실제 tick → 저장 →
// checkHealth 경로 전체로 확인한다.
describe("기상청 응답 형식이 바뀌면", () => {
  /** 폭우 32.5mm인데 category 이름만 바뀐 응답. */
  function renamedCategories(baseTime: string) {
    return [
      { category: "RN01", obsrValue: "32.5", baseDate: "20260812", baseTime },
      { category: "T01H", obsrValue: "22" }, { category: "WSD10", obsrValue: "2" },
      { category: "REH00", obsrValue: "80" }, { category: "PTY0", obsrValue: "1" },
    ];
  }

  it("관측은 정상으로 쌓이고 특보는 안 뜨는데, 워치독이 그것을 잡는다", async () => {
    for (const t of ["0600", "0700", "0800"]) {
      stubKma(renamedCategories(t));
      const out = await runWeatherTick({ channel: recorder().channel });
      // 함정의 핵심: 결측이 아니다. 수집은 "성공"이다.
      expect(out.collected).toBe(true);
      // 그런데 32.5mm 폭우인데 액션이 0건이다.
      expect(out.actions).toEqual([]);
    }

    const rows = await withService(async (q) => {
      const { rows } = await q.query(
        "select missing, rain_mm_per_hr, temp_c from weather_observations order by observed_at desc");
      return rows;
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.missing === false)).toBe(true);
    expect(rows.every((r: any) => r.rain_mm_per_hr === null && r.temp_c === null)).toBe(true);

    const health = await checkHealth();
    expect(health.ok).toBe(false);
    expect(health.reasons.join()).toMatch(/값이 전부 비어/);
  });

  it("대조군 — 형식이 그대로면 특보가 뜨고 상태 점검도 정상이다", async () => {
    const approver = await makeEmployee({ name: "사업부장", email: "jobs-kma1@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    for (const t of ["0600", "0700", "0800"]) {
      stubKma([
        { category: "RN1", obsrValue: "32.5", baseDate: "20260812", baseTime: t },
        { category: "T1H", obsrValue: "22" }, { category: "WSD", obsrValue: "2" },
        { category: "REH", obsrValue: "80" }, { category: "PTY", obsrValue: "1" },
      ]);
      await runWeatherTick({ channel: recorder().channel });
    }
    const events = await withService(async (q) => {
      const { rows } = await q.query("select kind from weather_events");
      return rows;
    });
    expect(events.length).toBeGreaterThan(0);
    const health = await checkHealth();
    expect(health.reasons.join()).not.toMatch(/값이 전부 비어/);
  });
});

// ---------------------------------------------------------------------------
// 시계 도메인 — 앱(Node)과 DB(Postgres)의 시계를 섞지 않는다
// ---------------------------------------------------------------------------
//
// 이 프로젝트는 같은 실수를 세 번 했다(계정 잠금 2fc6b13, catchUpIfMissed,
// 그리고 태스크 10의 remindTick 이관). 앱 컨테이너 시계가 DB보다 어긋나면
// (VM 재개·NTP 사고) 재알림이 어긋나고, heartbeat이 미래로 찍혀 수집이 완전히
// 멈춰도 워치독이 드리프트만큼 늦게 깨어난다.
//
// 두 시계를 실제로 어긋나게 만들어 확인한다: Date만 가짜로 바꾸고(pg의 타이머는
// 건드리지 않는다) 시각 판정이 그대로 옳은지 본다. 판정이 Node의 Date를 쓰면
// 아래 두 테스트는 실패한다(변이로 확인함).
describe("시계 도메인", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 앱 시계만 delta만큼 어긋나게 만든다. pg가 쓰는 setTimeout 등은 그대로 둔다. */
  function skewAppClock(ms: number) {
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(realNow + ms));
  }

  it("앱 시계가 이틀 뒤처져도 재알림 주기는 DB 시계로 판정한다", async () => {
    const approver = await makeEmployee({ name: "사업부장", email: "jobs-clock1@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    const id = await withService(async (q) => {
      const { rows } = await q.query(
        `insert into weather_events (kind, grade, status, detected_at)
         values ('rain','watch','PENDING_APPROVAL', now() - interval '2 hours') returning id`);
      return rows[0].id as string;
    });

    // 앱 시계가 이틀 뒤처져 있다. Node의 new Date()로 cutoff를 만들면 그 값은
    // 이틀 하고도 30분 전이 되어, 2시간 전에 감지된 이 건이 "아직 멀었다"로
    // 걸러진다 — 승인 대기 특보의 재알림이 통째로 멈춘다.
    skewAppClock(-2 * 24 * 3600_000);
    const rec = recorder();
    const out = await runRemindTick({ channel: rec.channel });
    expect(out.reminded).toBe(1);

    // 기록도 DB 시계로 찍혀야 한다. 앱 시계로 찍으면 last_reminded_at이 이틀 전이
    // 되어 다음 주기가 같은 건을 또 재알림한다(10분마다 무한 반복).
    const fresh = await withService(async (q) => {
      const { rows } = await q.query(
        "select now() - last_reminded_at < interval '5 minutes' as fresh from weather_events where id = $1",
        [id],
      );
      return rows[0].fresh as boolean;
    });
    expect(fresh).toBe(true);
  });

  it("앱 시계가 이틀 앞서도 heartbeat은 DB 시계로 찍힌다", async () => {
    // 미래로 찍힌 last_run_at은 워치독(now() - last_run_at > 130분)과
    // catchUpIfMissed(70분)를 그 차이만큼 통째로 잠재운다 — 수집이 멈춰도 초록이다.
    skewAppClock(2 * 24 * 3600_000);
    await upsertHeartbeat("weather-tick", true, null);
    const drift = await withService(async (q) => {
      const { rows } = await q.query(
        "select abs(extract(epoch from now() - last_run_at)) < 300 as close from heartbeats where name = 'weather-tick'",
      );
      return rows[0].close as boolean;
    });
    expect(drift).toBe(true);
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
  //
  // 역할을 하나만(approver) 시험하면 "관리자는 다 할 수 있어야지"라는 상식적인 이유로
  // admin 우회(`!recipient && emp.role !== "admin"`)가 들어와도 스위트가 초록으로 남는다.
  // 그러면 알림 수신자로 지정된 적 없는 관리자 전원이 전 직원 발송을 승인할 수 있게 된다.
  // 스펙(2026-08-13)은 승인 권한의 유일한 출처가 alert_recipients 등록이고 **역할과
  // 무관**하다고 못박고 있으므로, 세 역할 전부에 대해 같은 거부를 요구한다.
  it.each(["staff", "approver", "admin"] as const)(
    "alert_recipients에 없으면 역할이 %s여도 승인할 수 없고 아무에게도 발송되지 않는다",
    async (role) => {
      const staff = await makeEmployee({ name: "객실직원", email: `send-staff-${role}@gonjiam.com`, kw: "kw-staff" });
      const deptId = await makeDeptWithGuideline("rain", "watch", staff);
      const { eventId, content } = await pendingEventWithDraft(deptId, staff);
      const { agent } = await agentAs({ email: `send-nonrecip-${role}@gonjiam.com`, role });
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
    },
  );

  // 계정은 있는데 employees 행이 없는 세션(가입 전 관리자 계정 정리, 직원 삭제 등)이
  // 발송을 시도하는 경로. 발송 주체를 특정할 수 없으므로 라우트가 앞에서 막는다.
  // 가드가 없어도 runSend가 `employees where id = null` → 0행 → 401로 거부하니 보안
  // 구멍은 아니지만, 상태 코드가 403에서 401로 바뀐다 — 403을 단언해야 가드를 지킨다.
  it("직원 행이 없는 세션은 발송할 수 없다", async () => {
    const { agent, employeeId } = await agentAs({ email: "send-noemp@gonjiam.com", role: "admin", kw: "kw-noemp" });
    // 로그인 뒤 직원 행만 지운다 — auth_accounts와 세션은 그대로 살아 있다.
    await withService((q) => q.query("delete from employees where id = $1", [employeeId]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await agent.post("/api/send").send({ mode: "test" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("직원 정보가 없습니다");
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

  // EventReview.tsx:451이 res.fail_count > 0으로 "N명 발송 실패" 배너를 띄운다.
  // 서버가 늘 0을 보고하면 일부 직원에게 못 갔는데도 화면은 완전 성공으로 보인다.
  // 성공 경로만 보는 테스트(fail_count === 0)는 상수 0으로 바꿔도 통과하므로,
  // 실패가 섞인 블록으로 승인해 1 이상이 나오는 것을 따로 확인한다.
  it("카카오워크 미연결 수신자가 섞이면 fail_count에 그 수가 잡힌다", async () => {
    const connected = await makeEmployee({ name: "연결됨", email: "send-fc-ok@gonjiam.com", kw: "kw-ok" });
    const orphan = await makeEmployee({ name: "미연결", email: "send-fc-no@gonjiam.com", kw: null });
    const deptId = await makeDeptWithGuideline("rain", "watch", connected);
    const { eventId } = await pendingEventWithDraft(deptId, connected);
    // 발송 대상 블록에 미연결 수신자를 하나 섞는다 — 채널을 타지 못해 ok:false가 된다.
    const content = [
      {
        department_id: deptId, department_name: "객실",
        staff_actions: ["수건 2개 배포"], guest_notice: "안내문",
        recipients: [
          { employee_id: connected, name: "연결됨", kakaowork_user_id: "kw-ok" },
          { employee_id: orphan, name: "미연결", kakaowork_user_id: null },
        ],
        selected: true,
      },
    ];
    const agent = await recipientAgent("send-fc-recip@gonjiam.com");

    const res = await agent.post("/api/send").send({ mode: "approve", event_id: eventId, content });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fail_count).toBe(1);

    // fail_count가 우연히 1이 아니라 실제 실패 이력에서 나온 값인지 결과 배열로 확인한다.
    const results = await withService(async (q) => {
      const { rows } = await q.query("select results from dispatches");
      return rows[0].results as { name: string; ok: boolean; error?: string }[];
    });
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.name === "연결됨")!.ok).toBe(true);
    expect(results.find((r) => r.name === "미연결")).toMatchObject({ ok: false, error: "카카오워크 미연결" });
  });

  // -------------------------------------------------------------------------
  // "0명에게 성공" — QA W-02
  // -------------------------------------------------------------------------
  //
  // 승인자가 폭설 경보를 승인하고 화면이 이력으로 넘어간다. 붉은 배너는 없고
  // 이력에는 초록 "성공 0"이 찍혀 있다. 실제 수신자는 0명이다. fail_count가 0인
  // 이유는 실패한 사람이 없어서가 아니라 **대상이 아예 없어서**다.
  it("선택한 부서에 수신자가 0명이면 승인을 거부하고 특보는 승인 대기로 남는다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-zero-staff@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId } = await pendingEventWithDraft(deptId, staff);
    // 부서는 선택돼 있는데 그 안의 수신자가 비었다(부서 수신자 미지정 상태).
    const content = [{ department_id: deptId, department_name: "객실",
      staff_actions: ["수건 2개 배포"], guest_notice: "안내문", recipients: [], selected: true }];
    const agent = await recipientAgent("send-zero-recip@gonjiam.com");

    const res = await agent.post("/api/send").send({ mode: "approve", event_id: eventId, content });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/수신자가 한 명도 없습니다/);
    // 상태가 바뀌지 않아야 다시 승인할 수 있다 — 여기서 ACTIVE로 굳으면 재시도가 409다.
    const st = await state();
    expect(st.event.status).toBe("PENDING_APPROVAL");
    expect(st.message.status).toBe("draft");
    expect(st.dispatches).toEqual([]);
  });

  it("부서를 하나도 선택하지 않으면 승인을 거부한다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-nosel-staff@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId, content } = await pendingEventWithDraft(deptId, staff);
    const agent = await recipientAgent("send-nosel-recip@gonjiam.com");

    const res = await agent.post("/api/send")
      .send({ mode: "approve", event_id: eventId, content: content.map((b) => ({ ...b, selected: false })) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/부서를 한 곳 이상/);
    expect((await state()).event.status).toBe("PENDING_APPROVAL");
  });

  // "10명에게 성공"과 "0명에게 성공"을 화면이 구분하려면 서버가 대상 인원을 함께
  // 줘야 한다. fail_count만으로는 둘이 똑같이 0이다.
  it("승인 결과에 실제 대상 인원과 성공 인원이 실려 온다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-cnt-staff@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId, content } = await pendingEventWithDraft(deptId, staff);
    const agent = await recipientAgent("send-cnt-recip@gonjiam.com");

    const res = await agent.post("/api/send").send({ mode: "approve", event_id: eventId, content });
    expect(res.status).toBe(200);
    expect(res.body.recipient_count).toBe(1);
    expect(res.body.sent_count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 승인과 발송이 어긋날 때 어느 쪽이 진실인가 — QA W-09
  // -------------------------------------------------------------------------
  //
  // 예전에는 발송이 통째로 터져도 특보가 "승인·발송됨"으로 커밋된 채 남고 화면은
  // 실패라고 말했다. 재시도는 409고 화면 안에 되돌릴 수단이 없었다.
  it("한 명에게도 못 나가면 승인을 되돌려 다시 승인할 수 있게 한다", async () => {
    const staff = await makeEmployee({ name: "객실직원", email: "send-rb-staff@gonjiam.com", kw: "kw-staff" });
    const deptId = await makeDeptWithGuideline("rain", "watch", staff);
    const { eventId, content } = await pendingEventWithDraft(deptId, staff);
    const approver = await makeEmployee({ name: "사업부장", email: "send-rb-appr@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);

    const exploding: NotificationChannel = {
      async send() { throw new Error("카카오워크 장애"); },
    };
    const out = await runSend({ mode: "approve", event_id: eventId, content }, approver, { channel: exploding });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/승인은 취소했습니다/);

    const st = await state();
    expect(st.event.status).toBe("PENDING_APPROVAL");
    expect(st.event.repeat_count).toBe(0);
    expect(st.message.status).toBe("draft");

    // 되돌렸으니 정상 채널로 다시 승인하면 이번엔 나간다(409로 막히지 않는다).
    const rec = recorder();
    const retry = await runSend({ mode: "approve", event_id: eventId, content }, approver, { channel: rec.channel });
    expect(retry.ok).toBe(true);
    expect(rec.sent.map((x) => x.to)).toEqual(["kw-staff"]);
    expect((await state()).event.status).toBe("ACTIVE");
  });

  // 반대쪽 경계: 일부라도 나갔으면 되돌리지 않는다. 나간 DM은 회수할 수 없으므로
  // 되돌리면 "받은 사람이 있는데 승인 대기"라는 더 나쁜 상태가 되고, 재승인하면
  // 같은 사람에게 두 번 간다.
  it("일부라도 나갔으면 승인을 되돌리지 않는다", async () => {
    const a = await makeEmployee({ name: "직원A", email: "send-half-a@gonjiam.com", kw: "kw-a" });
    const b = await makeEmployee({ name: "직원B", email: "send-half-b@gonjiam.com", kw: "kw-b" });
    const deptId = await makeDeptWithGuideline("rain", "watch", a);
    const { eventId } = await pendingEventWithDraft(deptId, a);
    const approver = await makeEmployee({ name: "사업부장", email: "send-half-appr@gonjiam.com", kw: "kw-appr" });
    await makeAlertRecipient(approver);
    const content = [{ department_id: deptId, department_name: "객실",
      staff_actions: ["수건 2개 배포"], guest_notice: "안내문",
      recipients: [
        { employee_id: a, name: "직원A", kakaowork_user_id: "kw-a" },
        { employee_id: b, name: "직원B", kakaowork_user_id: "kw-b" },
      ], selected: true }];

    let n = 0;
    const halfBroken: NotificationChannel = {
      async send() { if (++n > 1) throw new Error("두 번째에서 끊김"); return { ok: true }; },
    };
    const out = await runSend({ mode: "approve", event_id: eventId, content }, approver, { channel: halfBroken });
    expect(out.ok).toBe(false);
    expect(out.sent_count).toBe(1);
    expect(out.error).not.toMatch(/승인은 취소/);
    expect((await state()).event.status).toBe("ACTIVE");
  });

  // 원본은 없는 message_id에 500으로 터졌고(ev.repeat_count 접근), 이식하며 404로 고쳤다.
  // 그 개선을 지키는 테스트가 없으면 `if (!msg) return null` 한 줄이 사라져도 조용하다.
  it("없는 message_id로 재발송하면 404다", async () => {
    const agent = await recipientAgent("send-recip6@gonjiam.com");
    // UUID 형식은 맞지만 존재하지 않는 id — 형식이 틀리면 캐스트 오류로 500이 나서
    // 404 분기를 지나치지 못한다.
    const res = await agent
      .post("/api/send")
      .send({ mode: "resend", message_id: randomUUID(), content: [] });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    // 500이 아니라 404여야 한다 — 없는 대상은 서버 오류가 아니라 클라이언트 잘못이다.
    expect((await state()).dispatches).toEqual([]);
  });

  it("모르는 mode는 400이다", async () => {
    const agent = await recipientAgent("send-recip5@gonjiam.com");
    expect((await agent.post("/api/send").send({ mode: "nope" })).status).toBe(400);
  });
});
