import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { withService, type Querier } from "../src/db.ts";
import { checkHealth, reportIfUnhealthy, COLLECT_STALE_MIN, MISSING_STREAK } from "../src/jobs/watchdog.ts";
import type { NotificationChannel } from "../src/shared/channel.ts";

// 이 파일은 실제 카카오워크로 나가면 안 된다. reportIfUnhealthy는 채널을 주입할 수
// 있지만, 주입하지 않는 경로를 한 번이라도 밟으면 루트 .env의 봇 키로 실제 발송이
// 나간다 — jobs.test.ts와 같은 방식으로 콘솔 채널로 못박는다.
process.env.NOTIFY_CHANNEL = "console";

// 발송된 내용을 그대로 모으는 채널. "알렸다/안 알렸다"를 눈으로 봐야
// 감시가 실제로 사람을 부르는지 증명할 수 있다.
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

// 이 파일이 넣은 관측 행에만 붙이는 표식. weather_observations는 모든 테스트
// 파일이 공유하는 작업 DB의 실제 관측 이력이라, 통째로 지우면 이 파일을 돌릴
// 때마다 남의 이력까지 사라진다. raw에 표식을 남기고 그 행만 지운다.
const MARK = { t: "watchdog-test" };

/** 표식을 붙여 관측을 넣는다. observed_at은 유니크라 테스트마다 다른 시각을 쓴다. */
async function insertObs(
  q: Querier,
  rows: Array<{ ago: string; missing: boolean; temp?: number; rain?: number }>,
): Promise<void> {
  for (const r of rows) {
    await q.query(
      `insert into weather_observations (observed_at, temp_c, rain_mm_per_hr, missing, raw)
       values (now() - ($1)::interval, $2, $3, $4, $5)`,
      [r.ago, r.temp ?? null, r.rain ?? null, r.missing, JSON.stringify(MARK)],
    );
  }
}

// 이제 checkHealth는 "알릴 수 있는 사람이 있는가"도 본다 — Alert 수신자 중 카카오워크에
// 연결된 사람이 0명이면 특보가 아무에게도 전달되지 않으므로 그것 자체가 불건강이다.
// 그래서 "정상"을 확인하는 테스트는 연결된 수신자가 한 명 있는 상태를 먼저 만들어야
// 한다. 작업 DB의 alert_recipients는 다른 파일도 쓰므로, 이 파일 전용 직원 한 명만
// 넣고 테스트가 끝나면 지운다.
const NOTIFIABLE = { email: "zzwatchdog-ok@gonjiam.com", kw: "zzwatchdog-ok-kakao" };

async function ensureNotifiable(): Promise<void> {
  await withService(async (q) => {
    const { rows } = await q.query(
      `insert into employees (name, email, kakaowork_user_id, role)
       values ('감시정상', $1, $2, 'staff')
       on conflict (email) do update set kakaowork_user_id = excluded.kakaowork_user_id
       returning id`,
      [NOTIFIABLE.email, NOTIFIABLE.kw],
    );
    await q.query("insert into alert_recipients (employee_id) values ($1) on conflict do nothing", [rows[0].id]);
  });
}

async function clearNotifiable(): Promise<void> {
  await withService(async (q) => {
    await q.query(
      "delete from alert_recipients where employee_id in (select id from employees where email = $1)",
      [NOTIFIABLE.email],
    );
    await q.query("delete from employees where email = $1", [NOTIFIABLE.email]);
  });
}

// checkHealth는 이제 "판정과 내용이 살아 있는가"도 본다(QA W-02·W-03): 내용이 있는
// 행동지침이 0건이거나, 지침이 있는 부서에 수신자가 0명이면 특보를 만들어도 아무에게도
// 가지 않는다. 그래서 "정상"을 확인하는 테스트는 지침 한 건과 그 부서 수신자 한 명이
// 있어야 한다. 시드는 지침을 심지 않으므로(db/seed.sql) 이 파일 전용으로 만들고 지운다.
const GUIDE = { dept: "zzwatchdog-지침부서", email: "zzwatchdog-recv@gonjiam.com" };

