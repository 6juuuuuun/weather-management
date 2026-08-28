import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

async function loggedIn() {
  const who = { email: "view@gonjiam.com", password: "view-password-1", name: "조회자" };
  await request(app).post("/api/auth/signup").send(who);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return agent;
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from weather_observations");
    // weather_events는 messages를 on delete cascade로 끌고 온다. dispatches는
    // messages를 참조하지만(cascade 없음) 이 스위트가 dispatches를 만들지 않으므로
    // 안전하게 지울 수 있다. 지우지 않으면 "열린 특보만 돌려준다" 테스트가 이전
    // 실행이 남긴 행까지 세어 통계가 어긋난다.
    await q.query("delete from weather_events");
    // "특보 기준을 돌려준다" 테스트가 withService로 rain/warning을 심는데,
    // withService는 커밋한다 — 지우지 않으면 그 값이 테스트 종료 후에도 DB에
    // 영구히 남고, 실제 시드값(rain/warning=50)을 20으로 덮어써 버린다.
    // db/seed.sql이 있는 실제 환경이라면 그다음 seed 재적용이
    // "duplicate key" 없이도 값이 계속 20으로 남는, 조용히 틀린 상태가 된다.
    await q.query("delete from weather_criteria");
    // 하트비트도 같은 이유로 지운다 — upsert라 행이 늘진 않지만, 테스트가 찍은
    // 시각이 실제 수집기가 남긴 값을 영구히 덮어쓴 채로 남는다.
    await q.query("delete from heartbeats");
  });
});

describe("관측 조회", () => {
  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/observations/latest")).status).toBe(401);
  });

  // 회귀: 예전에는 결측 여부를 보지 않고 '가장 최근 행'을 읽었다. 기상청이 한 번만
  // 실패해도 빈 행이 최신이 되어 전 카드가 비었다.
  it("최신 관측에서 결측 행을 제외한다", async () => {
    await withService(async (q) => {
      await q.query(
        `insert into weather_observations (observed_at, temp_c, missing)
         values (now() - interval '2 hours', 21.5, false), (now() - interval '1 hour', null, true)`,
      );
    });
    const agent = await loggedIn();
    const res = await agent.get("/api/observations/latest");
    expect(res.status).toBe(200);
    expect(res.body.temp_c).toBe(21.5);
  });

  it("이력 조회는 로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/observations?since=2026-01-01T00:00:00Z")).status).toBe(401);
  });

  it("이력 조회는 since 이후만 돌려주고 오래된 순으로 정렬한다", async () => {
    await withService((q) =>
      q.query(
        `insert into weather_observations (observed_at, temp_c, missing) values
         (now() - interval '30 hours', 10, false),
         (now() - interval '3 hours', 20, false),
         (now() - interval '1 hour', 30, false)`,
      ),
    );
    const agent = await loggedIn();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await agent.get(`/api/observations?since=${encodeURIComponent(since)}`);
    expect(res.body.map((r: any) => r.temp_c)).toEqual([20, 30]);
  });

  // 이력 조회도 결측 행을 제외해야 한다 — 최신 조회와 같은 회귀가 여기서도 날 수 있다.
  it("이력 조회도 결측 행을 제외한다", async () => {
    await withService((q) =>
      q.query(
        `insert into weather_observations (observed_at, temp_c, missing) values
         (now() - interval '2 hours', 15, false),
         (now() - interval '1 hour', null, true)`,
      ),
    );
    const agent = await loggedIn();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await agent.get(`/api/observations?since=${encodeURIComponent(since)}`);
    expect(res.body.map((r: any) => r.temp_c)).toEqual([15]);
  });

  it("since가 없으면 400이다", async () => {
    const agent = await loggedIn();
    expect((await agent.get("/api/observations")).status).toBe(400);
  });
});

describe("열린 특보 조회", () => {
  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/events/open")).status).toBe(401);
  });

  // 회귀 대상: RESOLVED·DISMISSED까지 섞여 나오면 대시보드가 이미 끝났거나 반려된
  // 특보를 계속 열려 있는 것처럼 보여준다. status 필터를 지우면 이 테스트가 깨진다.
  it("PENDING_APPROVAL·ACTIVE만 돌려주고 RESOLVED·DISMISSED는 제외한다", async () => {
    await withService((q) =>
      q.query(
        `insert into weather_events (kind, grade, status) values
         ('rain','watch','PENDING_APPROVAL'),
         ('snow','warning','ACTIVE'),
         ('wind','watch','RESOLVED'),
         ('heat','warning','DISMISSED')`,
      ),
    );
    const agent = await loggedIn();
    const res = await agent.get("/api/events/open");
    expect(res.status).toBe(200);
    const statuses = res.body.map((e: any) => e.status).sort();
    expect(statuses).toEqual(["ACTIVE", "PENDING_APPROVAL"]);
  });
});

describe("기준·설정 조회", () => {
  it("특보 기준은 로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/criteria")).status).toBe(401);
  });

  it("특보 기준을 돌려준다", async () => {
    await withService((q) =>
      q.query(
        `insert into weather_criteria (kind, grade, threshold) values
         ('rain', 'warning', '{"rain_mm_per_hr":20}')
         on conflict (kind, grade) do update set threshold = excluded.threshold`,
      ),
    );
    const agent = await loggedIn();
    const res = await agent.get("/api/criteria");
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({
      kind: "rain",
      grade: "warning",
      threshold: { rain_mm_per_hr: 20 },
    });
  });

  it("사이트 설정은 로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/site-settings")).status).toBe(401);
  });

  it("사이트 설정을 돌려준다", async () => {
    await withService((q) => q.query("insert into site_settings (id) values (1) on conflict do nothing"));
    const agent = await loggedIn();
    const res = await agent.get("/api/site-settings");
    expect(res.status).toBe(200);
    expect(res.body.site_name).toBe("곤지암");
  });

  it("하트비트는 로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/heartbeats/weather-tick")).status).toBe(401);
  });

  it("이름으로 하트비트를 돌려준다", async () => {
    await withService((q) =>
      q.query(
        `insert into heartbeats (name, last_run_at, ok) values ('weather-tick', now(), true)
         on conflict (name) do update set last_run_at = excluded.last_run_at`,
      ),
    );
    const agent = await loggedIn();
    const res = await agent.get("/api/heartbeats/weather-tick");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("weather-tick");
  });

  it("없는 이름이면 null을 돌려준다", async () => {
    const agent = await loggedIn();
    const res = await agent.get("/api/heartbeats/does-not-exist");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
