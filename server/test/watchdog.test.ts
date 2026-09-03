import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { withService, type Querier } from "../src/db.ts";
import { checkHealth, reportIfUnhealthy, COLLECT_STALE_MIN, MISSING_STREAK } from "../src/jobs/watchdog.ts";
import type { NotificationChannel } from "../src/shared/channel.ts";
// 25번째 경로(실효 채널이 로그 전용)를 재현하려면 그 채널 객체가 필요하다.
import { LogOnlyChannel } from "../src/shared/sms.ts";
import { LOG_ONLY_REASON } from "../src/jobs/watchdog.ts";

// 이 파일은 실제 문자를 내보내면 안 된다. reportIfUnhealthy는 채널을 주입할 수
// 있지만, 주입하지 않는 경로를 한 번이라도 밟으면 루트 .env의 제공자 설정으로
// 실제 발송이 나간다 — jobs.test.ts와 같은 방식으로 로그 채널로 못박는다.
process.env.SMS_PROVIDER = "";

// 이 스위트 전체가 로그 전용 채널로 도는데, **그 상태 자체가 이제 사유다**
// (검증 라운드 E의 25번째 경로: 로그 전용 채널 = 아무에게도 안 간다).
// 그 사유를 일부러 보려는 describe 말고는 **운영과 같은 실채널**을 주입해 둔다 —
// 안 그러면 모든 테스트의 reasons에 같은 문장이 섞여 무엇을 보고 있는지 알 수 없다.
const REAL_CHANNEL: NotificationChannel = {
  async send() {
    return { ok: true };
  },
};

/** 기본이 "실채널이 붙은 운영 상태"인 checkHealth. deps로 덮어쓸 수 있다. */
const health = (deps: Parameters<typeof checkHealth>[0] = {}) =>
  checkHealth({ channel: REAL_CHANNEL, ...deps });

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

// 이제 checkHealth는 "알릴 수 있는 사람이 있는가"도 본다 — Alert 수신자 중 보낼 수
// 있는 휴대폰 번호를 가진 사람이 0명이면 특보가 아무에게도 전달되지 않으므로 그것
// 자체가 불건강이다. 그래서 "정상"을 확인하는 테스트는 번호가 있는 수신자가 한 명 있는 상태를 먼저 만들어야
// 한다. 작업 DB의 alert_recipients는 다른 파일도 쓰므로, 이 파일 전용 직원 한 명만
// 넣고 테스트가 끝나면 지운다.
const NOTIFIABLE = { email: "zzwatchdog-ok@gonjiam.com", phone: "010-7000-0001" };

