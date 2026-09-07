import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

// helpers.ts는 이 저장소에 존재하지 않는다. 실제 관례(server/test/api-dashboard.test.ts:6-12)를
// 따라 이 테스트 파일 안에 작은 로컬 헬퍼를 둔다. 이메일은 다른 스위트와 겹치지 않게 고른다.
async function loggedIn() {
  const who = { email: "fcst@gonjiam.com", password: "fcst-password-1", name: "예보조회" };
  await request(app).post("/api/auth/signup").send(who);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return agent;
}

process.env.SMS_PROVIDER = "";

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from weather_forecasts");
    await q.query("delete from heartbeats where name = 'forecast-tick'");
  });
});

async function seed(rows: { at: string; temp?: number; pcp?: number; sno?: number; pop?: number; sky?: number }[]) {
  await withService(async (q) => {
    for (const r of rows) {
      await q.query(
        `insert into weather_forecasts (fcst_at, temp_c, pcp_mm, sno_cm, pop_pct, sky, base_at, fetched_at)
         values ($1,$2,$3,$4,$5,$6, now(), now())`,
        [new Date(r.at), r.temp ?? null, r.pcp ?? null, r.sno ?? null, r.pop ?? null, r.sky ?? null],
      );
    }
    await q.query("insert into heartbeats (name, last_run_at, ok) values ('forecast-tick', now(), true)");
  });
}

describe("GET /api/forecast", () => {
  it("로그인하지 않으면 401이다", async () => {
    await request(app).get("/api/forecast").expect(401);
  });

  it("시간별과 일별을 함께 내려준다", async () => {
    const agent = await loggedIn();
    await seed([{ at: new Date(Date.now() + 3600e3).toISOString(), temp: 20, pop: 30, sky: 1 }]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toHaveLength(1);
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.stale).toBe(false);
  });

  // 지난 예보를 내려주면 화면의 스트립이 과거부터 시작한다.
  it("지난 시각은 내려주지 않는다", async () => {
    const agent = await loggedIn();
    await seed([
      { at: new Date(Date.now() - 3600e3).toISOString(), temp: 18 },
      { at: new Date(Date.now() + 3600e3).toISOString(), temp: 20 },
    ]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toHaveLength(1);
  });

  it("시간별은 48시간까지만 내려준다", async () => {
    const agent = await loggedIn();
    await seed([
      { at: new Date(Date.now() + 3600e3).toISOString(), temp: 20 },
      { at: new Date(Date.now() + 72 * 3600e3).toISOString(), temp: 15 },
    ]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toHaveLength(1);
    // 일별은 48시간 밖까지 포함한다 — 5일 요약을 그려야 한다.
    expect(res.body.daily.length).toBeGreaterThan(1);
  });

  // 판정은 서버가 한다. 화면에 임계 비교가 들어가면 두 화면이 갈라진다.
  it("예고 판정 결과를 함께 내려준다", async () => {
    const agent = await loggedIn();
    await seed([{ at: new Date(Date.now() + 3600e3).toISOString(), pcp: 60 }]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.upcoming).toHaveLength(1);
    expect(res.body.upcoming[0].kind).toBe("rain");
  });

  // 화면이 스스로 시간을 재면 두 화면의 기준이 갈라진다(notifiable과 같은 이유).
  it("낡음 판정을 서버가 내려준다", async () => {
    const agent = await loggedIn();
    await seed([{ at: new Date(Date.now() + 3600e3).toISOString(), temp: 20 }]);
    await withService((q) =>
      q.query(`update heartbeats set last_run_at = now() - interval '7 hours' where name = 'forecast-tick'`));
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.stale).toBe(true);
  });

  // 스트립이 어느 칸을 칠할지 화면이 스스로 정하면, 배너·스트립·실제 특보가
  // 각자 다른 기준을 갖게 된다.
  it("시각마다 무엇을 넘는지 함께 내려준다", async () => {
    const agent = await loggedIn();
    await seed([
      { at: new Date(Date.now() + 3600e3).toISOString(), pcp: 25 },
      { at: new Date(Date.now() + 7200e3).toISOString(), pcp: 5 },
    ]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly[0].exceeds).toEqual([{ kind: "rain", grade: "watch" }]);
    expect(res.body.hourly[1].exceeds).toEqual([]);
  });

  it("예보가 하나도 없으면 빈 배열을 준다", async () => {
    const agent = await loggedIn();
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toEqual([]);
    expect(res.body.daily).toEqual([]);
    expect(res.body.upcoming).toEqual([]);
  });
});