async function ensureGuideline(): Promise<void> {
  await withService(async (q) => {
    const { rows: d } = await q.query(
      `insert into departments (name)
       select $1 where not exists (select 1 from departments where name = $1)
       returning id`,
      [GUIDE.dept],
    );
    const deptId =
      d[0]?.id ??
      (await q.query("select id from departments where name = $1", [GUIDE.dept])).rows[0].id;
    const { rows: e } = await q.query(
      `insert into employees (name, email, role) values ('감시수신', $1, 'staff')
       on conflict (email) do update set name = excluded.name returning id`,
      [GUIDE.email],
    );
    await q.query(
      `insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice)
       values ($1, 'rain', 'watch', $2, '안내문')
       on conflict (department_id, kind, grade) do update set staff_actions = excluded.staff_actions`,
      [deptId, ["제설 대기"]],
    );
    await q.query(
      "insert into recipients (department_id, employee_id) values ($1, $2) on conflict do nothing",
      [deptId, e[0].id],
    );
  });
}

async function clearGuideline(): Promise<void> {
  await withService(async (q) => {
    await q.query(
      "delete from action_guidelines where department_id in (select id from departments where name = $1)",
      [GUIDE.dept],
    );
    await q.query(
      "delete from recipients where department_id in (select id from departments where name = $1)",
      [GUIDE.dept],
    );
    await q.query("delete from employees where email = $1", [GUIDE.email]);
    await q.query("delete from departments where name = $1", [GUIDE.dept]);
  });
}

/** "정상"의 전제 한 벌 — 알릴 사람 + 보낼 내용. */
async function ensureAlertable(): Promise<void> {
  await ensureNotifiable();
  await ensureGuideline();
}

async function clearAlertable(): Promise<void> {
  await clearNotifiable();
  await clearGuideline();
}

// heartbeats는 'weather-tick'/'remind-tick' 두 행뿐인 런타임 상태값이고, 다음
// 주기에 다시 채워진다. jobs.test.ts·scheduler.test.ts도 같은 방식으로 지운다.
//
// weather_observations는 **표에 남아 있는 모든 행**을 지운다. 이 파일의 표식이 붙은
// 행만 지우면 안 된다: checkHealth의 판정(`order by observed_at desc limit 3`)은 표
// 전체의 최근 3행을 보므로, 다른 테스트 파일이 남긴 행 하나가 그 창에 끼어들면
// "최근 3회가 모두 결측"이 조용히 거짓이 된다. 실제로 이 라운드에서 재현됐다 —
// api-dashboard.test.ts가 남긴 now() 시각의 정상 관측 1행 때문에 결측 사유 테스트
// 셋이 **파일 실행 순서에 따라** 실패했다(vitest의 기본 시퀀서는 파일 순서를
// 실행 시간 기준으로 정하므로 순서가 고정이 아니다). jobs.test.ts도 같은 이유로
// 이 표를 통째로 비운다 — 관측은 시드가 아니라 테스트가 만드는 런타임 데이터다.
beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from heartbeats");
    await q.query("delete from weather_observations");
  });
});

// 파일이 끝나면 이 파일이 넣은 행을 남기지 않는다.
afterAll(async () => {
  await withService((q) =>
    q.query("delete from weather_observations where raw = $1", [JSON.stringify(MARK)]),
  );
});

