// 이관 전 원본(supabase/functions/send/index.ts, git 기록) 이식. DB 접근만 SQL로 바꾸고 Deno.serve/CORS 진입점을
// 걷어냈다. 인증(누가 부르는가)은 이제 Express의 requireAuth가 처리하므로 actorEmployeeId를
// 인자로 받는다 — 하지만 **권한 검사 두 가지는 여기 그대로 남는다**:
//   (1) 승인·재발송·무시는 alert_recipients에 등록된 사람만 (역할과 무관, 스펙 2026-08-13)
//   (2) mode === "test"는 role='admin'만
// 둘 중 하나라도 빠지면 로그인한 아무나 전 직원에게 발송할 수 있게 된다.
import { UUID, withService, type Querier } from "../db.ts";
import {
  formatObsLine, OBS_LINE_FALLBACK, KIND_LABEL, GRADE_LABEL, type DeptBlock,
} from "../shared/template.ts";
import type { NotificationChannel } from "../shared/channel.ts";
import { channelName, envChannel, renderLmsBody } from "./common.ts";
import { isSendablePhone } from "../phone.ts";
// 폭설 메시지의 "오늘 누적"은 판정 엔진이 쓰는 것과 같은 합산이어야 한다 —
// 두 벌로 적으면 화면·메시지·판정이 조용히 어긋난다.
import { todayAccums } from "./weatherTick.ts";

export type SendBody =
  | { mode: "approve"; event_id: string; content: DeptBlock[] }
  | { mode: "resend"; message_id: string; content: DeptBlock[] }
  | { mode: "dismiss"; event_id: string }
  | { mode: "test" };

export type SendResult = {
  ok: boolean;
  // 원본은 거부 사유마다 다른 상태 코드를 썼다(403 권한 / 400 잘못된 요청 / 409 상태 충돌).
  // 순수 함수로 바꾸면서 그 구분을 잃지 않도록 결과에 실어 라우트가 그대로 내보낸다.
  status?: number;
  error?: string;
  dispatch_id?: number;
  repeat_no?: number;
  obs_line?: string;
  fail_count?: number;
  // fail_count만으로는 "10명에게 성공"과 "0명에게 성공"이 구분되지 않는다 —
  // 대상이 0명이면 실패한 사람도 0명이라 fail_count도 0이다(QA W-02). 실제 대상
  // 인원과 실제로 성공한 인원을 함께 실어, 화면이 그 둘을 구분해 그릴 수 있게 한다.
  recipient_count?: number;
  sent_count?: number;
};

/** 선택된 부서 블록의 실제 수신 대상 수. 발송 가능 여부의 유일한 기준이다. */
export function countTargets(blocks: DeptBlock[]): number {
  return blocks.filter((b) => b.selected).reduce((n, b) => n + b.recipients.length, 0);
}

// 승인 권한은 역할이 아니라 alert_recipients 등록 여부가 결정한다(스펙 2026-08-13).
// send는 withService(정책 우회)로 동작하므로 current_emp_is_approver()에 기대지 않고 직접 조회한다.
async function isAlertRecipient(q: Querier, employeeId: string): Promise<boolean> {
  const { rows } = await q.query("select employee_id from alert_recipients where employee_id = $1", [employeeId]);
  return rows.length > 0;
}

