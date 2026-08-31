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
    // weather_criteria는 지우지 않는다 — db/seed.sql이 (kind,grade) 8개 조합
    // 전부를 소유(기본키라 테스트가 자기 행을 따로 만들 여지가 없음)하므로,
    // 지우면 시드를 지우는 것과 같다. 아래 "특보 기준을 돌려준다" 테스트는
    // 자기 행을 심는 대신 시드가 이미 심어 둔 값을 그대로 검증한다.
    // 하트비트는 시드 소유가 아니라(upsert 대상일 뿐 seed.sql이 채우지 않음)
    // 그대로 지운다 — 테스트가 찍은 시각이 실제 수집기 값을 영구히 덮어쓴 채로
    // 남는 걸 막는다.
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

  // weather_criteria는 시드가 (kind,grade) 8개 조합을 전부 소유한다(기본키라
  // 테스트가 자기 행을 따로 만들 여지가 없다) — 이 테스트는 그 시드 값 중
  // 하나(rain/warning)를 그대로 기대값으로 쓴다(db/seed.sql). 전체 8개가 다
  // 오는지도 함께 확인해, beforeEach가 이 테이블을 지우는 회귀(리뷰에서 실제로
  // 발견됨)가 재발하면 길이 검사부터 깨지게 한다.
  it("특보 기준을 돌려준다 (시드 값)", async () => {
    const agent = await loggedIn();
    const res = await agent.get("/api/criteria");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(8);
    expect(res.body).toContainEqual({
      kind: "rain",
      grade: "warning",
      threshold: { rain_mm_per_hr: 50 },
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