describe("상태 점검", () => {
  // "정상"을 확인하는 테스트들은 알릴 수 있는 수신자가 있어야 한다(아래 별도
  // describe가 그 판정 자체를 검증한다).
  beforeEach(ensureAlertable);
  afterEach(clearAlertable);

  // 자체 서버는 조용히 죽는다. 관리형과 달리 아무도 안 알려준다.
  it("수집이 오래 멈췄으면 문제로 본다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')"),
    );
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수집/);
  });

  it("최근에 수집했으면 정상으로 본다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    expect((await checkHealth()).ok).toBe(true);
  });

  it("수집은 돌지만 결측만 쌓이면 문제로 본다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [
        { ago: "2 hours", missing: true },
        { ago: "1 hour", missing: true },
        { ago: "0 seconds", missing: true },
      ]);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/결측/);
  });

  // 한 번도 안 돈 것과 오래 멈춘 것은 운영자 입장에서 같은 사고다.
  // heartbeats가 비어 있을 때 "행이 없으니 비교할 게 없다"로 빠져 ok=true를
  // 돌려주면, 설치 직후 수집이 아예 시작되지 않은 상태를 정상이라고 보고한다.
  it("한 번도 수집한 적이 없으면 문제로 본다", async () => {
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수집/);
  });

  // 경계를 양쪽에서 고정한다. 여기서 상수(COLLECT_STALE_MIN ± 5)를 참조하면
  // 임계값을 130에서 1로 바꿔도 테스트가 함께 따라 움직여 그대로 통과한다 —
  // 실제로 그 변이가 살아남았다. 그래서 구체적인 분(分)으로 못박는다.
  // 130분이 이 두 값 사이에 있다는 것이 계약이다.
  it("수집한 지 100분 지났으면 아직 정상이다", async () => {
    await withService(async (q) => {
      await q.query(
        "insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '100 minutes')",
      );
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    expect((await checkHealth()).ok).toBe(true);
  });

  it("수집한 지 140분 지났으면 문제로 본다", async () => {
    await withService(async (q) => {
      await q.query(
        "insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '140 minutes')",
      );
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수집/);
  });

  // 임계값은 운영 안내서(§3-3 표)와 알림 문구에 숫자 그대로 노출된다.
  // 값을 바꾸면 문서도 함께 바꿔야 하므로 값 자체를 여기서 고정한다.
  it("임계값이 운영 안내서에 적힌 값과 같다", () => {
    expect(COLLECT_STALE_MIN).toBe(130);
    expect(MISSING_STREAK).toBe(3);
  });

  // 결측 연속 판정이 "최근 N회"를 실제로 보는지 확인한다. 가장 최근 한 건이
  // 정상이면 수집은 살아 있는 것이므로 결측 사유가 붙으면 안 된다.
  it("가장 최근 관측이 정상이면 그 앞이 결측이어도 정상이다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [
        { ago: "3 hours", missing: true },
        { ago: "2 hours", missing: true },
        { ago: "1 hour", missing: true },
        { ago: "0 seconds", missing: false, temp: 20 },
      ]);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/결측/);
  });

  // 이 시스템에서 가장 조용한 고장: 기상청이 category 코드를 바꾸면(RN1 → RN01)
  // HTTP 200 + resultCode "00"이라 파서가 예외 없이 전부 null을 돌려주고,
  // weatherTick이 그것을 missing=false로 저장한다. 수집은 "정상"이고 heartbeat도
  // 신선한데 판정 엔진은 액션을 0건 낸다 — 폭우가 와도 특보가 영원히 안 뜬다.
  // 워치독이 이걸 못 보면 모든 지표가 초록인 채로 시스템이 죽어 있다.
  it("수집은 정상인데 값이 전부 비어 있으면 문제로 본다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [
        { ago: "2 hours", missing: false },
        { ago: "1 hour", missing: false },
        { ago: "0 seconds", missing: false },
      ]);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/값이 전부 비어/);
    // 결측이 아니라 "값 없음"이다 — 둘을 섞으면 운영자가 엉뚱한 곳을 본다.
    expect(out.reasons.join()).not.toMatch(/모두 결측/);
  });

  it("값이 하나라도 들어 있으면 정상이다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [
        { ago: "2 hours", missing: false },
        { ago: "1 hour", missing: false },
        { ago: "0 seconds", missing: false, rain: 0 },
      ]);
    });
    const out = await checkHealth();
    expect(out.reasons.join()).not.toMatch(/값이 전부 비어/);
  });

  // 결측 행은 원래 값이 비어 있다. 그 상태까지 "값 없음"으로 함께 울리면
  // 사유가 둘로 늘어 운영자가 두 가지 사고로 오해한다.
  it("결측만 쌓인 경우에는 값 없음 사유를 붙이지 않는다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [
        { ago: "2 hours", missing: true },
        { ago: "1 hour", missing: true },
        { ago: "0 seconds", missing: true },
      ]);
    });
    const out = await checkHealth();
    expect(out.reasons.join()).toMatch(/모두 결측/);
    expect(out.reasons.join()).not.toMatch(/값이 전부 비어/);
  });

  // 관측이 아직 3회보다 적게 쌓였을 때 결측이라고 단정하면, 설치 첫 시간에
  // "결측만 쌓인다"는 헛경보가 나간다.
  //
  // 이 판정만은 "표 전체에 관측이 몇 행 있는가"를 보기 때문에, 실제 DB로
  // 재현하려면 모든 테스트 파일이 공유하는 weather_observations를 통째로
  // 비워야 한다. 남의 관측 이력을 지우지 않으려고 여기서는 질의 결과만
  // 갈아 끼운다(checkHealth의 runner 주입 지점).
  function stubbedHealth(rows: Array<{ missing: boolean }>) {
    return checkHealth({
      runner: (fn) =>
        fn({
          async query(text: string) {
            // 하트비트 정체 여부 / 알릴 수 있는 수신자 수 / 관측 지점 좌표는
            // 이 시나리오의 관심사가 아니므로 "정상"으로 고정하고, 나머지(최근
            // 관측 목록)만 인자로 받은 행을 돌려준다. 좌표를 고정하지 않으면
            // 관측 행에 nx/ny가 없어 격자 범위 사유(QA W-10)가 함께 붙는다.
            if (text.includes("heartbeats")) return { rows: [{ stale: false }] };
            if (text.includes("alert_recipients")) return { rows: [{ total: 1, linked: 1 }] };
            if (text.includes("site_settings")) return { rows: [{ nx: 61, ny: 121 }] };
            return { rows };
          },
        }),
    });
  }

  it("결측 관측이 2회뿐이면 아직 결측으로 단정하지 않는다", async () => {
    const out = await stubbedHealth([{ missing: true }, { missing: true }]);
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/결측/);
  });

  it("결측 관측이 3회가 되면 그때 문제로 본다", async () => {
    const out = await stubbedHealth([{ missing: true }, { missing: true }, { missing: true }]);
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/결측/);
  });

  // 두 사고가 동시에 나면 둘 다 보고해야 한다. 첫 사유에서 빠져나가면
  // 운영자가 한쪽만 고치고 정상이 됐다고 오해한다.
  it("사유가 여러 개면 모두 담는다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')");
      await insertObs(q, [
        { ago: "2 hours", missing: true },
        { ago: "1 hour", missing: true },
        { ago: "0 seconds", missing: true },
      ]);
    });
    const out = await checkHealth();
    expect(out.reasons).toHaveLength(2);
    expect(out.reasons.join()).toMatch(/수집/);
    expect(out.reasons.join()).toMatch(/결측/);
  });

  // 앱은 살아 있는데 DB에 못 닿는 상태가 가장 위험하다 — 예외가 그대로
  // 새면 /api/health/deep이 500 "서버 오류"만 뱉고, 운영자는 무엇이
  // 잘못됐는지 알 수 없다. 사유로 바꿔서 돌려줘야 한다.
  it("데이터베이스에 닿지 못하면 예외 대신 사유로 알린다", async () => {
    const out = await checkHealth({
      runner: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5433")),
    });
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/데이터베이스/);
  });
});

