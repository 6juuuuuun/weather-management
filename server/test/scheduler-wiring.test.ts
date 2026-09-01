import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import cron from "node-cron";

// 이 파일이 따로 있는 이유: 아래 vi.mock이 네 작업 모듈을 통째로 가짜로 바꾼다.
// scheduler.test.ts는 catchUpIfMissed가 진짜 runWeatherTick을 부르는 것을 검증하므로
// 같은 파일에 둘 수 없다. vitest는 테스트 파일마다 모듈 그래프를 격리하므로
// 여기서 건 mock이 그쪽으로 새지 않는다.
//
// 무엇을 막는가: startScheduler가 cron 식과 타임존만 맞게 등록하고 **콜백이
// 아무것도 부르지 않아도** 기존 테스트는 전부 통과했다. 워치독을 no-op으로 바꾼
// 변이가 234개 테스트를 그대로 통과한 것이 실제로 확인됐다. 워치독의 존재 이유는
// "수집이 멈춘 것을 알아채고 **알리는**" 것이라, 등록만 되고 아무도 안 불리는
// 상태는 운영에서 "감지는 했는데 아무에게도 못 알리는" 실패 그 자체다.

vi.mock("../src/jobs/weatherTick.ts", () => ({ runWeatherTick: vi.fn(async () => ({})) }));
vi.mock("../src/jobs/remindTick.ts", () => ({ runRemindTick: vi.fn(async () => ({ reminded: 0 })) }));
vi.mock("../src/auth/session.ts", () => ({ purgeExpired: vi.fn(async () => 0) }));
vi.mock("../src/jobs/watchdog.ts", () => ({ reportIfUnhealthy: vi.fn(async () => {}) }));
vi.mock("../src/jobs/kakaoLinkTick.ts", () => ({ runKakaoLinkTick: vi.fn(async () => ({ candidates: 0, linked: 0 })) }));

const { runWeatherTick } = await import("../src/jobs/weatherTick.ts");
const { runRemindTick } = await import("../src/jobs/remindTick.ts");
const { purgeExpired } = await import("../src/auth/session.ts");
const { reportIfUnhealthy } = await import("../src/jobs/watchdog.ts");
const { runKakaoLinkTick } = await import("../src/jobs/kakaoLinkTick.ts");
const { startScheduler } = await import("../src/jobs/scheduler.ts");

// startScheduler는 마지막에 catchUpIfMissed도 부른다. 그건 실제 DB를 읽으므로
// 여기서는 결과를 기다리지 않고, 등록된 콜백만 본다.
function registeredCallbacks(): Map<string, () => void> {
  const spy = vi.spyOn(cron, "schedule").mockReturnValue({ stop() {} } as never);
  startScheduler();
  const map = new Map<string, () => void>();
  for (const call of spy.mock.calls) map.set(call[0] as string, call[1] as () => void);
  spy.mockRestore();
  return map;
}

beforeEach(() => {
  vi.mocked(runWeatherTick).mockClear();
  vi.mocked(runRemindTick).mockClear();
  vi.mocked(purgeExpired).mockClear();
  vi.mocked(reportIfUnhealthy).mockClear();
  vi.mocked(runKakaoLinkTick).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("스케줄 콜백이 실제로 작업을 부른다", () => {
  // 이 테스트가 없으면 "cron.schedule('0 */6 * * *', () => {})"도 통과한다.
  it("6시간마다 도는 콜백은 워치독 보고를 부른다", async () => {
    const cb = registeredCallbacks().get("0 */6 * * *");
    expect(cb).toBeTypeOf("function");
    expect(reportIfUnhealthy).not.toHaveBeenCalled();
    await cb!();
    expect(reportIfUnhealthy).toHaveBeenCalledTimes(1);
  });

  it("매시 5분 콜백은 관측 수집을 부른다", async () => {
    const cb = registeredCallbacks().get("5 * * * *");
    expect(cb).toBeTypeOf("function");
    vi.mocked(runWeatherTick).mockClear(); // 등록 시점의 catch-up 호출을 제외한다
    await cb!();
    expect(runWeatherTick).toHaveBeenCalledTimes(1);
  });

  it("10분마다 도는 콜백은 재알림을 부른다", async () => {
    const cb = registeredCallbacks().get("*/10 * * * *");
    await cb!();
    expect(runRemindTick).toHaveBeenCalledTimes(1);
  });

  it("새벽 4시 콜백은 세션 정리를 부른다", async () => {
    const cb = registeredCallbacks().get("0 4 * * *");
    await cb!();
    expect(purgeExpired).toHaveBeenCalledTimes(1);
  });

  // 미연결 직원 재시도가 등록만 되고 아무도 안 불리면, 설치 직후 봇 키가 없어
  // 미연결로 남은 사람들이 영원히 그대로다 — 그만큼 특보가 덜 전달된다.
  it("새벽 5시 20분 콜백은 카카오워크 연결 재시도를 부른다", async () => {
    const cb = registeredCallbacks().get("20 5 * * *");
    expect(cb).toBeTypeOf("function");
    await cb!();
    expect(runKakaoLinkTick).toHaveBeenCalledTimes(1);
  });

  // guarded가 예외를 삼키므로, 콜백이 던져도 cron 밖으로 새지 않아야 한다.
  // 여기서 새면 이후 모든 주기가 조용히 사라진다.
  it("작업이 던져도 콜백 밖으로 새지 않는다", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(reportIfUnhealthy).mockRejectedValueOnce(new Error("boom"));
    const cb = registeredCallbacks().get("0 */6 * * *");
    await expect(cb!()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
