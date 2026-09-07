// 자체 호스팅으로 옮기면서 없어진 안전망을 코드로 되살린다.
//
// Supabase에서는 수집이 멈추면 대시보드와 메일이 알려 줬다. 사내 서버에는 그런
// 장치가 없다 — 컨테이너는 "Up"인데 기상청 키가 만료됐거나 DB가 꽉 차서 수집만
// 조용히 멈춘 상태를 아무도 모른다. 이 시스템에서 그건 리조트에 특보가 아예
// 나가지 않는다는 뜻이다. 그래서 6시간마다 스스로 상태를 보고, 문제가 있으면
// 알림 수신자에게 사람이 읽는 메시지로 알린다.
import { withService, type Querier } from "../db.ts";
import {
  envChannel, alertRecipientPhones, alertRecipientReachCounts, isLogOnlyChannel,
} from "./common.ts";
import { sendablePhoneSql } from "../phone.ts";
import { LMS_CONTENT_BUDGET_BYTES, LMS_MAX_BYTES } from "../shared/sms.ts";
import { GRID_NX_MAX, GRID_NY_MAX, isValidGrid } from "../kmaGrid.ts";
import { effectiveGuidelineSql } from "../guidelineContent.ts";
import { KIND_LABEL_KO, thresholdUsable, type CriteriaKind } from "../criteriaFields.ts";
import { REMIND_LIMIT } from "./remindTick.ts";
import { FORECAST_STALE_HOURS } from "./forecastTick.ts";
import type { NotificationChannel } from "../shared/channel.ts";

/** 관측은 매시 1회다. 130분이면 최소 2회를 연속으로 놓친 상태다. */
export const COLLECT_STALE_MIN = 130;
/** 연속 3회가 모두 결측이면 일시적 실패가 아니라 고장으로 본다. */
export const MISSING_STREAK = 3;

/**
 * 발송이 로그로만 나갈 때의 사유. **사용자가 문구까지 정했다**(판정 2).
 *
 * 상수로 빼 두는 이유: 이 문장이 지금 이 시스템의 상태를 대표한다. 화면·문서·
 * 테스트가 같은 문장을 가리켜야 하고, 누가 문구를 다듬다가 뜻이 흐려지면
 * (예: "발송 준비 중") 빨간불의 이유가 무엇이었는지 아무도 모르게 된다.
 */
export const LOG_ONLY_REASON = "SMS 발송 설정이 아직 없습니다 — 인프라 연동 대기 중";

/** 사유 문구용. shared/template.ts의 GRADE_LABEL과 같은 말이다. */
const GRADE_LABEL_KO: Record<string, string> = { watch: "주의보", warning: "경보" };

/**
 * `reasons`와 `warnings`는 뜻이 다르다.
 *
 *  - `reasons`  — **특보가 사람에게 못 간다.** 하나라도 있으면 503이다.
 *  - `warnings` — 기능 하나가 죽었지만 발송은 살아 있다. **상태 코드를 바꾸지 않는다.**
 *
 * 예보 수집이 멈춘 것이 두 번째다. 사전 예고는 사라지지만 실제 특보는 그대로
 * 난다. reasons에 넣으면 진짜 사유가 묻히고, 아무 데도 안 넣으면 멈춘 것을
 * 아무도 모른다 — 이 프로젝트가 여섯 라운드 내내 고친 그 결함이다.
 */
export type Health = { ok: boolean; reasons: string[]; warnings: string[] };

/** withService와 같은 모양의 트랜잭션 실행기. 테스트에서 "DB에 못 닿는 상태"를
 * 만들어 보기 위해서만 갈아 끼운다. */
type Runner = <T>(fn: (q: Querier) => Promise<T>) => Promise<T>;