// 특보를 발생시킨 관측 행을 읽어 weather-tick의 반복 발송과 동일한 포맷의 "현재 관측" 줄을 만든다
// (스펙 결정 11 — 사람이 승인한 최초 발송이 자동 반복 발송보다 빈약해서는 안 됨).
// 관측 조회에 실패한 경우에만 폴백 문구를 쓴다.
// 폭설만은 여기에 적설량을 덧붙인다(QA W-04). formatObsLine에는 적설이 없어서
// "폭설 주의보 — 시간당 0mm · 1℃ · 풍속 2m/s"처럼 눈 이야기가 한 글자도 없는 DM이 나갔다.
// shared/template.ts는 원본과 바이트 단위로 같아야 하므로 호출부에서 붙인다
// (weatherTick.ts의 lineFor와 같은 처방).
async function obsLineFor(
  q: Querier,
  ev: { kind?: string; trigger_observation_id?: number | string | null },
): Promise<string> {
  if (!ev?.trigger_observation_id) return OBS_LINE_FALLBACK;
  const { rows } = await q.query(
    "select rain_mm_per_hr, temp_c, feels_c, wind_ms, snow_new_cm from weather_observations where id = $1",
    [ev.trigger_observation_id],
  );
  const line = formatObsLine(rows[0] ?? null);
  if (ev.kind !== "snow" || !rows[0]) return line;
  const { snowToday } = await todayAccums(q, new Date());
  return `${line} · 신적설 ${rows[0].snow_new_cm ?? "-"}cm(오늘 누적 ${snowToday ?? "-"}cm)`;
}

async function dispatch(
  channel: NotificationChannel,
  msg: { id: string; event_id: string },
  blocks: DeptBlock[],
  ctx: { kind: string; grade: string; site: string; obsLine: string },
  repeatNo: number,
  isTest = false,
): Promise<SendResult> {
  const results: { ok: boolean }[] = [];
  const targetCount = countTargets(blocks);
  // 발송(네트워크)은 트랜잭션 밖에서 하고, 결과만 모아 한 번에 기록한다.
  //
  // 발송 루프와 기록을 분리해 둔다(QA W-09). 이 둘을 한 덩어리로 두면 "이미 나간
  // 발송"과 "아직 안 나간 발송"을 호출부가 구분할 수 없어, 승인 상태를 되돌려야
  // 할지 말지를 판단할 수 없다. 발송 채널은 스스로 예외를 삼키고 { ok:false }를
  // 돌려주기로 되어 있지만(shared/sms.ts의 제공자 자리 주석),
  // 주입된 채널이 던질 수 있으므로 그 경우까지 결과로 바꿔 돌려준다.
  let sendError: unknown = null;
  try {
    for (const b of blocks.filter((b) => b.selected))
      for (const r of b.recipients)
        results.push({ employee_id: r.employee_id, name: r.name,
          // **보낼 수 있는 번호인가**를 phone.ts 하나로 묻는다. "값이 있는가"만 보면
          // 형식이 깨진 옛 값이 대상에 들어가 제공자에게 거절당하는데, 화면·지표는
          // 그 사람을 "연락 가능"으로 세고 있다.
          ...(isSendablePhone(r.phone)
            ? await channel.send(r.phone as string, renderLmsBody(b, {
                kindLabel: KIND_LABEL[ctx.kind as never], gradeLabel: GRADE_LABEL[ctx.grade as never],
                siteName: ctx.site, obsLine: ctx.obsLine }))
            : { ok: false, error: "휴대폰 번호 없음" }) } as { ok: boolean });
  } catch (e) {
    sendError = e;
  }
  const sentCount = results.filter((r) => r.ok).length;
  const failCount = results.length - sentCount;

  // 기록에 실패해도 이미 나간 DM은 되돌릴 수 없다. 그 사실을 삼키지 않고 결과에 싣는다.
  //
  // 한 명도 **시도조차** 못 한 경우(첫 발송에서 예외)에는 이력을 남기지 않는다.
  // 남길 발송 결과가 없을뿐더러, dispatches는 (event_id, repeat_no)가 유니크라
  // (0005_dispatch_repeat_no.sql) 빈 행을 남기면 같은 회차의 재시도가 통째로
  // 막힌다 — 되돌려 놓고 다시 승인할 수 없게 되므로 W-09를 반쯤만 고치는 셈이다.
  let dispatchId: number | undefined;
  let recordError: unknown = null;
  if (results.length === 0 && sendError) {
    return { ok: false, status: 500, error: "발송에 실패했습니다 (0명 발송됨).",
      repeat_no: repeatNo, obs_line: ctx.obsLine, fail_count: 0,
      recipient_count: targetCount, sent_count: 0 };
  }
  try {
    const d = await withService(async (q) => {
      const { rows } = await q.query(
        // channel은 컬럼 기본값에 맡기지 않는다 — 실제로 어디로
        // 나갔는지를 기록하는 것이 이 컬럼의 존재 이유다(QA W-29).
        `insert into dispatches (message_id, event_id, repeat_no, is_test, results, content, channel)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) returning id`,
        [msg.id, msg.event_id, repeatNo, isTest, JSON.stringify(results), JSON.stringify(blocks),
         channelName(channel)],
      );
      return rows[0];
    });
    dispatchId = Number(d.id);
  } catch (e) {
    recordError = e;
    console.error("[send] 발송 이력을 기록하지 못했습니다", e);
  }

  const base = { dispatch_id: dispatchId, repeat_no: repeatNo, obs_line: ctx.obsLine,
    fail_count: failCount, recipient_count: targetCount, sent_count: sentCount };
  if (sendError) {
    return { ok: false, status: 500,
      error: `발송 도중 오류가 발생했습니다 (${sentCount}/${targetCount}명 발송됨)`, ...base };
  }
  if (recordError) {
    return { ok: false, status: 500,
      error: `${sentCount}명에게 발송은 됐지만 발송 이력을 남기지 못했습니다. 담당자에게 알려 주세요.`, ...base };
  }
  // **한 명에게도 닿지 못한 발송은 성공이 아니다**(검증 §신규-1·W-02·W-09).
  //
  // 라운드 B는 "0명 발송은 성공이 아니다"를 대상이 **없는** 경우(countTargets === 0)로만
  // 닫았다. 정작 실제 운영에서 일어나는 모양은 그게 아니다: 대상은 2명인데 둘 다
  // 휴대폰 번호가 없으면 전달은 0명인데 HTTP 200 `{"ok":true,"sent_count":0}`이 나갔고,
  // 특보는 ACTIVE로 굳었다. 제공자 장애·발신번호 미등록에서도 결과가 같다.
  //
  // 이것이 W-09가 만든 `unapprove()`가 **실제 채널에서는 절대 실행되지 않던** 이유이기도
  // 하다: 발송 채널은 네트워크 예외까지 삼키고 `{ok:false}`를 돌려주므로 sendError가
  // 나지 않는다. 여기서 ok:false를 내야 승인 되돌리기가 살아난다.
  //
  // 상태는 502다: 요청도 우리 처리도 정상이었고 **바깥(발송 제공자)으로 나가지 못했다.**
  if (targetCount > 0 && sentCount === 0) {
    return { ok: false, status: 502,
      error: `${targetCount}명 중 아무에게도 전달되지 않았습니다 (실제 발송 0명). ` +
        `수신자의 휴대폰 번호를 확인해 주세요.`, ...base };
  }
  return { ok: true, ...base };
}

