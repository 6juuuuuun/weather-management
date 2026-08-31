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

  // ok/note는 수집 실패 사유가 담기는 자리다 — 빠지면 화면이 "왜 멈췄는지"를
  // 보여줄 수 없다.
  it("ok와 note를 함께 돌려준다", async () => {
    await withService((q) =>
      q.query(
        `insert into heartbeats (name, last_run_at, ok, note) values ('remind-tick', now(), false, '기상청 API 타임아웃')
         on conflict (name) do update set ok = excluded.ok, note = excluded.note`,
      ),
    );
    const agent = await loggedIn();
    const res = await agent.get("/api/heartbeats/remind-tick");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.note).toBe("기상청 API 타임아웃");
  });
});


describe("특보 기준 저장", () => {
  async function restoreSeedCriteria() {
    await withService((q) =>
      q.query(`
        update weather_criteria set threshold = '{"snow_cm":5}' where kind='snow' and grade='watch';
        update weather_criteria set threshold = '{"wind_ms":21}' where kind='wind' and grade='warning';
      `),
    );
  }

  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).put("/api/criteria").send({ rows: [] })).status).toBe(401);
  });

  it("일반 직원은 저장할 수 없다", async () => {
    const agent = await loggedIn();
    const res = await agent.put("/api/criteria").send({
      rows: [{ kind: "snow", grade: "watch", threshold: { snow_cm: 999 } }],
    });
    expect(res.status).toBe(403);
    const row = await withService(async (q) => {
      const { rows } = await q.query("select threshold from weather_criteria where kind='snow' and grade='watch'");
      return rows[0].threshold;
    });
    // 403이 실제 게이트에서 났는지 — DB 값이 시드 그대로여야 한다.
    expect(row).toEqual({ snow_cm: 5 });
  });

  async function adminAgent() {
    const who = { email: "criteria-admin@gonjiam.com", password: "criteria-password-1", name: "관리자" };
    await request(app).post("/api/auth/signup").send(who);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [who.email]));
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
    return agent;
  }

  it("관리자는 저장할 수 있고 (kind,grade) 충돌 시 값이 실제로 바뀐다", async () => {
    const admin = await adminAgent();
    try {
      const res = await admin.put("/api/criteria").send({
        rows: [{ kind: "snow", grade: "watch", threshold: { snow_cm: 7 } }],
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ kind: "snow", grade: "watch", threshold: { snow_cm: 7 } }]);

      // 행 개수가 그대로 8개여야 한다 — upsert가 insert만 하고 conflict 처리가
      // 빠지면(또는 반대로 늘 insert만 하면) 8을 넘긴다.
      const count = await withService(async (q) => {
        const { rows } = await q.query("select count(*)::int as n from weather_criteria");
        return rows[0].n;
      });
      expect(count).toBe(8);

      const row = await withService(async (q) => {
        const { rows } = await q.query("select threshold from weather_criteria where kind='snow' and grade='watch'");
        return rows[0].threshold;
      });
      expect(row).toEqual({ snow_cm: 7 });
    } finally {
      await restoreSeedCriteria();
    }
  });

  it("잘못된 kind면 400이고 스택트레이스나 파일 경로가 새지 않는다", async () => {
    const admin = await adminAgent();
    const res = await admin.put("/api/criteria").send({
      rows: [{ kind: "typhoon", grade: "watch", threshold: { x: 1 } }],
    });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.text).not.toMatch(/\/Users\/|\bat \/|node_modules/);
  });

  it("잘못된 grade면 400이고, 배치에 섞인 유효한 행도 함께 거부된다", async () => {
    const admin = await adminAgent();
    const res = await admin.put("/api/criteria").send({
      rows: [
        { kind: "wind", grade: "warning", threshold: { wind_ms: 999 } },
        { kind: "wind", grade: "severe", threshold: { wind_ms: 1 } },
      ],
    });
    expect(res.status).toBe(400);
    const row = await withService(async (q) => {
      const { rows } = await q.query("select threshold from weather_criteria where kind='wind' and grade='warning'");
      return rows[0].threshold;
    });
    // 배치 전체 거부 — 유효했던 첫 행(wind/warning)조차 반영되지 않아야 한다.
    expect(row).toEqual({ wind_ms: 21 });
  });
});

