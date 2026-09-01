// 자체 호스팅으로 옮기면서 없어진 안전망을 코드로 되살린다.
//
// Supabase에서는 수집이 멈추면 대시보드와 메일이 알려 줬다. 사내 서버에는 그런
// 장치가 없다 — 컨테이너는 "Up"인데 기상청 키가 만료됐거나 DB가 꽉 차서 수집만
// 조용히 멈춘 상태를 아무도 모른다. 이 시스템에서 그건 리조트에 특보가 아예
// 나가지 않는다는 뜻이다. 그래서 6시간마다 스스로 상태를 보고, 문제가 있으면
// 알림 수신자에게 사람이 읽는 메시지로 알린다.
import { withService, type Querier } from "../db.ts";
import { envChannel, alertRecipientKakaoIds } from "./common.ts";
import type { NotificationChannel } from "../shared/channel.ts";

/** 관측은 매시 1회다. 130분이면 최소 2회를 연속으로 놓친 상태다. */
export const COLLECT_STALE_MIN = 130;
/** 연속 3회가 모두 결측이면 일시적 실패가 아니라 고장으로 본다. */
export const MISSING_STREAK = 3;

export type Health = { ok: boolean; reasons: string[] };

/** withService와 같은 모양의 트랜잭션 실행기. 테스트에서 "DB에 못 닿는 상태"를
 * 만들어 보기 위해서만 갈아 끼운다. */
type Runner = <T>(fn: (q: Querier) => Promise<T>) => Promise<T>;

export async function checkHealth(deps: { runner?: Runner } = {}): Promise<Health> {
  const runner = deps.runner ?? withService;
  try {
    return await runner(async (q) => {
      const reasons: string[] = [];

      // "오래됐는가"의 계산을 Postgres 안에서 끝낸다. Node의 Date.now()로
      // 비교하면 컨테이너 시계와 DB 시계 두 개를 섞어 쓰는 셈이 된다 — 이
      // 프로젝트는 계정 잠금 만료에서 정확히 같은 실수를 했다가 고친 적이
      // 있다(2fc6b13). jobs/scheduler.ts의 catchUpIfMissed와 같은 처방이다.
      // 행이 아예 없으면(한 번도 안 돌았으면) coalesce가 true로 떨어진다 —
      // 설치 직후 수집이 시작되지 않은 상태도 똑같이 사고다.
      const { rows: beat } = await q.query(
        `select coalesce(
           (select now() - last_run_at > ($1 || ' minutes')::interval
              from heartbeats where name = 'weather-tick'),
           true
         ) as stale`,
        [String(COLLECT_STALE_MIN)],
      );
      if (beat[0].stale) {
        reasons.push(`관측 수집이 ${COLLECT_STALE_MIN}분 넘게 멈춰 있습니다`);
      }

      // 수집 자체는 도는데 기상청 응답이 계속 비어 오는 경우가 있다(키 만료,
      // 관측소 점검). heartbeat만 보면 정상으로 보이므로 따로 본다.
      const { rows: recent } = await q.query(
        "select missing from weather_observations order by observed_at desc limit $1",
        [MISSING_STREAK],
      );
      if (recent.length >= MISSING_STREAK && recent.every((r: { missing: boolean }) => r.missing)) {
        reasons.push(`최근 ${MISSING_STREAK}회 관측이 모두 결측입니다`);
      }

      return { ok: reasons.length === 0, reasons };
    });
  } catch (e) {
    // 앱은 살아 있는데 DB에 못 닿는 상태다. 여기서 예외를 그대로 흘리면
    // /api/health/deep이 500 "서버 오류가 발생했습니다"만 뱉고 운영자는
    // 무엇이 잘못됐는지 알 수 없다. 사유로 바꿔서 돌려준다.
    return { ok: false, reasons: [`데이터베이스에 연결할 수 없습니다 (${String(e)})`] };
  }
}

/** 문제가 있으면 알림 수신자에게 알린다. 조용히 죽는 것이 최악이다. */
export async function reportIfUnhealthy(
  deps: { channel?: NotificationChannel } = {},
): Promise<void> {
  const health = await checkHealth();
  if (health.ok) return;

  // 카카오워크 ID가 없는 직원은 애초에 제외된다(alertRecipientKakaoIds).
  const targets = await withService(alertRecipientKakaoIds);
  const channel = deps.channel ?? envChannel();
  const text = `[날씨경영 점검]\n${health.reasons.join("\n")}`;
  // 발송(네트워크)은 트랜잭션 밖에서 한다 — remindTick과 같은 순서다.
  for (const to of targets) await channel.send(to, text);
}