// 승인 발송이 한 명에게도 닿지 못했을 때 상태를 되돌린다. 이것이 없으면 특보는
// "승인·발송됨"으로 굳고 실제 발송은 0건인데, 재승인은 PENDING_APPROVAL이 아니라
// 409로 막힌다 — 화면 안에 복구 수단이 하나도 없는 상태가 된다(QA W-09).
async function unapprove(eventId: string, messageId: string): Promise<void> {
  try {
    await withService(async (q) => {
      await q.query(
        `update weather_events
            set status = 'PENDING_APPROVAL', approved_by = null, approved_by_name = null,
                approved_at = null, repeat_count = 0
          where id = $1 and status = 'ACTIVE'`,
        [eventId],
      );
      await q.query("update messages set status = 'draft' where id = $1", [messageId]);
    });
  } catch (e) {
    // 되돌리기까지 실패하면 남길 수 있는 것은 로그뿐이다. 삼키면 아무도 모른다.
    console.error("[send] 승인 되돌리기에 실패했습니다", eventId, e);
  }
}

// 본문을 DB에 닿기 전에 검증한다(QA W-24).
//
// 예전에는 아무것도 보지 않았다. `{"mode":"approve","event_id":"garbage"}` 하나면
// weather_events 조회가 uuid 캐스팅에서 22P02로 죽고, 그 예외가 라우트를 지나
// index.ts의 마지막 에러 핸들러까지 새어 500 "서버 오류가 발생했습니다"가 됐다 —
// 운영자는 로그에서 클라이언트 실수와 진짜 장애를 구분할 수 없다.
const SEND_MODES = ["approve", "resend", "dismiss", "test"] as const;