// 이 시스템이 겪은 가장 큰 사고의 절반이다. 값을 채우는 경로를 만드는 것만으로는
// 같은 사고가 다른 이유(봇 키 오타, 카카오워크 계정 삭제, 이메일 불일치)로 되풀이된다 —
// "알릴 수 있는 사람이 0명"이라는 사실이 지표에 보여야 한다.
describe("알릴 수 있는 사람이 없으면 불건강이다", () => {
  const UNLINKED = "zzwatchdog-unlinked@gonjiam.com";

  /** 수집은 완전히 정상인 상태를 만든다 — 그래야 "수집 사유"가 아니라 연결 사유만 남는다. */
  async function healthyCollection(q: Querier) {
    await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
    await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
  }

  async function clearRecipients(q: Querier) {
    await q.query("delete from alert_recipients");
  }

  afterEach(async () => {
    await withService(async (q) => {
      await q.query(
        "delete from alert_recipients where employee_id in (select id from employees where email in ($1,$2))",
        [UNLINKED, NOTIFIABLE.email],
      );
      await q.query("delete from employees where email in ($1,$2)", [UNLINKED, NOTIFIABLE.email]);
    });
  });

  it("수신자가 지정돼 있는데 아무도 카카오워크에 연결돼 있지 않으면 불건강이다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
      const { rows } = await q.query(
        "insert into employees (name, email) values ('미연결', $1) returning id", [UNLINKED]);
      await q.query("insert into alert_recipients (employee_id) values ($1)", [rows[0].id]);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/카카오워크에 연결된 사람이 0명/);
  });

  it("한 명이라도 연결돼 있으면 그 사유는 없다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
    });
    await ensureAlertable();
    const out = await checkHealth();
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/카카오워크/);
  });

  it("수신자가 아예 지정되지 않았어도 불건강이다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/Alert 수신자가 한 명도/);
  });

  // 상태 코드가 바뀌어야 사내 모니터링이 이 사고를 본다.
  it("/api/health/deep이 503으로 내려간다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
    });
    const { app } = await import("../src/index.ts");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(503);
    expect(res.body.reasons.join()).toMatch(/Alert 수신자/);
  });

  // 이 사유일 때는 카카오워크로 알릴 수 없다(그 통로가 없다는 것이 곧 사유다).
  // 조용히 지나가면 아무도 모르므로 서버 로그에 반드시 남아야 한다.
  it("알릴 대상이 없으면 서버 로그에 남긴다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sent, channel } = recorder();
    await reportIfUnhealthy({ channel });
    expect(sent).toHaveLength(0);
    expect(err).toHaveBeenCalled();
    expect(err.mock.calls.flat().join()).toMatch(/알릴 대상이 없습니다/);
    err.mockRestore();
  });
});

