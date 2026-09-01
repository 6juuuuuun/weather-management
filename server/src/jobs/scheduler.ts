// pg_cron이 pg_net으로 앱을 HTTP 호출해 주기를 돌리던 구조를 걷어낸다. 앱이
// 이제 상시 떠 있으므로 프로세스 안에서 직접 스케줄을 돌리면 되고, 실행 로그도
// 앱 로그에 함께 남는다.
import cron from "node-cron";
import { withService } from "../db.ts";
import { runWeatherTick } from "./weatherTick.ts";
import { runRemindTick } from "./remindTick.ts";
import { purgeExpired } from "../auth/session.ts";
import { reportIfUnhealthy } from "./watchdog.ts";
import { runKakaoLinkTick } from "./kakaoLinkTick.ts";

// 관측은 매시 1회다. 70분이 지났다면 최소 한 번은 놓친 것이다.
const STALE_MINUTES = 70;

/**
 * 컨테이너가 재시작해 수집 주기를 놓쳤는지 보고, 놓쳤으면 기동 시 한 번 따라잡는다.
 *
 * heartbeats.last_run_at은 Postgres의 now()로 기록된다. 여기서 Node의
 * Date.now()로 그 값을 꺼내 비교하면 두 시계를 섞어 쓰는 셈이 된다 — 이
 * 프로젝트는 계정 잠금 만료 판정에서 정확히 같은 실수를 했다가 고친 적이
 * 있다(2fc6b13): Docker VM 시계가 실제로 몇 초 어긋나 있던 것만으로 테스트가
 * 결정적으로 깨졌다. 그때와 같은 처방을 쓴다 — "오래됐는가"의 계산 자체를
 * Postgres 안에서 끝내고 참/거짓 결과만 받아온다. 비교하는 시계가 하나뿐이면
 * 드리프트가 끼어들 자리가 없다. heartbeats에 행이 없으면(첫 실행) coalesce가
 * true로 떨어져 수집한다.
 */
export async function catchUpIfMissed(): Promise<boolean> {
  const stale = await withService(async (q) => {
    const { rows } = await q.query(
      `select coalesce(
         (select now() - last_run_at > ($1 || ' minutes')::interval
            from heartbeats where name = 'weather-tick'),
         true
       ) as stale`,
      [String(STALE_MINUTES)],
    );
    return rows[0].stale as boolean;
  });
  if (stale) await runWeatherTick();
  return stale;
}

/** 한 주기가 던진 예외를 삼킨다. 여기서 안 삼키면 node-cron 콜백 밖으로 새고,
 * 이후 모든 주기가 조용히 사라진다 — 안전 경보 시스템에서는 특보를 통째로
 * 놓친다는 뜻이라 절대 그대로 두면 안 된다. */
export async function guarded(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[scheduler] ${name} 실패:`, e);
  }
}

// node-cron은 timezone을 안 주면 cron 식을 "프로세스 로컬 시각"으로 해석한다.
// 컨테이너 기본 시계는 UTC라, 그대로 두면 세션 정리("0 4 * * *")가 한국 시각
// 오후 1시에 돈다 — 새벽에만 돌라고 정한 작업이 근무 시간 한복판에서 도는 셈이다.
// 곤지암 리조트에서 쓰는 시스템이므로 기준 시각은 언제나 KST다.
//
// 이미지에도 TZ=Asia/Seoul을 넣지만(로그 시각·Date 출력까지 KST로 맞추려고),
// 그것만 믿지 않고 여기서도 한 번 더 못박는다: TZ는 실행 환경이 정하는 값이라
// 이 이미지를 compose 밖에서 돌리거나 누가 env를 지우면 조용히 사라진다.
// 스케줄의 의미가 배포 환경 설정에 의존하면 안 된다.
//
// 수집(매시 5분)·리마인드(10분마다)는 빈도 기준이라 타임존과 무관하게 동작이
// 같다. 그래도 같은 값을 주는 이유는, 셋 중 하나만 예외로 두면 다음 사람이
// "왜 얘만 다른가"를 다시 추적해야 하기 때문이다.
const TIMEZONE = "Asia/Seoul";

export function startScheduler(): void {
  cron.schedule("5 * * * *", () => guarded("weather-tick", runWeatherTick), { timezone: TIMEZONE });
  cron.schedule("*/10 * * * *", () => guarded("remind-tick", runRemindTick), { timezone: TIMEZONE });
  cron.schedule("0 4 * * *", () => guarded("session-purge", purgeExpired), { timezone: TIMEZONE });
  // 관리형 서비스가 해 주던 "죽었으면 알려 주기"를 앱이 스스로 한다. 6시간마다
  // 도는 이유: 수집 주기가 1시간이라 130분 기준으로 사고를 판정하는데, 점검을
  // 그보다 훨씬 자주 돌리면 같은 사고를 반복해서 알려 사람이 무시하게 된다.
  cron.schedule("0 */6 * * *", () => guarded("watchdog", reportIfUnhealthy), { timezone: TIMEZONE });
  // 카카오워크 연결이 안 된 직원을 하루 한 번 다시 조회한다. 연결 실패의 흔한 원인은
  // 나중에 고쳐지기 때문이다(설치 직후엔 봇 키가 없고, 카카오워크 계정이 늦게 만들어지고,
  // 이메일 오타를 며칠 뒤 고친다). 가입·등록 시점 한 번만 시도하면 그 사람들은 영원히
  // 미연결로 남고, 그만큼 특보가 덜 전달된다. 새벽에 도는 이유는 카카오워크 API를
  // 사람이 쓰는 시간대에 여러 번 두드리지 않기 위해서다.
  cron.schedule("20 5 * * *", () => guarded("kakao-link", runKakaoLinkTick), { timezone: TIMEZONE });
  void guarded("catch-up", catchUpIfMissed);
}