describe("사이트 설정 저장", () => {
  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).patch("/api/site-settings").send({ nx: 1 })).status).toBe(401);
  });

  it("사이트 설정 조회는 실제 컬럼을 전부 돌려준다", async () => {
    await withService((q) => q.query("insert into site_settings (id) values (1) on conflict do nothing"));
    const agent = await loggedIn();
    const res = await agent.get("/api/site-settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: 1,
        site_name: expect.any(String),
        address: expect.any(String),
        nx: expect.any(Number),
        ny: expect.any(Number),
        remind_interval_min: expect.any(Number),
        resolve_notice: expect.any(Boolean),
      }),
    );
    expect(res.body.updated_at).toBeTruthy();
  });

  it("일반 직원은 저장할 수 없다", async () => {
    await withService((q) => q.query("insert into site_settings (id) values (1) on conflict do nothing"));
    const agent = await loggedIn();
    const res = await agent.patch("/api/site-settings").send({ nx: 999 });
    expect(res.status).toBe(403);
    const nx = await withService(async (q) => {
      const { rows } = await q.query("select nx from site_settings where id = 1");
      return rows[0].nx;
    });
    expect(nx).not.toBe(999);
  });

  it("관리자는 일부 필드만 보내도 나머지는 그대로 저장한다 (부분 갱신)", async () => {
    await withService((q) =>
      q.query(
        "insert into site_settings (id, site_name, nx, ny) values (1, '원래이름', 61, 121) on conflict (id) do update set site_name = excluded.site_name, nx = excluded.nx, ny = excluded.ny",
      ),
    );
    const who = { email: "site-admin@gonjiam.com", password: "site-password-1", name: "관리자" };
    await request(app).post("/api/auth/signup").send(who);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [who.email]));
    const admin = request.agent(app);
    await admin.post("/api/auth/login").send({ email: who.email, password: who.password });

    const res = await admin.patch("/api/site-settings").send({ nx: 70 });
    expect(res.status).toBe(200);
    expect(res.body.nx).toBe(70);
    // 본문에 없던 site_name이 지워지거나 null이 되면 안 된다.
    expect(res.body.site_name).toBe("원래이름");

    // 원상 복구 — site_settings는 단일 행(id=1)이라 delete로 정리할 수 없다.
    await withService((q) => q.query("update site_settings set site_name='곤지암', nx=61, ny=121 where id=1"));
  });

  it("변경할 값이 없으면 400이다", async () => {
    await withService((q) => q.query("insert into site_settings (id) values (1) on conflict do nothing"));
    const who = { email: "site-empty-admin@gonjiam.com", password: "site-password-1", name: "관리자" };
    await request(app).post("/api/auth/signup").send(who);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [who.email]));
    const admin = request.agent(app);
    await admin.post("/api/auth/login").send({ email: who.email, password: who.password });
    expect((await admin.patch("/api/site-settings").send({})).status).toBe(400);
  });
});

describe("관측 단건 조회", () => {
  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/observations/999999999")).status).toBe(401);
  });

  it("id로 정확히 그 관측 1건을 돌려준다", async () => {
    const id = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into weather_observations (observed_at, rain_mm_per_hr, missing) values (now() - interval '1 hour', 12.3, false) returning id",
      );
      return rows[0].id;
    });
    const agent = await loggedIn();
    const res = await agent.get(`/api/observations/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.rain_mm_per_hr).toBe(12.3);
  });

  it("id 형식이 잘못되면 400이다", async () => {
    const agent = await loggedIn();
    expect((await agent.get("/api/observations/not-a-number")).status).toBe(400);
  });

  it("없는 id면 null을 돌려준다", async () => {
    const agent = await loggedIn();
    const res = await agent.get("/api/observations/999999999");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  // /observations/latest·/observations?since=가 :id로 잘못 잡히지 않는지 확인한다 —
  // 라우트 등록 순서가 바뀌면(observations/:id가 먼저 오면) "latest"가 숫자가 아니라서
  // 400이 나거나, 엉뚱한 응답이 나야 할 자리에서 200이 나는 식으로 깨진다.
  it("observations/latest·observations?since= 경로와 충돌하지 않는다", async () => {
    await withService((q) =>
      q.query("insert into weather_observations (observed_at, missing) values (now() - interval '1 hour', false)"),
    );
    const agent = await loggedIn();
    const latest = await agent.get("/api/observations/latest");
    expect(latest.status).toBe(200);
    const since = await agent.get(`/api/observations?since=${encodeURIComponent(new Date(0).toISOString())}`);
    expect(since.status).toBe(200);
    expect(Array.isArray(since.body)).toBe(true);
  });
});