describe("문제가 있으면 알린다", () => {
  const EMAIL = "zzwatchdog@gonjiam.com";
  const KAKAO_ID = "zzwatchdog-kakao";

  async function makeRecipient() {
    return withService(async (q) => {
      const { rows } = await q.query(
        `insert into employees (name, email, kakaowork_user_id, role)
         values ('감시테스트', $1, $2, 'staff')
         on conflict (email) do update set kakaowork_user_id = excluded.kakaowork_user_id
         returning id`,
        [EMAIL, KAKAO_ID],
      );
      await q.query("insert into alert_recipients (employee_id) values ($1) on conflict do nothing", [rows[0].id]);
      return rows[0].id as string;
    });
  }

  afterEach(async () => {
    await withService(async (q) => {
      await q.query(
        "delete from alert_recipients where employee_id in (select id from employees where email = $1)",
        [EMAIL],
      );
      await q.query("delete from employees where email = $1", [EMAIL]);
    });
  });

  it("문제가 있으면 알림 수신자에게 사유를 보낸다", async () => {
    await makeRecipient();
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')"),
    );
    const { sent, channel } = recorder();
    await reportIfUnhealthy({ channel });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(KAKAO_ID);
    expect(sent[0].text).toMatch(/수집/);
  });

  // 정상인데도 6시간마다 메시지가 오면 사람이 곧 무시하기 시작한다.
  // 그 뒤엔 진짜 사고 메시지도 함께 묻힌다.
  it("정상이면 아무에게도 보내지 않는다", async () => {
    await makeRecipient();
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const { sent, channel } = recorder();
    await reportIfUnhealthy({ channel });
    expect(sent).toHaveLength(0);
  });

  // 카카오워크 ID가 없는 직원에게 보내려 하면 발송이 통째로 터진다.
  it("카카오워크 ID가 없는 수신자에게는 보내지 않는다", async () => {
    const id = await makeRecipient();
    await withService((q) => q.query("update employees set kakaowork_user_id = null where id = $1", [id]));
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')"),
    );
    const { sent, channel } = recorder();
    await reportIfUnhealthy({ channel });
    expect(sent).toHaveLength(0);
  });
});

