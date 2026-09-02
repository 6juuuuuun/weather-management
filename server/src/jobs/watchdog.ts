// 자체 호스팅으로 옮기면서 없어진 안전망을 코드로 되살린다.
//
// Supabase에서는 수집이 멈추면 대시보드와 메일이 알려 줬다. 사내 서버에는 그런
// 장치가 없다 — 컨테이너는 "Up"인데 기상청 키가 만료됐거나 DB가 꽉 차서 수집만
// 조용히 멈춘 상태를 아무도 모른다. 이 시스템에서 그건 리조트에 특보가 아예
// 나가지 않는다는 뜻이다. 그래서 6시간마다 스스로 상태를 보고, 문제가 있으면
// 알림 수신자에게 사람이 읽는 메시지로 알린다.
import { withService, type Querier } from "../db.ts";
import { envChannel, alertRecipientKakaoIds } from "./common.ts";
import { alertRecipientLinkCounts } from "../kakaoLink.ts";
import { GRID_NX_MAX, GRID_NY_MAX, isValidGrid } from "../kmaGrid.ts";
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
         ) as stale,
         coalesce((select not ok from heartbeats where name = 'weather-tick'), false) as failed,
         (select note from heartbeats where name = 'weather-tick') as note`,
        [String(COLLECT_STALE_MIN)],
      );
      if (beat[0].stale) {
        reasons.push(`관측 수집이 ${COLLECT_STALE_MIN}분 넘게 멈춰 있습니다`);
      }

      // 앱이 스스로 "이번 수집은 실패했다"고 적어 둔 것(heartbeats.ok = false)을
      // 여기서 읽지 않으면, 그 기록은 아무 데도 쓰이지 않는 컬럼이 된다(QA W-03).
      // weatherTick은 수집에 실패해도 last_run_at을 갱신하므로 위의 "멈춰 있습니다"
      // 판정에는 절대 걸리지 않는다 — 실패한 채로 계속 도는 상태는 오직 이 값만이
      // 말해 준다. 액션 실패(W-12)도 같은 자리에 기록되므로 함께 드러난다.
      if (beat[0].failed) {
        reasons.push(
          `마지막 수집·판정이 실패로 끝났습니다${beat[0].note ? ` (${beat[0].note})` : ""}`,
        );
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
      //
      // **항목별로 본다**(QA W-03). 예전에는 "네 값이 전부 null"일 때만 울렸는데,
      // 실제로 일어난 모양은 그게 아니다: 기상청이 `RN1` 하나만 `RN01`로 바꾸면
      // 강수량만 null이 되고 기온·풍속·습도는 멀쩡히 들어온다. 그러면 폭우와
      // 폭설 판정이 **동시에** 죽는데(둘 다 강수 항목에서 나온다) 워치독은
      // 조용하다. 항목 하나가 연속으로 비어 오는 것 자체가 그 항목으로 나가는
      // 특보 전부가 죽었다는 뜻이므로, 죽은 항목의 이름을 그대로 사유로 낸다.
      const VALUE_FIELDS: [string, string][] = [
        ["rain_mm_per_hr", "강수량"],
        ["temp_c", "기온"],
        ["wind_ms", "풍속"],
        ["humidity_pct", "습도"],
      ];
      const collected = recent.filter((r: Record<string, unknown>) => r.missing === false);
      if (collected.length >= MISSING_STREAK) {
        const dead = VALUE_FIELDS.filter(([col]) =>
          collected.every((r: Record<string, unknown>) => r[col] === null),
        );
        if (dead.length === VALUE_FIELDS.length) {
          reasons.push(
            `최근 ${MISSING_STREAK}회 관측이 수집은 됐지만 값이 전부 비어 있습니다 (기상청 응답 형식이 바뀌었을 수 있습니다)`,
          );
        } else if (dead.length > 0) {
          reasons.push(
            `최근 ${MISSING_STREAK}회 관측에서 ${dead.map(([, label]) => label).join("·")} 항목만 계속 비어 옵니다 ` +
              `(기상청 항목 이름이 바뀌었을 수 있습니다) — 그 항목으로 판정하는 특보가 뜨지 않습니다`,
          );
        }
      }

      // 관측 지점 좌표가 기상청 격자 범위 밖이면 수집 호출이 매시간 실패한다
      // (QA W-10). 저장은 이제 api/dashboard.ts가 막지만, **그 검증이 생기기 전에
      // 이미 저장된 값**과 DB를 직접 고친 경우가 남는다. 그때 지금까지 화면이
      // 말해 주는 것은 "관측 지점 ✓"뿐이었다 — 셋업 체크리스트는 행이 있는지만
      // 봤다. 위의 "멈춰 있습니다"·"실패로 끝났습니다" 사유도 원인은 말하지 않는다.
      // 원인을 그대로 이름 붙여 준다.
      const { rows: siteRows } = await q.query("select nx, ny from site_settings where id = 1");
      const site = siteRows[0];
      if (site && !isValidGrid(Number(site.nx), Number(site.ny))) {
        reasons.push(
          `관측 지점 좌표(nx=${site.nx}, ny=${site.ny})가 기상청 격자 범위를 벗어났습니다 ` +
            `(nx 1~${GRID_NX_MAX}, ny 1~${GRID_NY_MAX}) — 날씨 수집이 계속 실패합니다. 알림 설정에서 좌표를 고쳐 주세요`,
        );
      }

      // "알릴 수 있는 사람이 있는가"를 본다. 수집이 아무리 정상이어도 이 값이 0이면
      // 특보 승인 요청·재알림·워치독 경보가 전부 0명에게 간다 — 시스템은 아무것도
      // 알리지 못하는데 다른 모든 지표는 초록이다. 이관 직후 이 시스템이 실제로 그
      // 상태였고(kakaowork_user_id를 채우는 경로 자체가 없었다), 아무 지표도 그것을
      // 말해 주지 않았다. 값을 채우는 경로를 만든 것(kakaoLink.ts)만으로는 같은 사고가
      // 다른 이유(봇 키 오타, 카카오워크 계정 삭제, 이메일 불일치)로 되풀이된다.
      const counts = await alertRecipientLinkCounts(q);
      if (counts.total === 0) {
        reasons.push("특보 승인 요청을 받을 Alert 수신자가 한 명도 지정되어 있지 않습니다");
      } else if (counts.linked === 0) {
        reasons.push(
          `Alert 수신자 ${counts.total}명 중 카카오워크에 연결된 사람이 0명입니다 — 특보가 아무에게도 전달되지 않습니다`,
        );
      }

      // 여기서부터는 "수집·전달 통로"가 아니라 **판정과 내용**이 살아 있는가를 본다.
      // 셋 다 QA가 실제로 만들어 본 상태이고, 셋 다 `{"ok":true}`였다(QA W-02·W-03).

      // (1) 알림 설정 4종이 전부 꺼져 있으면 판정 루프가 모든 종류를 건너뛴다
      //     (shared/engine.ts의 `if (!s || !s.enabled) continue`). 폭우가 와도 특보가
      //     한 건도 뜨지 않는다. 한두 종류를 계절에 따라 끄는 것은 정상 운영이므로
      //     "전부 꺼짐"만 사유로 본다.
      const { rows: settingRows } = await q.query(
        "select count(*) filter (where enabled) as enabled_count, count(*) as total_count from alert_settings",
      );
      if (Number(settingRows[0]?.total_count) > 0 && Number(settingRows[0]?.enabled_count) === 0) {
        reasons.push("알림 설정의 특보 4종이 모두 꺼져 있습니다 — 어떤 날씨에도 특보가 뜨지 않습니다");
      }

      // (2)(3) 행동지침과 부서 수신자. 지침이 0건이면 초안 자체가 빈 배열이라
      //     승인해도 나갈 곳이 없고, 지침은 있는데 그 부서에 수신자가 0명이면
      //     "0명에게 발송 성공"이 된다(QA W-02). 내용이 비어 있는 지침(인력 조정
      //     지침도 고객 안내도 없는 행)은 제목만 있는 DM을 만들 뿐이므로
      //     `composeDraft` 호출부와 같은 기준으로 **없는 것으로 센다**(QA W-22).
      const { rows: guideRows } = await q.query(
        `select count(*)::int as effective,
                count(*) filter (
                  where not exists (select 1 from recipients r where r.department_id = g.department_id)
                )::int as no_recipient
           from action_guidelines g
          where cardinality(g.staff_actions) > 0 or g.guest_notice <> ''`,
      );
      const effective = Number(guideRows[0]?.effective);
      const noRecipient = Number(guideRows[0]?.no_recipient);
      if (effective === 0) {
        reasons.push(
          "내용이 있는 행동지침이 한 건도 없습니다 — 특보가 떠도 발송할 부서·내용이 만들어지지 않습니다",
        );
      } else if (noRecipient > 0) {
        reasons.push(
          `지침은 있는데 수신자가 한 명도 없는 부서가 ${noRecipient}곳입니다 — 그 부서 몫은 0명에게 발송됩니다`,
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
  const text = `[날씨경영 점검]\n${health.reasons.join("\n")}`;

  // 보낼 곳이 하나도 없는 경우가 이 시스템에서 가장 위험한 상태다: 문제를 감지했는데
  // 그것을 알릴 통로 자체가 없다. 특히 사유가 "연결된 사람이 0명"일 때는 그 통로가
  // 없다는 것이 곧 사유다 — 카카오워크로는 절대 알릴 수 없다. 조용히 지나가면
  // 아무도 모르므로 서버 로그에 확실히 남긴다. 사람 눈에 보이는 쪽(셋업 체크리스트·
  // 알림 설정 화면·/api/health/deep)이 이 상태의 주된 통보 수단이다.
  if (targets.length === 0) {
    console.error(
      `[watchdog] 점검에서 문제를 찾았지만 알릴 대상이 없습니다(카카오워크 연결 0명). ` +
        `화면의 초기 설정 체크리스트와 GET /api/health/deep에서 확인하세요.\n${text}`,
    );
    return;
  }

  const channel = deps.channel ?? envChannel();
  // 발송(네트워크)은 트랜잭션 밖에서 한다 — remindTick과 같은 순서다.
  for (const to of targets) await channel.send(to, text);
}
