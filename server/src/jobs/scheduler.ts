// pg_cron이 pg_net으로 앱을 HTTP 호출해 주기를 돌리던 구조를 걷어낸다. 앱이
// 이제 상시 떠 있으므로 프로세스 안에서 직접 스케줄을 돌리면 되고, 실행 로그도
// 앱 로그에 함께 남는다.
import cron from "node-cron";
import { withService } from "../db.ts";
import { runWeatherTick } from "./weatherTick.ts";
import { runRemindTick } from "./remindTick.ts";
import { purgeExpired } from "../auth/session.ts";

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

export function startScheduler(): void {
  cron.schedule("5 * * * *", () => guarded("weather-tick", runWeatherTick));
  cron.schedule("*/10 * * * *", () => guarded("remind-tick", runRemindTick));
  cron.schedule("0 4 * * *", () => guarded("session-purge", purgeExpired));
  void guarded("catch-up", catchUpIfMissed);
}