export async function checkHealth(
  deps: { runner?: Runner; channel?: NotificationChannel } = {},
): Promise<Health> {
  const runner = deps.runner ?? withService;
  // **실효 발송 채널**. 주입은 테스트가 "운영과 같은 실채널" 상태를 만들기 위한
  // 것이고, 운영에서는 언제나 envChannel()이다.
  const channel = deps.channel ?? envChannel();
  try {
    return await runner(async (q) => {
      const reasons: string[] = [];
      const warnings: string[] = [];

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
      // 상태였고, 아무 지표도 그것을 말해 주지 않았다.
      //
      // **SMS로 바뀌어도 이 사유는 그대로 남는다.** 카카오워크에서는 "연결이 안 됐다"가
      // 원인이었고 지금은 "휴대폰 번호가 없거나 형식이 틀렸다"가 원인이지만, 결과는
      // 글자 하나 다르지 않다 — 특보가 아무에게도 가지 않는다. 조회·연결이라는 기계가
      // 사라졌다고 이 안전망까지 같이 사라지면, QA가 네 번 찾아낸 결함이 그대로 돌아온다.
      const counts = await alertRecipientReachCounts(q);
      if (counts.total === 0) {
        reasons.push("특보 승인 요청을 받을 Alert 수신자가 한 명도 지정되어 있지 않습니다");
      } else if (counts.reachable === 0) {
        reasons.push(
          `Alert 수신자 ${counts.total}명 중 보낼 수 있는 휴대폰 번호를 가진 사람이 0명입니다 — 특보가 아무에게도 전달되지 않습니다`,
        );
      }

      // **메시지가 실제로 어디로 가는가**(검증 라운드 E — 표에 없던 25번째 경로).
      //
      // 위의 사유들은 전부 "그 사람에게 닿을 수 있는가"만 묻는다. 실효 채널이 로그
      // 전용이면 그 질문의 답이 전부 예스인 채로 **모든 메시지가 앱 로그로만 나간다.**
      // 승인은 `{"ok":true,"sent_count":1}`을 돌려주고 — 라운드 E가 넣은 "0명 전달"
      // 방어(send.ts)조차 우회한다. 로그 채널의 send가 `{ok:true}`를 주므로 코드
      // 입장에서 그 발송은 성공했다. 로그 파일로 성공한 것이다.
      //
      // **지금은 이 사유가 언제나 켜져 있다.** LMS 제공자 계정 자료를 아직 받지
      // 못했고, 로그 전용이 유일한 구현이기 때문이다(shared/sms.ts). 당분간 그것이
      // 정상 상태이고 `/api/health/deep`은 계속 503이지만, **그래도 초록으로 바꾸지
      // 않는다**(사용자 판정 2) — 시스템이 진짜로 아무에게도 못 알리는 것이 사실이다.
      //
      // 카카오워크 시절에는 "연결된 수신자가 한 명이라도 있을 때만" 울리도록 조건을
      // 걸었다. 빈 DB에서 설치 점검 내내 울리는 잡음을 피하려던 것이다. **그 조건은
      // 걷어낸다.** 그때는 `.env` 한 줄로 고칠 수 있는 설정 실수였지만 지금은
      // 시스템에 아예 없는 기능이고, 수신자가 0명이든 100명이든 사실은 같다.
      // 조건을 남겨 두면 갓 설치한 시스템이 "실제 발송 ✓"로 보인다.
      if (isLogOnlyChannel(channel)) {
        reasons.push(LOG_ONLY_REASON);
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

      // (1-b) **특보 기준 값이 판정에 쓸 수 없는 상태**(QA W-10의 남은 절반).
      //     저장은 이제 api/dashboard.ts가 막지만, 그 검증이 생기기 전에 저장된 값과
      //     DB를 직접 고친 경우가 남는다. 키가 오타 나 있으면 shared/engine.ts의
      //     exceeds가 undefined와 비교하므로 **그 종류의 특보가 영원히 뜨지 않는데**
      //     화면에는 빈칸으로만 보이고 어떤 지표도 말하지 않았다. 좌표(위)와 똑같은
      //     구조라 똑같이 닫는다: 저장을 막는 곳과 여기가 criteriaFields.ts 하나를 본다.
      const { rows: critRows } = await q.query("select kind, grade, threshold from weather_criteria");
      const brokenCriteria = (critRows as { kind: string; grade: string; threshold: unknown }[])
        .filter((c) => !thresholdUsable(c.kind, c.threshold))
        .map((c) => `${KIND_LABEL_KO[c.kind as CriteriaKind] ?? c.kind} ${GRADE_LABEL_KO[c.grade] ?? c.grade}`);
      if (brokenCriteria.length > 0) {
        reasons.push(
          `특보 기준 값이 잘못돼 판정할 수 없는 항목이 있습니다: ${brokenCriteria.join(", ")} ` +
            `— 그 종류는 어떤 날씨에도 특보가 뜨지 않습니다. 특보 기준 화면에서 값을 다시 저장해 주세요`,
        );
      }

      // (2)(3) 행동지침과 부서 수신자. 지침이 0건이면 초안 자체가 빈 배열이라
      //     승인해도 나갈 곳이 없고, 지침은 있는데 그 부서에 수신자가 0명이면
      //     "0명에게 발송 성공"이 된다(QA W-02). 내용이 비어 있는 지침(인력 조정
      //     지침도 고객 안내도 없는 행)은 제목만 있는 DM을 만들 뿐이므로
      //     `composeDraft` 호출부와 같은 기준으로 **없는 것으로 센다**(QA W-22).
      // **부서를 센다**(회귀 검증 §B-2). 예전에는 count(*)가 action_guidelines의 **행**을
      //     셌다 — 한 부서에 (종류×등급) 지침을 여러 개 달면 "부서가 3곳입니다"가 되고,
      //     운영자는 있지도 않은 두 부서를 찾아 헤맨다. 시드 조직에서 4종×2등급을 다
      //     채우면 "8곳"이 된다.
      // 그리고 "내용이 있는 지침"의 기준은 guidelineContent.ts 한 곳에서 온다
      //     (회귀 검증 §B-1). 예전에는 여기만 `cardinality(staff_actions) > 0`이라
      //     공백만 든 지침 행 하나가 발송에는 아무 영향이 없는데 503을 만들었고,
      //     같은 순간 대시보드는 그 부서를 "지침 없음"으로 셌다.
      const { rows: guideRows } = await q.query(
        `select count(distinct g.department_id)::int as effective,
                count(distinct g.department_id) filter (
                  where not exists (select 1 from recipients r where r.department_id = g.department_id)
                )::int as no_recipient,
                count(distinct g.department_id) filter (
                  where not exists (
                    select 1 from recipients r
                      join employees e on e.id = r.employee_id
                     where r.department_id = g.department_id and ${sendablePhoneSql("e.phone")})
                )::int as no_reachable
           from action_guidelines g
          where ${effectiveGuidelineSql("g")}`,
      );
      const effective = Number(guideRows[0]?.effective);
      const noRecipient = Number(guideRows[0]?.no_recipient);
      // 수신자가 아예 없는 부서는 위 사유가 이미 말한다 — 여기서는 "지정은 했는데
      // 그 사람들에게 닿을 수 없는" 부서만 센다. 두 사유가 같은 부서를 두 번 부르면
      // 운영자는 부서 수를 두 배로 읽는다.
      const noReachable = Number(guideRows[0]?.no_reachable) - noRecipient;
      if (effective === 0) {
        reasons.push(
          "내용이 있는 행동지침이 한 건도 없습니다 — 특보가 떠도 발송할 부서·내용이 만들어지지 않습니다",
        );
      } else if (noRecipient > 0) {
        reasons.push(
          `지침은 있는데 수신자가 한 명도 없는 부서가 ${noRecipient}곳입니다 — 그 부서 몫은 0명에게 발송됩니다`,
        );
      }
      // **특보를 실제로 받는 사람들**의 연결 상태를 여기서 처음 센다(검증 §신규-1).
      //
      // 이 시스템은 "아무에게도 알릴 수 없는데 모든 지표가 초록"을 세 번 고쳤고,
      // 검증이 네 번째를 찾았다. 원인이 구조적이었다: checkHealth도 셋업 체크리스트도
      // **Alert 수신자(승인자)만** 셌고, 정작 특보가 나갈 대상인 부서 수신자는
      // 서버 어디에서도 세지 않았다. 그래서 부서 수신자 전원이 닿을 수 없으면
      // 승인 발송과 매시간 반복 발송이 0명에게 나가는데 하트비트·워치독·health/deep·
      // 체크리스트가 전부 초록이었다. 승인자가 폭설 새벽 4시에 승인 버튼을 누른
      // **다음에야** 알게 되는 상태였고, 그때는 고칠 시간이 없다.
      if (effective > 0 && noReachable > 0) {
        reasons.push(
          `지침과 수신자는 있는데 보낼 수 있는 휴대폰 번호를 가진 수신자가 한 명도 없는 부서가 ${noReachable}곳입니다 — 그 부서 몫은 승인해도 0명에게 발송됩니다`,
        );
      }

      // **본문이 LMS 한 통에 담기는가** (SMS 전환에서 새로 생긴 경로).
      //
      // 카카오워크 DM에는 실질적인 길이 제한이 없어서 이 질문 자체가 없었다. LMS는
      // 2,000바이트다 — 한글로 약 666자. 그런데 발송 본문에는 부서별 행동지침이
      // 통째로 들어가고, 지침의 상한은 인력 조정 지침 20개 × 200자 + 고객 안내
      // 1,000자다(api/content.ts). 즉 **넘칠 수 있는 정도가 아니라 넘치도록 허용된
      // 구조**이고, 넘치면 뒤쪽 — 마지막 지침들과 고객 안내 — 이 잘려 나간다.
      //
      // 잘림 자체는 발송 시점에 표시가 붙고 로그도 남지만(jobs/common.ts의
      // renderLmsBody), **그때는 이미 폭설이 온 뒤다.** 지침을 고칠 수 있는 시간은
      // 특보가 뜨기 전뿐이므로 여기서 미리 잰다. 예비를 넉넉히 빼고(고정 부분 몫)
      // 재기 때문에 실제 잘림보다 **먼저** 울린다 — 경고가 이른 것은 안전한 방향이고,
      // 반대 방향(지표는 초록인데 잘려 나감)이 이 프로젝트가 없애 온 모양이다.
      const { rows: longRows } = await q.query(
        `select d.name as dept, g.kind, g.grade,
                octet_length(coalesce(array_to_string(g.staff_actions, chr(10)), '')
                             || coalesce(g.guest_notice, ''))::int as bytes
           from action_guidelines g
           join departments d on d.id = g.department_id
          where octet_length(coalesce(array_to_string(g.staff_actions, chr(10)), '')
                             || coalesce(g.guest_notice, '')) > $1
          order by bytes desc limit 5`,
        [LMS_CONTENT_BUDGET_BYTES],
      );
      if (longRows.length > 0) {
        const where = (longRows as { dept: string; kind: string; grade: string; bytes: number }[])
          .map((r) => `${r.dept} ${KIND_LABEL_KO[r.kind as CriteriaKind] ?? r.kind} ` +
            `${GRADE_LABEL_KO[r.grade] ?? r.grade}(${r.bytes}바이트)`)
          .join(", ");
        reasons.push(
          `행동지침이 길어 문자 한 통(LMS ${LMS_MAX_BYTES}바이트)에 담기지 않는 항목이 있습니다: ${where} ` +
            `— 발송 시 뒷부분이 잘려 나갑니다. 행동 지침 화면에서 내용을 줄여 주세요`,
        );
      }

      // (4) **승인되지 않은 채 방치된 특보**(회귀 §F-1).
      //
      // 라운드 B가 재알림에 상한(6회)을 넣었다. 상한 자체는 옳다 — 무한 반복은 그
      // 봇의 모든 메시지를 읽지 않게 만든다. 그런데 상한에 닿은 뒤가 비어 있었다:
      // 재알림이 조회에서 빠지고 두 번 다시 나가지 않는데, 10시간째 승인 대기인
      // 특보를 두고 `/api/health/deep`이 `{"ok":true}`였다. **시끄러운 문제를 조용한
      // 문제로 바꾼 것이고, 이 시스템에서는 그게 더 나쁜 방향이다** — 수정 전에는
      // 최소한 승인될 때까지 계속 두드렸다. 관리자 에스컬레이션 DM은 1회뿐이고,
      // role='admin'이면서 보낼 수 있는 번호를 가진 사람이 0명이면 서버 로그 한 줄로 끝난다.
      //
      // 두 갈래를 함께 본다:
      //  - remind_count가 상한에 닿았다 = 재알림이 이미 멈췄다.
      //  - 상한까지 걸릴 시간이 지났는데도 remind_count가 안 찼다 = 재알림 자체가
      //    돌지 않고 있다(remind-tick 고장). 이쪽은 아무 사유도 없던 상태다.
      // 6시간마다 도는 워치독이 이 사유를 Alert 수신자에게 DM으로도 보내므로,
      // "상한 도달 = 침묵"이 아니라 "상한 도달 = 더 느린 두드림"이 된다.
      const { rows: pendingRows } = await q.query(
        `select count(*)::int as n,
                coalesce(max(floor(extract(epoch from (now() - e.detected_at)) / 3600)), 0)::int as hours
           from weather_events e
          where e.status = 'PENDING_APPROVAL'
            and (e.remind_count >= $1
                 or e.detected_at <= now() - (($1 * (
                       select coalesce(remind_interval_min, 30) from site_settings limit 1
                     )) || ' minutes')::interval)`,
        [REMIND_LIMIT],
      );
      const stalePending = Number(pendingRows[0]?.n);
      if (stalePending > 0) {
        reasons.push(
          `승인 대기 중인 특보 ${stalePending}건이 최대 ${Number(pendingRows[0]?.hours)}시간째 승인되지 않았습니다 ` +
            `(재알림 ${REMIND_LIMIT}회를 다 보내고 멈춘 상태입니다) — 대시보드에서 승인하거나 무시 처리해 주세요`,
        );
      }

      // 예보 수집. reasons가 아니라 warnings다(위 타입 주석 참고).
      // 낡음 판정은 Postgres 안에서 끝낸다 — 시계를 하나만 쓴다.
      //
      // heartbeats.last_run_at이 아니라 weather_forecasts.fetched_at을 본다.
      // upsertHeartbeat는 **실패해도** last_run_at을 now()로 찍는다(ok만
      // false로 남는다) — last_run_at으로 낡음을 재면 KMA_API_KEY가 만료돼
      // 3시간마다 실패해도 last_run_at은 계속 "방금"이라 영원히 stale=false가
      // 된다. 실제로 화면에 나가는 값(fetched_at)을 재야 이 결함이 없다.
      const { rows: fcstBeat } = await q.query(
        `select coalesce(
           (select now() - max(fetched_at) > ($1 || ' hours')::interval
              from weather_forecasts),
           false
         ) as stale`,
        [String(FORECAST_STALE_HOURS)],
      );
      // 행이 아예 없으면(예보 기능을 아직 한 번도 안 돌린 배포) 경고하지 않는다.
      // 관측과 달리 예보는 없어도 특보가 정상 동작하므로, 설치 직후부터
      // 경고를 띄우면 새 배포가 항상 경고를 달고 시작한다.
      if (fcstBeat[0]?.stale === true) {
        warnings.push(
          `예보를 ${FORECAST_STALE_HOURS}시간 넘게 받지 못했습니다 — 사전 예고가 뜨지 않습니다 ` +
            `(특보 발송은 정상입니다)`,
        );
      }

      return { ok: reasons.length === 0, reasons, warnings };
    });
  } catch (e) {
    // 앱은 살아 있는데 DB에 못 닿는 상태다. 여기서 예외를 그대로 흘리면
    // /api/health/deep이 500 "서버 오류가 발생했습니다"만 뱉고 운영자는
    // 무엇이 잘못됐는지 알 수 없다. 사유로 바꿔서 돌려준다.
    return { ok: false, reasons: [`데이터베이스에 연결할 수 없습니다 (${String(e)})`], warnings: [] };
  }
}

/** 문제가 있으면 알림 수신자에게 알린다. 조용히 죽는 것이 최악이다. */
export async function reportIfUnhealthy(
  deps: { channel?: NotificationChannel } = {},
): Promise<void> {
  // 점검과 발송이 **같은 채널**을 봐야 한다. 다르면 "로그 전용 채널입니다"라는 사유를
  // 내면서 그 사유를 실채널로 보내거나, 그 반대가 된다.
  const channel = deps.channel ?? envChannel();
  const health = await checkHealth({ channel });
  if (health.ok) return;

  // 보낼 수 있는 번호가 없는 직원은 애초에 제외된다(alertRecipientPhones).
  const targets = await withService(alertRecipientPhones);
  const text = `[날씨경영 점검]\n${health.reasons.join("\n")}`;

  // 보낼 곳이 하나도 없는 경우가 이 시스템에서 가장 위험한 상태다: 문제를 감지했는데
  // 그것을 알릴 통로 자체가 없다. 특히 사유가 "연결된 사람이 0명"일 때는 그 통로가
  // 없다는 것이 곧 사유다 — 메시지로는 절대 알릴 수 없다. 조용히 지나가면
  // 아무도 모르므로 서버 로그에 확실히 남긴다. 사람 눈에 보이는 쪽(셋업 체크리스트·
  // 알림 설정 화면·/api/health/deep)이 이 상태의 주된 통보 수단이다.
  if (targets.length === 0) {
    console.error(
      `[watchdog] 점검에서 문제를 찾았지만 알릴 대상이 없습니다(보낼 수 있는 휴대폰 번호 0명). ` +
        `화면의 초기 설정 체크리스트와 GET /api/health/deep에서 확인하세요.\n${text}`,
    );
    return;
  }

  // 발송(네트워크)은 트랜잭션 밖에서 한다 — remindTick과 같은 순서다.
  //
  // **결과를 버리지 않는다.** 예전에는 send의 반환값을 무시해서, 봇 키가 틀렸거나
  // 제공자 설정이 틀려 한 통도 나가지 않아도 이 함수는 "알렸다"고 여기고 조용히
  // 끝났다 — 문제를 감지하고도 그 사실이 아무 데도 남지 않는 상태다. 이 시스템에서
  // 가장 위험한 종류의 침묵이므로 서버 로그에 확실히 남긴다.
  let delivered = 0;
  for (const to of targets) {
    const r = await channel.send(to, text);
    if (r?.ok) delivered++;
  }
  if (delivered === 0) {
    console.error(
      `[watchdog] 점검에서 문제를 찾았지만 ${targets.length}명 모두에게 전달하지 못했습니다 ` +
        `(수신자 휴대폰 번호와 SMS 제공자 설정을 확인하세요).\n${text}`,
    );
  }
}