describe("GET /api/health/deep", () => {
  beforeEach(ensureAlertable);
  afterEach(clearAlertable);

  it("정상이면 200과 ok:true를 준다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const { app } = await import("../src/index.ts");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // 200을 항상 주면 바깥에서 거는 감시(사내 모니터링·수동 확인)가
  // 사고를 못 본다. 문제일 때는 상태 코드 자체가 달라야 한다.
  it("문제가 있으면 503과 사유를 준다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')"),
    );
    const { app } = await import("../src/index.ts");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.reasons.join()).toMatch(/수집/);
  });

  // 로그인 없이 닿아야 한다 — 로그인이 안 되는 상황을 확인하려고 부르는
  // 엔드포인트인데 로그인을 요구하면 쓸모가 없다.
  it("로그인하지 않아도 닿는다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const { app } = await import("../src/index.ts");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).not.toBe(401);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});

// ---------------------------------------------------------------------------
// "알릴 수 없는데 전부 초록" — QA가 세 갈래로 재현한 상태(W-02·W-03)
// ---------------------------------------------------------------------------
//
// 셋 다 실측 결과가 200 {"ok":true}였다. 수집 통로(하트비트·결측·연결)만 보던
// 점검에 **판정과 내용**을 더한다: 종류가 전부 꺼져 있는가, 지침이 있는가,
// 그 지침을 받을 사람이 있는가, 그리고 앱이 스스로 남긴 실패 기록.
describe("특보를 낼 수 없는 상태를 사유로 잡는다", () => {
  /** 수집·전달 통로는 완전히 정상인 상태 — 그래야 새 사유만 남는다. */
  async function healthyPipes(): Promise<void> {
    await ensureNotifiable();
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20, rain: 0 }]);
    });
  }

  afterEach(async () => {
    await clearAlertable();
    // 알림 설정은 시드 행이다 — 지우지 않고 기본값(전부 켜짐)으로 되돌린다.
    await withService((q) => q.query("update alert_settings set enabled = true"));
  });

  it("알림 설정 4종이 모두 꺼져 있으면 문제로 본다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService((q) => q.query("update alert_settings set enabled = false"));
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/4종이 모두 꺼져/);
  });

  // 계절에 따라 폭염을 꺼 두는 것은 정상 운영이다. 여기까지 사유로 울리면
  // 운영자가 6시간마다 오는 메시지를 곧 무시하게 되고 진짜 사고도 함께 묻힌다.
  it("한 종류만 꺼 두는 것은 사유가 아니다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService((q) => q.query("update alert_settings set enabled = false where kind = 'heat'"));
    const out = await checkHealth();
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/꺼져/);
  });

  // 설치 직후의 기본 상태다. 지침이 0건이면 초안(composeDraft)이 빈 배열이라
  // 승인해도 나갈 곳이 없다 — 그런데 지금까지 어떤 지표도 그것을 말하지 않았다.
  it("내용이 있는 지침이 한 건도 없으면 문제로 본다", async () => {
    await healthyPipes();
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/행동지침이 한 건도 없습니다/);
  });

  // 지침을 지울 방법이 없어서 내용만 비워 둔 경우(QA W-22). 행은 남아 있으므로
  // "지침 1건"으로 세면 초록이 되는데, 실제 DM은 제목만 나간다. 없는 것으로 센다.
  it("내용이 빈 지침만 있으면 지침이 없는 것과 같게 본다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService((q) =>
      q.query("update action_guidelines set staff_actions = '{}', guest_notice = ''"),
    );
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/행동지침이 한 건도 없습니다/);
  });

  // "0명에게 발송 성공"의 뿌리. 지침은 있고 승인 버튼도 켜지는데 그 부서에
  // 수신자가 없어 실제 발송이 0건이다. fail_count는 0이고 이력은 초록이다.
  it("지침은 있는데 그 부서 수신자가 0명이면 문제로 본다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService((q) =>
      q.query(
        "delete from recipients where department_id in (select id from departments where name = $1)",
        [GUIDE.dept],
      ),
    );
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수신자가 한 명도 없는 부서가 1곳/);
  });

  // 앱이 "이번 수집 실패했다"고 스스로 적어 둔 값을 점검이 안 읽으면, 수집은
  // 매시간 실패하는데 last_run_at은 갱신되므로 영원히 초록이다(QA W-03).
  it("마지막 수집이 실패로 기록돼 있으면 문제로 본다", async () => {
    await ensureAlertable();
    await withService(async (q) => {
      await q.query(
        "insert into heartbeats (name, last_run_at, ok, note) values ('weather-tick', now(), false, 'missing')",
      );
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20, rain: 0 }]);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/마지막 수집·판정이 실패/);
    expect(out.reasons.join()).toMatch(/missing/);
  });

  // 실제로 일어나는 모양은 "전부 null"이 아니라 "항목 하나만 null"이다:
  // RN1 → RN01 하나로 폭우와 폭설이 동시에 죽는데 기온·풍속은 멀쩡하다.
  // 네 값이 전부 죽어야만 우는 판정은 이 상태를 통째로 놓친다.
  it("강수 항목만 계속 비어 와도 잡는다", async () => {
    await ensureAlertable();
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [
        { ago: "2 hours", missing: false, temp: 20 },
        { ago: "1 hour", missing: false, temp: 21 },
        { ago: "0 seconds", missing: false, temp: 22 },
      ]);
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/강수량/);
    // 전부 죽은 것이 아니므로 "값이 전부 비어" 사유로 뭉뚱그리면 안 된다 —
    // 운영자가 기상청 응답 전체가 죽은 줄 알고 엉뚱한 곳을 본다.
    expect(out.reasons.join()).not.toMatch(/값이 전부 비어/);
  });

  it("네 항목이 다 들어오면 항목 사유는 없다", async () => {
    await ensureAlertable();
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      for (const ago of ["2 hours", "1 hour", "0 seconds"])
        await q.query(
          `insert into weather_observations
             (observed_at, temp_c, rain_mm_per_hr, wind_ms, humidity_pct, missing, raw)
           values (now() - ($1)::interval, 20, 0, 2, 60, false, $2)`,
          [ago, JSON.stringify(MARK)],
        );
    });
    const out = await checkHealth();
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/비어/);
  });
});