export function validateSendBody(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const mode = b.mode;
  if (!SEND_MODES.includes(mode as never)) {
    return `mode는 ${SEND_MODES.join(", ")} 중 하나여야 합니다`;
  }
  if ((mode === "approve" || mode === "dismiss") && !UUID.test(String(b.event_id ?? ""))) {
    return "event_id 형식이 올바르지 않습니다";
  }
  if (mode === "resend" && !UUID.test(String(b.message_id ?? ""))) {
    return "message_id 형식이 올바르지 않습니다";
  }
  // content는 부서 블록 배열이다. 배열이 아니면 countTargets가 곧바로 터진다.
  if ((mode === "approve" || mode === "resend") && !Array.isArray(b.content)) {
    return "content는 부서 블록 배열이어야 합니다";
  }
  return null;
}

export async function runSend(
  body: SendBody,
  actorEmployeeId: string,
  deps: { channel?: NotificationChannel } = {},
): Promise<SendResult> {
  const invalid = validateSendBody(body);
  if (invalid) return { ok: false, status: 400, error: invalid };

  const channel = deps.channel ?? envChannel();

  const { emp, siteName } = await withService(async (q) => {
    const { rows } = await q.query(
      // name도 읽는다 — 승인·수정 시점의 이름을 이력에 함께 스냅샷한다
      // (0013_actor_name_snapshot.sql). 그 사람이 나중에 삭제되면 외래키는
      // null이 되지만 "누가 승인했는가"는 이 이름으로 남는다.
      "select id, role, name, phone from employees where id = $1", [actorEmployeeId]);
    const { rows: siteRows } = await q.query("select site_name from site_settings limit 1");
    // 단일 행 시드가 항상 존재하지만 타입상 null 가드
    return { emp: rows[0] ?? null, siteName: (siteRows[0]?.site_name as string) ?? "날씨경영" };
  });
  if (!emp) return { ok: false, status: 401, error: "직원 정보가 없습니다" };

  if (body.mode === "test") {
    // 권한 검사 (2/2): 테스트 발송은 관리자만.
    if (emp.role !== "admin") return { ok: false, status: 403, error: "권한이 없습니다" };
    if (!isSendablePhone(emp.phone)) {
      return { ok: false, status: 400,
        error: "본인 휴대폰 번호가 없거나 형식이 올바르지 않습니다 — 직원 관리에서 번호를 먼저 저장해 주세요" };
    }
    const r = await channel.send(emp.phone as string, `[날씨경영] 테스트 메시지입니다. 설정이 정상 동작합니다.`);
    // 채널 발송 실패는 "요청이 잘못됐다"가 아니라 "보냈는데 실패했다"이다. 원본도 200에
    // { ok:false, error }를 실어 돌려줬고, 화면(Settings.tsx)은 그 error 문구를 그대로
    // 띄운다 — 여기서 4xx로 바꾸면 클라이언트가 throw해 그 분기가 죽는다.
    return { ok: r.ok, status: 200, error: r.error };
  }

  // 권한 검사 (1/2): 승인은 Alert 수신자 전용.
  //
  // 거절 사유를 그대로 말한다(QA W-08e). 예전에는 "권한이 없습니다" 한 줄이었고,
  // 그 문장은 이 시스템에서 정확히 반대 방향으로 읽힌다 — 받는 사람은 "역할이
  // 모자라구나"라고 이해하고 관리자에게 역할을 올려 달라고 한다. 역할을 올려도
  // 아무 일도 일어나지 않는다. 승인 권한은 오직 Alert 수신자 등록에서 나온다
  // (스펙 2026-08-13, db/migrations/0007). 관리자가 이 규칙을 처음 만나는 자리가
  // 대개 이 403이므로, 여기서 무엇을 해야 하는지까지 말한다.
  const recipient = await withService((q) => isAlertRecipient(q, emp.id));
  if (!recipient) {
    return {
      ok: false,
      status: 403,
      error:
        "특보 Alert 수신자로 등록된 사람만 승인·발송할 수 있습니다. " +
        "역할과는 무관합니다 — 특보 기준 화면의 '특보 Alert 수신자'에 등록해야 합니다",
    };
  }

  if (body.mode === "approve") {
    // 발송 대상이 0명이면 승인이 아니다(QA W-02).
    //
    // 예전에는 이 상태에서도 상태 전이가 커밋되고 dispatch가 `results = []`,
    // `fail_count = 0`, `ok:true`를 돌려줬다 — 이력에는 초록 "성공 0"이 남고
    // 승인자는 폭설 특보가 나갔다고 믿은 채 자리를 뜬다. **실패한 사람이 없어서
    // 0인 것이 아니라 대상이 아예 없어서 0이다.** 상태를 바꾸기 전에 막는다.
    const targetCount = countTargets(body.content);
    if (targetCount === 0) {
      const selected = body.content.filter((b) => b.selected).length;
      return { ok: false, status: 400, recipient_count: 0, sent_count: 0,
        error: selected === 0
          ? "발송할 부서를 한 곳 이상 선택해 주세요."
          : "선택한 부서에 수신자가 한 명도 없습니다 — 승인해도 아무에게도 발송되지 않습니다. 조직·수신자 화면에서 부서 수신자를 먼저 지정해 주세요." };
    }

    const prepared = await withService(async (q) => {
      const { rows: evRows } = await q.query("select * from weather_events where id = $1", [body.event_id]);
      const ev = evRows[0];
      if (!ev || ev.status !== "PENDING_APPROVAL") return null;
      const { rows: msgRows } = await q.query(
        `update messages
            set content = $2::jsonb, status = 'approved', updated_by = $3, updated_by_name = $4,
                updated_at = now()
          where event_id = $1 returning id, event_id`,
        [ev.id, JSON.stringify(body.content), emp.id, emp.name],
      );
      // 회차 채번은 weather_events.repeat_count 단일 소스 — 승인 발송이 1회차.
      await q.query(
        `update weather_events
            set status = 'ACTIVE', approved_by = $2, approved_by_name = $3,
                repeat_count = 1, approved_at = now()
          where id = $1`,
        [ev.id, emp.id, emp.name],
      );
      return { ev, msg: msgRows[0], obsLine: await obsLineFor(q, ev) };
    });
    if (!prepared) return { ok: false, status: 409, error: "승인 가능한 상태가 아닙니다" };

    // 승인(상태 전이)과 발송은 한 트랜잭션에 넣을 수 없다 — 네트워크를 트랜잭션
    // 안에 두지 않는 것이 이 프로젝트의 규칙이다(weatherTick.ts 주석). 그래서
    // **어긋날 수 있는 한 가지 경우에 어느 쪽이 진실인지 정한다**(QA W-09):
    //  - 한 명에게도 못 나갔다 → 승인을 없던 일로 되돌린다. 그래야 재시도가
    //    409가 아니라 정상 승인으로 다시 돈다.
    //  - 일부라도 나갔다 → 되돌리지 않는다(나간 DM은 회수할 수 없다). 상태는
    //    ACTIVE로 두고 화면에 "몇 명에게 나갔는지"를 그대로 말한다.
    let out: SendResult;
    try {
      out = await dispatch(channel, prepared.msg, body.content,
        { kind: prepared.ev.kind, grade: prepared.ev.grade, site: siteName, obsLine: prepared.obsLine }, 1);
    } catch (e) {
      console.error("[send] 승인 발송이 예외로 끝났습니다", e);
      out = { ok: false, status: 500, sent_count: 0, recipient_count: targetCount,
        error: "발송에 실패했습니다." };
    }
    if (!out.ok && (out.sent_count ?? 0) === 0) {
      await unapprove(prepared.ev.id, prepared.msg.id);
      return { ...out, error: `${out.error ?? "발송에 실패했습니다."} 승인은 취소했습니다 — 상태를 확인한 뒤 다시 승인해 주세요.` };
    }
    return out;
  }

  if (body.mode === "resend") {
    // 재발송은 **열려 있는 특보에만** 허용한다(QA W-11).
    //
    // 예전에는 이벤트 상태도 메시지 상태도 보지 않았다. 발송 이력에서 지난주의
    // 해제된 폭우 주의보를 그대로 다시 보낼 수 있었고, obs_line은 언제나 그 특보의
    // 트리거 관측이므로 **지난주 값이 "현재 관측"으로** 직원들에게 도착했다.
    // 받는 사람에게는 지금 비가 오고 있다는 뜻으로 읽힌다.
    const found = await withService(async (q) => {
      const { rows: msgRows } = await q.query(
        "select id, event_id, status from messages where id = $1", [body.message_id]);
      const msg = msgRows[0];
      if (!msg) return null;
      const { rows: evRows } = await q.query("select * from weather_events where id = $1", [msg.event_id]);
      return { msg, ev: evRows[0] };
    });
    if (!found) return { ok: false, status: 404, error: "메시지를 찾을 수 없습니다" };
    const OPEN = ["PENDING_APPROVAL", "ACTIVE"];
    if (!OPEN.includes(found.ev?.status)) {
      return { ok: false, status: 409,
        error: "이미 종료된 특보는 재발송할 수 없습니다 — 지난 관측값이 '현재 관측'으로 나갑니다. 새 특보를 기다리거나 관리자에게 알려 주세요." };
    }
    if (found.msg.status !== "approved") {
      return { ok: false, status: 409, error: "아직 승인되지 않은 초안은 재발송할 수 없습니다" };
    }
    // 승인과 같은 이유로 0명 발송을 성공이라고 하지 않는다(QA W-02).
    const targetCount = countTargets(body.content);
    if (targetCount === 0) {
      return { ok: false, status: 400, recipient_count: 0, sent_count: 0,
        error: "선택한 부서에 수신자가 한 명도 없습니다 — 재발송해도 아무에게도 전달되지 않습니다." };
    }

    const prepared = await withService(async (q) => {
      const { rows: msgRows } = await q.query(
        `update messages set content = $2::jsonb, updated_by = $3, updated_by_name = $4, updated_at = now()
          where id = $1 returning id, event_id`,
        [body.message_id, JSON.stringify(body.content), emp.id, emp.name],
      );
      const msg = msgRows[0];
      if (!msg) return null;
      const { rows: evRows } = await q.query("select * from weather_events where id = $1", [msg.event_id]);
      const ev = evRows[0];
      // 재발송도 회차를 증가시킨다(이력상 자연스러움) — dispatches 건수가 아닌 repeat_count 기준.
      const repeatNo = (ev.repeat_count ?? 0) + 1;
      await q.query("update weather_events set repeat_count = $2 where id = $1", [ev.id, repeatNo]);
      return { ev, msg, repeatNo, obsLine: await obsLineFor(q, ev) };
    });
    if (!prepared) return { ok: false, status: 404, error: "메시지를 찾을 수 없습니다" };
    return dispatch(channel, prepared.msg, body.content,
      { kind: prepared.ev.kind, grade: prepared.ev.grade, site: siteName, obsLine: prepared.obsLine },
      prepared.repeatNo);
  }

  if (body.mode === "dismiss") {
    const updated = await withService(async (q) => {
      const { rows } = await q.query(
        "update weather_events set status = 'DISMISSED' where id = $1 and status = 'PENDING_APPROVAL' returning id",
        [body.event_id],
      );
      return rows;
    });
    if (updated.length === 0) return { ok: false, status: 409, error: "무시 가능한 상태가 아닙니다" };
    return { ok: true };
  }

  return { ok: false, status: 400, error: "잘못된 요청입니다" };
}
