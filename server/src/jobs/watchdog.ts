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
        `select missing, rain_mm_per_hr, temp_c, wind_ms, humidity_pct
           from weather_observations order by observed_at desc limit $1`,
        [MISSING_STREAK],
      );
      if (recent.length >= MISSING_STREAK && recent.every((r: { missing: boolean }) => r.missing)) {
        reasons.push(`최근 ${MISSING_STREAK}회 관측이 모두 결측입니다`);
      }

      // "정상 수집인데 값만 전부 비어 있는" 상태를 따로 본다. 이것이 이 시스템에서
      // 가장 조용한 고장이다: 공공데이터포털이 category 코드를 바꾸거나(RN1 → RN01)
      // items.item을 빈 배열로 주면 HTTP 200 + resultCode "00"이라 shared/kma.ts의
      // parseKmaResponse가 예외 없이 전부 null을 돌려주고, weatherTick은 그것을
      // missing=false로 저장한다. 관측 행은 매시간 정상으로 쌓이고, heartbeat도
      // 신선하고, 결측 연속도 아니다 — 그런데 판정 엔진은 값이 전부 null이라
      // 액션을 0건 낸다. 폭우가 와도 특보가 영원히 뜨지 않는데 모든 지표가 초록이다.
      //
      // shared/kma.ts는 원본과 바이트 단위로 같아야 해서 거기서 던지게 만들 수 없다.
      // 워치독은 정확히 이런 "조용히 멈춤"을 잡으려고 새로 만든 안전망이므로
      // 여기서 닫는다. 판정은 결측과 분리한다(결측 행은 원래 값이 비어 있어
      // 위 사유와 중복으로 울린다) — missing=false인데 값이 전부 없을 때만이다.
      const valueless = (r: Record<string, unknown>) =>
        r.rain_mm_per_hr === null && r.temp_c === null && r.wind_ms === null && r.humidity_pct === null;
      if (
        recent.length >= MISSING_STREAK &&
        recent.every((r: Record<string, unknown>) => r.missing === false && valueless(r))
      ) {
        reasons.push(
          `최근 ${MISSING_STREAK}회 관측이 수집은 됐지만 값이 전부 비어 있습니다 (기상청 응답 형식이 바뀌었을 수 있습니다)`,
        );
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