// 관측 지점 좌표가 격자 범위를 벗어나면 수집이 매시간 실패한다(QA W-10).
// 저장은 이제 PATCH /api/site-settings가 막지만, 그 검증이 생기기 전에 저장된
// 값이나 DB를 직접 고친 경우는 그대로 남는다 — 그 상태가 어디에도 보이지
// 않는 것이 이 결함의 나머지 절반이다.
describe("관측 지점 좌표가 격자 범위 밖이면 불건강이다 (W-10)", () => {
  let saved: { nx: number; ny: number };

  beforeEach(async () => {
    await ensureNotifiable();
    await ensureGuideline();
    saved = await withService(async (q) => {
      await q.query("insert into site_settings (id) values (1) on conflict do nothing");
      const { rows } = await q.query("select nx, ny from site_settings where id = 1");
      return { nx: rows[0].nx as number, ny: rows[0].ny as number };
    });
    // 수집 자체는 완전히 정상으로 만든다 — 그래야 좌표 사유만 남는다.
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
  });

  afterEach(async () => {
    await withService((q) =>
      q.query("update site_settings set nx = $1, ny = $2 where id = 1", [saved.nx, saved.ny]));
    await clearGuideline();
    await clearNotifiable();
  });

  it("nx가 음수면 좌표를 사유로 이름 붙여 말한다", async () => {
    await withService((q) => q.query("update site_settings set nx = -1 where id = 1"));
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    // "수집이 멈췄다"가 아니라 **왜** 멈추는지를 말해야 한다 — 하트비트는
    // 방금 정상으로 찍었으므로 다른 사유는 나올 수 없다.
    expect(out.reasons.join()).toMatch(/nx=-1/);
    expect(out.reasons.join()).toMatch(/기상청 격자/);
  });

  it("ny가 격자 상한을 넘어도 사유가 된다", async () => {
    await withService((q) => q.query("update site_settings set ny = 9999 where id = 1"));
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/ny=9999/);
  });

  it("범위 안의 좌표에서는 이 사유가 나오지 않는다", async () => {
    await withService((q) => q.query("update site_settings set nx = 61, ny = 121 where id = 1"));
    const out = await checkHealth();
    expect(out.reasons.join()).not.toMatch(/격자/);
    expect(out.ok).toBe(true);
  });
});
