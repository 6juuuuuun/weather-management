import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { withService } from "../src/db.ts";
import { catchUpIfMissed, guarded } from "../src/jobs/scheduler.ts";

// runWeatherTick(kma 호출 포함)이 catchUpIfMissed 안에서 불릴 수 있다. 실제
// 기상청 API로 나가면 느리고 흔들리고 키가 없으면 아예 실패한다 — jobs.test.ts와
// 같은 패턴으로 fetch를 막는다.
process.env.NOTIFY_CHANNEL = "console";

function kmaResponse(items: Array<Record<string, string | undefined>>) {
  return { response: { header: { resultCode: "00" }, body: { items: { item: items } } } };
}

function stubKma(items: Array<Record<string, string | undefined>>) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(kmaResponse(items))))));
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from heartbeats");
    // "실제로 저장했는지" 테스트가 고정된 baseDate/baseTime으로 관측을 만든다.
    // 이전 실행이 남긴 같은 observed_at 행이 있으면 insert가 on-conflict update로
    // 흡수돼 행 수가 늘지 않는다 — 매번 깨끗하게 지우고 시작한다. seed 데이터가
    // 아니라 런타임 관측 로그라 지워도 무방하다(jobs.test.ts와 같은 패턴).
    await q.query("delete from weather_observations");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("기동 시 따라잡기", () => {
  // 컨테이너가 재시작하면 그 사이 주기를 놓친다. 안전 경보 시스템에서
  // 한 시간 공백은 특보를 통째로 놓친다는 뜻이다.
  it("마지막 수집이 오래됐으면 즉시 한 번 수집한다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '3 hours')"),
    );
    stubKma([]);
    expect(await catchUpIfMissed()).toBe(true);
  });

  it("방금 수집했으면 중복 실행하지 않는다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '2 minutes')"),
    );
    // 반환값 false만 보면 "실제로는 수집했는데 값만 false를 돌려주는" 구현도 통과한다 —
    // fetch가 아예 호출되지 않았는지(=runWeatherTick이 실행되지 않았는지)까지 본다.
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify(kmaResponse([])))));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await catchUpIfMissed()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("기록이 없으면 첫 실행으로 보고 수집한다", async () => {
    stubKma([]);
    expect(await catchUpIfMissed()).toBe(true);
  });

  // 반환값만 true여도 실제로 아무 일도 안 하는 구현이 통과할 수 있다 —
  // 관측이 실제로 저장되고 heartbeat가 실제로 지금 시각으로 갱신됐는지까지 본다.
  it("오래됐으면 실제로 관측을 저장하고 heartbeat를 갱신한다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '3 hours')"),
    );
    stubKma([
      { category: "RN1", obsrValue: "5", baseDate: "20260901", baseTime: "0800" },
      { category: "T1H", obsrValue: "18" }, { category: "WSD", obsrValue: "1" }, { category: "REH", obsrValue: "70" },
    ]);

    const before = await withService((q) => q.query("select count(*)::int as n from weather_observations"));
    const stale = await catchUpIfMissed();
    expect(stale).toBe(true);
    const after = await withService((q) => q.query("select count(*)::int as n from weather_observations"));
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);

    const beat = await withService((q) =>
      q.query("select last_run_at, ok from heartbeats where name = 'weather-tick'"));
    expect(beat.rows[0].ok).toBe(true);
    // 방금 갱신됐다면 Postgres now()와 몇 초 이상 차이가 날 수 없다.
    const drift = await withService((q) =>
      q.query("select extract(epoch from now() - last_run_at) as sec from heartbeats where name = 'weather-tick'"));
    expect(Number(drift.rows[0].sec)).toBeLessThan(10);
  });
});

describe("guarded", () => {
  // 한 번의 실패로 스케줄러가 죽으면 이후 모든 주기가 조용히 사라진다.
  // fn이 던져도 guarded 자체는 성공(resolve)해야 한다.
  it("job이 던진 예외를 삼키고 밖으로 새지 않게 한다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(guarded("boom-job", () => Promise.reject(new Error("boom")))).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("job이 성공하면 그대로 통과시킨다", async () => {
    let ran = false;
    await guarded("ok-job", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
