// supabase/functions/send/index.ts 이식. DB 접근만 SQL로 바꾸고 Deno.serve/CORS 진입점을
// 걷어냈다. 인증(누가 부르는가)은 이제 Express의 requireAuth가 처리하므로 actorEmployeeId를
// 인자로 받는다 — 하지만 **권한 검사 두 가지는 여기 그대로 남는다**:
//   (1) 승인·재발송·무시는 alert_recipients에 등록된 사람만 (역할과 무관, 스펙 2026-08-13)
//   (2) mode === "test"는 role='admin'만
// 둘 중 하나라도 빠지면 로그인한 아무나 전 직원에게 발송할 수 있게 된다.
import { withService, type Querier } from "../db.ts";
import {
  renderMessage, formatObsLine, OBS_LINE_FALLBACK, KIND_LABEL, GRADE_LABEL, type DeptBlock,
} from "../shared/template.ts";
import type { NotificationChannel } from "../shared/channel.ts";
import { envChannel } from "./common.ts";

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
};

// 승인 권한은 역할이 아니라 alert_recipients 등록 여부가 결정한다(스펙 2026-08-13).
// send는 withService(정책 우회)로 동작하므로 current_emp_is_approver()에 기대지 않고 직접 조회한다.
async function isAlertRecipient(q: Querier, employeeId: string): Promise<boolean> {
  const { rows } = await q.query("select employee_id from alert_recipients where employee_id = $1", [employeeId]);
  return rows.length > 0;
}

// 특보를 발생시킨 관측 행을 읽어 weather-tick의 반복 발송과 동일한 포맷의 "현재 관측" 줄을 만든다
// (스펙 결정 11 — 사람이 승인한 최초 발송이 자동 반복 발송보다 빈약해서는 안 됨).
// 관측 조회에 실패한 경우에만 폴백 문구를 쓴다.
async function obsLineFor(q: Querier, ev: { trigger_observation_id?: number | string | null }): Promise<string> {
  if (!ev?.trigger_observation_id) return OBS_LINE_FALLBACK;
  const { rows } = await q.query(
    "select rain_mm_per_hr, temp_c, feels_c, wind_ms from weather_observations where id = $1",
    [ev.trigger_observation_id],
  );
  return formatObsLine(rows[0] ?? null);
}

async function dispatch(
  channel: NotificationChannel,
  msg: { id: string; event_id: string },
  blocks: DeptBlock[],
  ctx: { kind: string; grade: string; site: string; obsLine: string },
  repeatNo: number,
  isTest = false,
): Promise<SendResult> {
  const results: unknown[] = [];
  // 발송(네트워크)은 트랜잭션 밖에서 하고, 결과만 모아 한 번에 기록한다.
  for (const b of blocks.filter((b) => b.selected))
    for (const r of b.recipients)
      results.push({ employee_id: r.employee_id, name: r.name,
        ...(r.kakaowork_user_id
          ? await channel.send(r.kakaowork_user_id, renderMessage(b, {
              kindLabel: KIND_LABEL[ctx.kind as never], gradeLabel: GRADE_LABEL[ctx.grade as never],
              siteName: ctx.site, obsLine: ctx.obsLine }))
          : { ok: false, error: "카카오워크 미연결" }) });
  const d = await withService(async (q) => {
    const { rows } = await q.query(
      `insert into dispatches (message_id, event_id, repeat_no, is_test, results, content)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb) returning id`,
      [msg.id, msg.event_id, repeatNo, isTest, JSON.stringify(results), JSON.stringify(blocks)],
    );
    return rows[0];
  });
  return { ok: true, dispatch_id: Number(d.id), repeat_no: repeatNo, obs_line: ctx.obsLine,
    fail_count: (results as any[]).filter((r) => !r.ok).length };
}

export async function runSend(
  body: SendBody,
  actorEmployeeId: string,
  deps: { channel?: NotificationChannel } = {},
): Promise<SendResult> {
  const channel = deps.channel ?? envChannel();

  const { emp, siteName } = await withService(async (q) => {
    const { rows } = await q.query(
      "select id, role, kakaowork_user_id from employees where id = $1", [actorEmployeeId]);
    const { rows: siteRows } = await q.query("select site_name from site_settings limit 1");
    // 단일 행 시드가 항상 존재하지만 타입상 null 가드
    return { emp: rows[0] ?? null, siteName: (siteRows[0]?.site_name as string) ?? "날씨경영" };
  });
  if (!emp) return { ok: false, status: 401, error: "직원 정보가 없습니다" };

  if (body.mode === "test") {
    // 권한 검사 (2/2): 테스트 발송은 관리자만.
    if (emp.role !== "admin") return { ok: false, status: 403, error: "권한이 없습니다" };
    if (!emp.kakaowork_user_id) return { ok: false, status: 400, error: "카카오워크 미연결" };
    const r = await channel.send(emp.kakaowork_user_id, `[날씨경영] 테스트 메시지입니다. 설정이 정상 동작합니다.`);
    // 채널 발송 실패는 "요청이 잘못됐다"가 아니라 "보냈는데 실패했다"이다. 원본도 200에
    // { ok:false, error }를 실어 돌려줬고, 화면(Settings.tsx)은 그 error 문구를 그대로
    // 띄운다 — 여기서 4xx로 바꾸면 클라이언트가 throw해 그 분기가 죽는다.
    return { ok: r.ok, status: 200, error: r.error };
  }

  // 권한 검사 (1/2): 승인은 Alert 수신자 전용.
  const recipient = await withService((q) => isAlertRecipient(q, emp.id));
  if (!recipient) return { ok: false, status: 403, error: "권한이 없습니다" };

  if (body.mode === "approve") {
    const prepared = await withService(async (q) => {
      const { rows: evRows } = await q.query("select * from weather_events where id = $1", [body.event_id]);
      const ev = evRows[0];
      if (!ev || ev.status !== "PENDING_APPROVAL") return null;
      const { rows: msgRows } = await q.query(
        `update messages set content = $2::jsonb, status = 'approved', updated_by = $3, updated_at = now()
          where event_id = $1 returning id, event_id`,
        [ev.id, JSON.stringify(body.content), emp.id],
      );
      // 회차 채번은 weather_events.repeat_count 단일 소스 — 승인 발송이 1회차.
      await q.query(
        `update weather_events set status = 'ACTIVE', approved_by = $2, repeat_count = 1, approved_at = now()
          where id = $1`,
        [ev.id, emp.id],
      );
      return { ev, msg: msgRows[0], obsLine: await obsLineFor(q, ev) };
    });
    if (!prepared) return { ok: false, status: 409, error: "승인 가능한 상태가 아닙니다" };
    const out = await dispatch(channel, prepared.msg, body.content,
      { kind: prepared.ev.kind, grade: prepared.ev.grade, site: siteName, obsLine: prepared.obsLine }, 1);
    return out;
  }

  if (body.mode === "resend") {
    const prepared = await withService(async (q) => {
      const { rows: msgRows } = await q.query(
        `update messages set content = $2::jsonb, updated_by = $3, updated_at = now()
          where id = $1 returning id, event_id`,
        [body.message_id, JSON.stringify(body.content), emp.id],
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
