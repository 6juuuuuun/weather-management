import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { withService } from "../src/db.ts";
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

// 관측 로그와 하트비트만 지운다. 시드(부서·기준·설정)는 건드리지 않는다.
beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from heartbeats");
    await q.query("delete from weather_observations");
  });
});

describe("상태 점검", () => {
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
      await q.query("insert into weather_observations (observed_at, temp_c, missing) values (now(), 20, false)");
    });
    expect((await checkHealth()).ok).toBe(true);
  });

  it("수집은 돌지만 결측만 쌓이면 문제로 본다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await q.query(
        `insert into weather_observations (observed_at, missing) values
         (now() - interval '2 hours', true), (now() - interval '1 hour', true), (now(), true)`,
      );
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

  // 경계값을 양쪽에서 고정한다. 임계값을 아무 숫자로 바꿔도 통과하는 테스트가
  // 되지 않게, 기준 바로 앞뒤를 각각 확인한다.
  it("기준 시간 직전이면 아직 정상이다", async () => {
    await withService(async (q) => {
      await q.query(
        `insert into heartbeats (name, last_run_at)
         values ('weather-tick', now() - ($1 || ' minutes')::interval)`,
        [String(COLLECT_STALE_MIN - 5)],
      );
      await q.query("insert into weather_observations (observed_at, temp_c, missing) values (now(), 20, false)");
    });
    expect((await checkHealth()).ok).toBe(true);
  });

  it("기준 시간을 막 넘기면 문제로 본다", async () => {
    await withService(async (q) => {
      await q.query(
        `insert into heartbeats (name, last_run_at)
         values ('weather-tick', now() - ($1 || ' minutes')::interval)`,
        [String(COLLECT_STALE_MIN + 5)],
      );
      await q.query("insert into weather_observations (observed_at, temp_c, missing) values (now(), 20, false)");
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수집/);
  });

  // 결측 연속 판정이 "최근 N회"를 실제로 보는지 확인한다. 가장 최근 한 건이
  // 정상이면 수집은 살아 있는 것이므로 결측 사유가 붙으면 안 된다.
  it("가장 최근 관측이 정상이면 그 앞이 결측이어도 정상이다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await q.query(
        `insert into weather_observations (observed_at, temp_c, missing) values
         (now() - interval '3 hours', null, true),
         (now() - interval '2 hours', null, true),
         (now() - interval '1 hour',  null, true),
         (now(),                      20,   false)`,
      );
    });
    const out = await checkHealth();
    expect(out.ok).toBe(true);
    expect(out.reasons.join()).not.toMatch(/결측/);
  });

  // 관측이 아직 MISSING_STREAK 회보다 적게 쌓였을 때 결측이라고 단정하면,
  // 설치 첫 시간에 "결측만 쌓인다"는 헛경보가 나간다.
  it("관측 표본이 기준 횟수보다 적으면 결측으로 단정하지 않는다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await q.query("insert into weather_observations (observed_at, missing) values (now(), true)");
    });
    const out = await checkHealth();
    expect(out.reasons.join()).not.toMatch(/결측/);
    expect(MISSING_STREAK).toBeGreaterThan(1);
  });

  // 두 사고가 동시에 나면 둘 다 보고해야 한다. 첫 사유에서 빠져나가면
  // 운영자가 한쪽만 고치고 정상이 됐다고 오해한다.
  it("사유가 여러 개면 모두 담는다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')");
      await q.query(
        `insert into weather_observations (observed_at, missing) values
         (now() - interval '2 hours', true), (now() - interval '1 hour', true), (now(), true)`,
      );
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
      await q.query("insert into weather_observations (observed_at, temp_c, missing) values (now(), 20, false)");
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
  it("정상이면 200과 ok:true를 준다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await q.query("insert into weather_observations (observed_at, temp_c, missing) values (now(), 20, false)");
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
      await q.query("insert into weather_observations (observed_at, temp_c, missing) values (now(), 20, false)");
    });
    const { app } = await import("../src/index.ts");
    const res = await request(app).get("/api/health/deep");
    expect(res.status).not.toBe(401);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});