async function ensureNotifiable(): Promise<void> {
  await withService(async (q) => {
    const { rows } = await q.query(
      `insert into employees (name, email, phone, role)
       values ('감시정상', $1, $2, 'staff')
       on conflict (email) do update set phone = excluded.phone
       returning id`,
      [NOTIFIABLE.email, NOTIFIABLE.phone],
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
    // **휴대폰 번호를 채운다.** 채우지 않으면 이 부서 몫은 승인해도 0명에게
    // 나간다 — 그리고 그것이 검증 §신규-1이 찾아낸 상태다. 이 파일의 "정상" 전제가
    // 그동안 정확히 그 상태였다(지정은 돼 있고 아무도 닿을 수 없는).
    const { rows: e } = await q.query(
      `insert into employees (name, email, role, phone)
       values ('감시수신', $1, 'staff', $2)
       on conflict (email) do update
         set name = excluded.name, phone = excluded.phone
       returning id`,
      [GUIDE.email, "010-7000-0002"],
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
//
// action_guidelines·recipients도 같은 이유로 통째로 비운다. 라운드 B가 checkHealth에
// "내용이 있는 지침이 있는가 / 그 부서에 수신자가 있는가"를 넣은 순간, **남의 파일이
// 남긴 지침 한 줄**이 이 파일의 "정상" 전제를 통째로 깨뜨리게 됐다:
//   npx vitest run test/api-content.test.ts test/watchdog.test.ts
//   → watchdog 9건이 한 번에 실패(100% 재현). 회귀 검증 §A-2(나).
// 순서가 실행마다 달라지므로(vitest 기본 시퀀서는 직전 실행 시간으로 파일 순서를
// 정한다) 같은 명령이 어떤 날은 통과하고 어떤 날은 9건 실패한다 — 다음 사람이 진짜
// 회귀와 이 노이즈를 구분할 수 없다. 둘 다 시드가 아니라 테스트가 만드는 데이터다
// (db/seed.sql은 departments·criteria·alert_settings·site_settings만 심는다).
beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from heartbeats");
    await q.query("delete from weather_observations");
    await q.query("delete from action_guidelines");
    await q.query("delete from recipients");
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
    const out = await health();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수집/);
  });

  it("최근에 수집했으면 정상으로 본다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    expect((await health()).ok).toBe(true);
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
    const out = await health();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/결측/);
  });

  // 한 번도 안 돈 것과 오래 멈춘 것은 운영자 입장에서 같은 사고다.
  // heartbeats가 비어 있을 때 "행이 없으니 비교할 게 없다"로 빠져 ok=true를
  // 돌려주면, 설치 직후 수집이 아예 시작되지 않은 상태를 정상이라고 보고한다.
  it("한 번도 수집한 적이 없으면 문제로 본다", async () => {
    const out = await health();
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
    expect((await health()).ok).toBe(true);
  });

  it("수집한 지 140분 지났으면 문제로 본다", async () => {
    await withService(async (q) => {
      await q.query(
        "insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '140 minutes')",
      );
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const out = await health();
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
    const out = await health();
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
    const out = await health();
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
    const out = await health();
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
    const out = await health();
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
    return health({
      runner: (fn) =>
        fn({
          async query(text: string) {
            // 하트비트 정체 여부 / 알릴 수 있는 수신자 수 / 관측 지점 좌표는
            // 이 시나리오의 관심사가 아니므로 "정상"으로 고정하고, 나머지(최근
            // 관측 목록)만 인자로 받은 행을 돌려준다. 좌표를 고정하지 않으면
            // 관측 행에 nx/ny가 없어 격자 범위 사유(QA W-10)가 함께 붙는다.
            if (text.includes("heartbeats")) return { rows: [{ stale: false }] };
            if (text.includes("alert_recipients")) return { rows: [{ total: 1, reachable: 1 }] };
            if (text.includes("site_settings")) return { rows: [{ nx: 61, ny: 121 }] };
            // 특보 기준도 관심사가 아니다 — 쓸 수 있는 값 한 벌로 고정한다.
            // 고정하지 않으면 아래 관측 행이 기준 행으로 읽혀 "기준 값이 잘못됐다"가
            // 함께 붙는다.
            if (text.includes("weather_criteria")) {
              return { rows: [{ kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 30 } }] };
            }
            // 지침 길이(LMS 한 통) 검사도 이 시나리오의 관심사가 아니다 —
            // 고정하지 않으면 아래 관측 행이 "너무 긴 지침"으로 읽혀 사유가 붙는다.
            if (text.includes("action_guidelines")) return { rows: [] };
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
    const out = await health();
    expect(out.reasons).toHaveLength(2);
    expect(out.reasons.join()).toMatch(/수집/);
    expect(out.reasons.join()).toMatch(/결측/);
  });

  // 앱은 살아 있는데 DB에 못 닿는 상태가 가장 위험하다 — 예외가 그대로
  // 새면 /api/health/deep이 500 "서버 오류"만 뱉고, 운영자는 무엇이
  // 잘못됐는지 알 수 없다. 사유로 바꿔서 돌려줘야 한다.
  it("데이터베이스에 닿지 못하면 예외 대신 사유로 알린다", async () => {
    const out = await health({
      runner: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5433")),
    });
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/데이터베이스/);
  });
});

// 이 시스템이 겪은 가장 큰 사고의 절반이다. 카카오워크에서는 "연결이 안 됐다"가
// 원인이었고 지금은 "휴대폰 번호가 없거나 형식이 틀렸다"가 원인이지만, 결과는 같다 —
// "알릴 수 있는 사람이 0명"이라는 사실이 지표에 보여야 한다. **조회·연결이라는 기계가
// 사라졌다고 이 안전망까지 같이 사라지면 QA가 네 번 찾아낸 결함이 그대로 돌아온다.**
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

  it("수신자가 지정돼 있는데 아무도 휴대폰 번호가 없으면 불건강이다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
      const { rows } = await q.query(
        "insert into employees (name, email) values ('번호없음', $1) returning id", [UNLINKED]);
      await q.query("insert into alert_recipients (employee_id) values ($1)", [rows[0].id]);
    });
    const out = await health();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/보낼 수 있는 휴대폰 번호를 가진 사람이 0명/);
  });

  it("한 명이라도 번호가 있으면 그 사유는 없다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
    });
    await ensureAlertable();
    const out = await health();
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/휴대폰 번호를 가진 사람이 0명/);
  });

  it("수신자가 아예 지정되지 않았어도 불건강이다", async () => {
    await withService(async (q) => {
      await healthyCollection(q);
      await clearRecipients(q);
    });
    const out = await health();
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

  // 이 사유일 때는 문자로 알릴 수 없다(그 통로가 없다는 것이 곧 사유다).
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
  const PHONE = "010-7000-0003";

  async function makeRecipient() {
    return withService(async (q) => {
      const { rows } = await q.query(
        `insert into employees (name, email, phone, role)
         values ('감시테스트', $1, $2, 'staff')
         on conflict (email) do update set phone = excluded.phone
         returning id`,
        [EMAIL, PHONE],
      );
      await q.query("insert into alert_recipients (employee_id) values ($1) on conflict do nothing", [rows[0].id]);
      return rows[0].id as string;
    });
  }

  afterEach(async () => {
    await clearGuideline();
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
    expect(sent[0].to).toBe(PHONE);
    expect(sent[0].text).toMatch(/수집/);
  });

  // 정상인데도 6시간마다 메시지가 오면 사람이 곧 무시하기 시작한다.
  // 그 뒤엔 진짜 사고 메시지도 함께 묻힌다.
  it("정상이면 아무에게도 보내지 않는다", async () => {
    await makeRecipient();
    // "정상"의 전제를 이 테스트가 직접 만든다. 예전에는 다른 파일이 남긴 지침 행에
    // 기대고 있었다 — 그 파일이 먼저 돌면 통과하고 나중에 돌면 실패하는, 스스로는
    // 아무것도 보장하지 않는 테스트였다(회귀 검증 §A-2).
    await ensureGuideline();
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const { sent, channel } = recorder();
    await reportIfUnhealthy({ channel });
    expect(sent).toHaveLength(0);
  });

  // 감지는 했는데 **알리지 못한** 경우. 예전에는 send의 반환값을 버려서, 제공자
  // 설정이 틀려 한 통도 못 나가도 이 함수는 "알렸다"고 여기고 조용히
  // 끝났다 — 문제를 찾고도 그 사실이 아무 데도 남지 않는, 이 시스템에서 가장 위험한
  // 종류의 침묵이다.
  it("전원에게 전달하지 못하면 그 사실을 로그에 남긴다", async () => {
    await makeRecipient();
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')"),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: NotificationChannel = { async send() { return { ok: false, error: "제공자 오류" }; } };
    await reportIfUnhealthy({ channel: failing });
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/모두에게 전달하지 못했습니다/);
    err.mockRestore();
  });

  // 번호가 없는 직원에게 보내려 하면 제공자가 요청 자체를 거절한다.
  it("휴대폰 번호가 없는 수신자에게는 보내지 않는다", async () => {
    const id = await makeRecipient();
    await withService((q) => q.query("update employees set phone = null where id = $1", [id]));
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

  // **지금은 200이 나올 수 없다.** LMS 제공자 자료를 아직 받지 못해 로그 전용이
  // 유일한 구현이고, 그 사실이 언제나 사유 하나를 만든다(사용자 판정 2).
  //
  // 그래서 이 테스트가 지키는 것은 "정상이면 200"이 아니라 **"빨간불의 이유가
  // 정확히 그것 하나여야 한다"**이다. 다른 사유가 함께 섞여 있으면 그것은 이
  // 시스템에 SMS 말고도 다른 문제가 있다는 뜻이고, 사유 하나가 빠져 있으면
  // 발송 상태를 초록으로 칠한 것이다. 제공자가 붙는 날 이 테스트는 실패하고,
  // 그때 고칠 곳이 어디인지는 실패 문구가 그대로 말해 준다.
  it("다른 모든 것이 정상이어도 SMS 미연동 하나 때문에 503이다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const { app } = await import("../src/index.ts");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.reasons).toEqual([LOG_ONLY_REASON]);
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
    const out = await health();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/4종이 모두 꺼져/);
  });

  // 계절에 따라 폭염을 꺼 두는 것은 정상 운영이다. 여기까지 사유로 울리면
  // 운영자가 6시간마다 오는 메시지를 곧 무시하게 되고 진짜 사고도 함께 묻힌다.
  it("한 종류만 꺼 두는 것은 사유가 아니다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService((q) => q.query("update alert_settings set enabled = false where kind = 'heat'"));
    const out = await health();
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/꺼져/);
  });

  // 설치 직후의 기본 상태다. 지침이 0건이면 초안(composeDraft)이 빈 배열이라
  // 승인해도 나갈 곳이 없다 — 그런데 지금까지 어떤 지표도 그것을 말하지 않았다.
  it("내용이 있는 지침이 한 건도 없으면 문제로 본다", async () => {
    await healthyPipes();
    const out = await health();
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
    const out = await health();
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
    const out = await health();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수신자가 한 명도 없는 부서가 1곳/);
  });

  // QA W-10의 남은 절반 — **이미 저장된** 잘못된 기준값.
  //
  // 저장은 api/dashboard.ts가 막지만 그 검증 이전에 저장된 값과 DB를 직접 고친 경우가
  // 남는다. 키가 오타 나 있으면 engine의 exceeds가 undefined와 비교하므로 그 종류의
  // 특보가 **영원히** 뜨지 않는데, 화면에는 빈칸으로만 보이고 어떤 지표도 말하지 않았다.
  describe("특보 기준 값이 판정에 쓸 수 없는 상태", () => {
    // weather_criteria는 시드 8행이고 모든 테스트 파일이 공유한다 — 값을 **되돌린다**
    // (지우는 것도, 임의의 값으로 덮는 것도 아니다). 실제로 한 번 시드 값을 다른
    // 값으로 덮어써 rls.test.ts를 깨뜨렸다.
    let original: unknown;
    beforeEach(async () => {
      original = await withService(async (q) => {
        const { rows } = await q.query(
          "select threshold from weather_criteria where kind = 'rain' and grade = 'watch'",
        );
        return rows[0]?.threshold;
      });
    });

    afterEach(async () => {
      await withService((q) =>
        q.query(
          `update weather_criteria set threshold = $1::jsonb where kind = 'rain' and grade = 'watch'`,
          [JSON.stringify(original)],
        ),
      );
    });

    it("키가 오타 난 기준이 있으면 문제로 본다", async () => {
      await healthyPipes();
      await ensureGuideline();
      await withService((q) =>
        q.query(
          `update weather_criteria set threshold = '{"rain_mm": 30}'::jsonb
            where kind = 'rain' and grade = 'watch'`,
        ),
      );
      const out = await health();
      expect(out.ok).toBe(false);
      expect(out.reasons.join()).toMatch(/특보 기준 값이 잘못돼 판정할 수 없는 항목이 있습니다: 폭우 주의보/);
    });

    it("0이 저장돼 있으면(매시간 특보가 뜬다) 그것도 문제로 본다", async () => {
      await healthyPipes();
      await ensureGuideline();
      await withService((q) =>
        q.query(
          `update weather_criteria set threshold = '{"rain_mm_per_hr": 0}'::jsonb
            where kind = 'rain' and grade = 'watch'`,
        ),
      );
      const out = await health();
      expect(out.ok).toBe(false);
      expect(out.reasons.join()).toMatch(/특보 기준 값이 잘못돼/);
    });

    // 시드 그대로의 정상 상태에서 이 사유가 울리면 6시간마다 헛경보가 나간다.
    it("시드 기준값 8행은 사유가 아니다", async () => {
      await healthyPipes();
      await ensureGuideline();
      const out = await health();
      expect(out.reasons.join()).not.toMatch(/특보 기준 값이/);
    });
  });

  // 검증 §신규-1 — 이 프로젝트가 네 번째로 만난 "알릴 수 없는데 전부 초록".
  //
  // 부서 수신자는 **특보를 실제로 받는 사람**인데, checkHealth도 셋업 체크리스트도
  // Alert 수신자(승인자)만 셌다. 그래서 부서 수신자 전원에게 번호가 없으면
  // 승인 발송·매시간 반복 발송이 0명에게 나가는데 하트비트·워치독·health/deep이
  // 전부 초록이었다(실측: `sent_count:0` + `ok:true`).
  it("지침·수신자는 있는데 그 부서에 번호 있는 사람이 0명이면 문제로 본다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService((q) =>
      q.query("update employees set phone = null where email = $1", [GUIDE.email]),
    );
    const out = await health();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/휴대폰 번호를 가진 수신자가 한 명도 없는 부서가 1곳/);
  });

  // 수신자가 아예 없는 부서를 두 사유가 각각 세면 운영자는 부서 수를 두 배로 읽고
  // 있지도 않은 부서를 찾아 헤맨다. 앞의 사유("수신자가 한 명도 없는")만 낸다.
  it("수신자가 아예 없는 부서를 '번호 없음'으로 두 번 세지 않는다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService((q) =>
      q.query(
        "delete from recipients where department_id in (select id from departments where name = $1)",
        [GUIDE.dept],
      ),
    );
    const out = await health();
    expect(out.reasons.join()).toMatch(/수신자가 한 명도 없는 부서가 1곳/);
    expect(out.reasons.join()).not.toMatch(/휴대폰 번호를 가진 수신자가 한 명도 없는 부서/);
  });

  // 회귀 검증 §B-2 — `count(*)`가 부서가 아니라 **지침 행**을 셌다. 한 부서에
  // (종류×등급) 지침을 여러 개 달면 "부서가 3곳입니다"가 되고, 운영자는 있지도
  // 않은 두 부서를 찾아 헤맨다. 시드 조직을 다 채우면 "8곳"이 된다.
  it("'부서 N곳'이 지침 행 수가 아니라 부서 수다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService(async (q) => {
      const { rows } = await q.query("select id from departments where name = $1", [GUIDE.dept]);
      // 같은 부서에 지침 3건(rain/watch는 ensureGuideline이 이미 넣었다).
      for (const [kind, grade] of [["rain", "warning"], ["snow", "watch"]]) {
        await q.query(
          `insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice)
           values ($1, $2, $3, $4, '안내문')`,
          [rows[0].id, kind, grade, ["제설 대기"]],
        );
      }
      await q.query(
        "delete from recipients where department_id in (select id from departments where name = $1)",
        [GUIDE.dept],
      );
    });
    const out = await health();
    expect(out.reasons.join()).toMatch(/수신자가 한 명도 없는 부서가 1곳/);
    expect(out.reasons.join()).not.toMatch(/부서가 3곳/);
  });

  // 회귀 검증 §B-1 — 발송에 아무 영향도 없는 행 하나가 시스템 전체를 503으로 만들었다.
  // `composeDraft` 호출부·대시보드 체크리스트·지침 화면은 그 행을 "없는 지침"으로
  // 세는데 checkHealth만 `cardinality(staff_actions) > 0`이라 "있다"로 셌다.
  // 두 화면이 같은 순간 정반대로 말했다.
  it("공백만 든 지침은 '있는 지침'으로 세지 않는다", async () => {
    await healthyPipes();
    await ensureGuideline();
    await withService(async (q) => {
      // 공백만 든 항목 + 빈 안내문. 수신자도 지운다 — 옛 기준이면 "수신자가 없는
      // 부서 1곳"으로 503이 되고, 새 기준이면 "지침이 한 건도 없습니다"가 된다.
      await q.query("update action_guidelines set staff_actions = $1, guest_notice = ''", [["  "]]);
      await q.query(
        "delete from recipients where department_id in (select id from departments where name = $1)",
        [GUIDE.dept],
      );
    });
    const out = await health();
    expect(out.reasons.join()).not.toMatch(/수신자가 한 명도 없는 부서/);
    expect(out.reasons.join()).toMatch(/행동지침이 한 건도 없습니다/);
  });

  // 회귀 §F-1 — 라운드 B가 재알림에 상한(6회)을 넣으면서 **시끄러운 문제를 조용한
  // 문제로 바꿨다.** 상한에 닿으면 재알림이 조회에서 빠지고 두 번 다시 나가지 않는데,
  // 10시간째 승인 대기인 특보를 두고 health/deep이 `{"ok":true}`였다. 수정 전에는
  // 최소한 승인될 때까지 계속 두드렸다.
  describe("승인되지 않고 방치된 특보 (회귀 §F-1)", () => {
    async function pendingEvent(opts: { agoHours: number; remindCount: number }): Promise<string> {
      return withService(async (q) => {
        const { rows } = await q.query(
          `insert into weather_events (kind, grade, status, detected_at, remind_count)
           values ('wind', 'watch', 'PENDING_APPROVAL', now() - ($1 || ' hours')::interval, $2)
           returning id`,
          [String(opts.agoHours), opts.remindCount],
        );
        return rows[0].id as string;
      });
    }

    afterEach(async () => {
      await withService((q) => q.query("delete from weather_events where kind = 'wind'"));
    });

    it("재알림 상한에 도달한 미승인 특보는 사유가 된다", async () => {
      await healthyPipes();
      await ensureGuideline();
      await pendingEvent({ agoHours: 10, remindCount: 6 });
      const out = await health();
      expect(out.ok).toBe(false);
      expect(out.reasons.join()).toMatch(/승인 대기 중인 특보 1건이 최대 10시간째 승인되지 않았습니다/);
    });

    // 재알림이 아예 돌지 않는 경우(remind-tick 고장)도 같은 결과다 — 사람이 아무
    // 재촉도 받지 못한 채 특보가 열려만 있다. remind_count로만 보면 이쪽은 영원히
    // 조용하다.
    it("재알림이 돌지 않아 횟수가 안 찬 경우에도 오래 방치되면 사유가 된다", async () => {
      await healthyPipes();
      await ensureGuideline();
      await pendingEvent({ agoHours: 5, remindCount: 0 }); // 기본 주기 30분 × 6회 = 3시간
      const out = await health();
      expect(out.ok).toBe(false);
      expect(out.reasons.join()).toMatch(/승인 대기 중인 특보 1건/);
    });

    // 방금 감지된 특보까지 사유로 울리면 6시간마다 오는 점검 메시지가 노이즈가 되고,
    // 그 뒤엔 진짜 사고도 함께 묻힌다. 재알림이 아직 제 일을 하는 구간이다.
    it("막 감지된 미승인 특보는 사유가 아니다", async () => {
      await healthyPipes();
      await ensureGuideline();
      await pendingEvent({ agoHours: 0, remindCount: 0 });
      const out = await health();
      expect(out.ok).toBe(true);
    });

    // 승인된(ACTIVE) 특보는 사람이 이미 봤다는 뜻이다.
    it("승인된 특보는 오래돼도 사유가 아니다", async () => {
      await healthyPipes();
      await ensureGuideline();
      const id = await pendingEvent({ agoHours: 10, remindCount: 6 });
      await withService((q) =>
        q.query("update weather_events set status = 'ACTIVE' where id = $1", [id]),
      );
      const out = await health();
      expect(out.ok).toBe(true);
    });

    // 재알림을 멈추기로 한 이상, 그 상태가 **사람에게 닿아야** 한다. 6시간마다 도는
    // 워치독이 Alert 수신자에게 DM으로 같은 사유를 보낸다 — 상한 도달이 침묵이 아니라
    // "더 느린 두드림"이 된다.
    it("워치독이 그 사유를 Alert 수신자에게 실제로 보낸다", async () => {
      await healthyPipes();
      await ensureGuideline();
      await pendingEvent({ agoHours: 10, remindCount: 6 });
      const { sent, channel } = recorder();
      await reportIfUnhealthy({ channel });
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.map((m) => m.text).join()).toMatch(/승인 대기 중인 특보 1건/);
    });
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
    const out = await health();
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
    const out = await health();
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
    const out = await health();
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
    const out = await health();
    expect(out.ok).toBe(false);
    // "수집이 멈췄다"가 아니라 **왜** 멈추는지를 말해야 한다 — 하트비트는
    // 방금 정상으로 찍었으므로 다른 사유는 나올 수 없다.
    expect(out.reasons.join()).toMatch(/nx=-1/);
    expect(out.reasons.join()).toMatch(/기상청 격자/);
  });

  it("ny가 격자 상한을 넘어도 사유가 된다", async () => {
    await withService((q) => q.query("update site_settings set ny = 9999 where id = 1"));
    const out = await health();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/ny=9999/);
  });

  it("범위 안의 좌표에서는 이 사유가 나오지 않는다", async () => {
    await withService((q) => q.query("update site_settings set nx = 61, ny = 121 where id = 1"));
    const out = await health();
    expect(out.reasons.join()).not.toMatch(/격자/);
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 25번째 "아무에게도 못 가는데 전부 초록" — 실효 발송 채널이 로그 전용이다
// ---------------------------------------------------------------------------
//
// 열거 표(라운드 E)가 24개 경로를 적고 각 경로마다 지표를 붙였는데, **메시지가
// 실제로 어디로 가는가**를 묻는 칸이 없었다. 실효 채널이 로그 전용이면: 수신자·
// 승인자 전부 "닿을 수 있음" → 셋업 체크리스트·health/deep 전부 초록 → 승인은
// `{"ok":true,"sent_count":1}`. 그런데 그 메시지는 전부 앱 로그로만 갔다.
// 라운드 E가 넣은 "0명 전달" 방어조차 우회한다 — 로그 채널의 send가 ok:true를
// 주므로 코드 입장에서 발송은 성공이다.
//
// **SMS 전환으로 이 경로는 "설정 실수"에서 "지금의 상태"가 됐다.** 제공자 자료를
// 받기 전까지 로그 전용이 유일한 구현이므로 이 사유는 언제나 켜져 있다.
describe("실효 발송 채널이 로그 전용이면", () => {
  beforeEach(ensureAlertable);
  afterEach(clearAlertable);

  it("다른 모든 지표가 초록이어도 사유를 낸다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    // 실채널을 주입하면 ok:true인 바로 그 상태 — 남은 문제는 "어디로 가는가" 하나다.
    expect((await health()).ok).toBe(true);

    const out = await checkHealth({ channel: new LogOnlyChannel() });
    expect(out.ok).toBe(false);
    // **문구를 글자 그대로 고정한다**(사용자 판정 2). 이 문장이 지금 이 시스템의
    // 상태를 대표하고, 흐려지면 빨간불의 이유가 무엇이었는지 아무도 모르게 된다.
    expect(out.reasons).toContain(LOG_ONLY_REASON);
    expect(LOG_ONLY_REASON).toBe("SMS 발송 설정이 아직 없습니다 — 인프라 연동 대기 중");
  });

  // **수신자가 한 명도 없어도 울린다.** 카카오워크 시절에는 "연결된 수신자가 한
  // 명이라도 있을 때만" 울리도록 조건을 걸어 설치 직후의 잡음을 피했다. 그때는
  // `.env` 한 줄로 고칠 수 있는 설정 실수였기 때문이다. 지금은 시스템에 아예 없는
  // 기능이고, 수신자가 0명이든 100명이든 "아무에게도 못 보낸다"는 사실은 같다.
  // 조건을 되살리면 갓 설치한 시스템의 "실제 발송" 항목이 초록으로 보인다.
  it("수신자가 한 명도 없어도(설치 직후) 이 사유는 나온다", async () => {
    await clearAlertable();
    await withService(async (q) => {
      await q.query("delete from alert_recipients");
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const out = await checkHealth({ channel: new LogOnlyChannel() });
    expect(out.reasons).toContain(LOG_ONLY_REASON);
    await ensureAlertable(); // afterEach의 clear와 짝을 맞춘다
  });

  // 운영자가 실제로 보는 자리. 채널 주입 없이 **환경변수만으로** 이 상태가 되는지를
  // HTTP로 확인한다 — 채널 주입은 테스트만 할 수 있는 일이다.
  it("/api/health/deep이 503으로 내려간다 (제공자 미설정 그대로)", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const { app } = await import("../src/index.ts");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).toBe(503);
    expect(res.body.reasons).toContain(LOG_ONLY_REASON);
  });

  // 워치독의 점검과 발송이 **같은 채널**을 봐야 한다. 다르면 "로그 전용입니다"라는
  // 사유를 실채널로 보내거나 그 반대가 된다. 이 상태에서 그 경고가 실제로 나가는
  // 곳은 앱 로그뿐이고(그게 사유 그 자체다), 그 한 줄이 유일한 흔적이다.
  it("워치독이 이 사유를 실제로 내보낸다 (그 통로도 로그뿐이다)", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await insertObs(q, [{ ago: "0 seconds", missing: false, temp: 20 }]);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await reportIfUnhealthy({ channel: new LogOnlyChannel() });
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    expect(printed).toMatch(/\[log-channel\]/);
    expect(printed).toContain(LOG_ONLY_REASON);
  });
});
