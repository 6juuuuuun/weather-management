import { Router } from "express";
import { UUID, withUser } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";

export const contentRouter = Router();
contentRouter.use(requireAuth);

// db/migrations/0001_schema.sql의 enum 정의와 그대로 맞춘다. org.ts가 이미 같은
// 이유로 겪은 문제다 — 검증 없이 kind/grade를 그대로 바인딩하면 Postgres가
// "invalid input value for enum ..."로 죽고, 그 예외는 index.ts의 마지막 에러
// 핸들러가 잡아 500으로 뭉개 버린다(구체적인 400 안내를 잃는다). DB에 닿기 전에
// 여기서 막는다.
const EVENT_KINDS = ["rain", "snow", "wind", "heat"] as const;
const EVENT_GRADES = ["watch", "warning"] as const;

// ---------------------------------------------------------------------------
// 행동지침 (action_guidelines) — Guidelines.tsx
// ---------------------------------------------------------------------------

// r_guidelines 정책(0002_rls.sql)이 이미 행 단위로 걸러 준다: admin·approver는
// 전체, staff는 자기 부서(department_id)만. 여기서 따로 필터링하지 않는다 —
// withUser로 app_user 권한 하에 질의하기만 하면 정책이 알아서 적용된다.
contentRouter.get("/guidelines", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select id, department_id, kind, grade, staff_actions, guest_notice, updated_at, updated_by
         from action_guidelines
        order by department_id, kind, grade`,
    );
    return rows;
  });
  res.json(rows);
});

// 브리프 원문 예시는 body 컬럼을 upsert했지만 실제 스키마(0001_schema.sql)에는
// body가 없다 — 실제 컬럼은 staff_actions(text[])와 guest_notice(text)다.
// unique(department_id, kind, grade)가 충돌 대상이다.
//
// 행 하나라도 kind/grade/department_id가 잘못되면 그 행까지만 반영되고 나머지가
// 끊기는 "절반만 저장된 지침"을 피하려고, DB에 닿기 전에 배치 전체를 먼저
// 검증한다 — 하나라도 나쁘면 전체를 거부한다.
contentRouter.put("/guidelines", requireAdmin, async (req, res) => {
  const inRows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const bad = inRows.find(
    (r) =>
      !EVENT_KINDS.includes(r?.kind) ||
      !EVENT_GRADES.includes(r?.grade) ||
      !UUID.test(String(r?.department_id ?? "")),
  );
  if (bad) {
    return res.status(400).json({
      error: `kind는 ${EVENT_KINDS.join(", ")} 중, grade는 ${EVENT_GRADES.join(
        ", ",
      )} 중이어야 하고 department_id는 올바른 uuid여야 합니다`,
    });
  }
  await withUser(req.user!.accountId, async (q) => {
    for (const r of inRows) {
      // updated_by는 current_emp_id()(0002_rls.sql, security definer)로 서버가
      // 직접 채운다 — 클라이언트가 보낸 값을 신뢰하면 다른 직원 행세로 기록을
      // 남길 수 있다.
      await q.query(
        `insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice, updated_at, updated_by)
         values ($1, $2, $3, $4, $5, now(), current_emp_id())
         on conflict (department_id, kind, grade) do update
           set staff_actions = excluded.staff_actions,
               guest_notice = excluded.guest_notice,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by`,
        [r.department_id, r.kind, r.grade, Array.isArray(r.staff_actions) ? r.staff_actions : [], r.guest_notice ?? ""],
      );
    }
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 메시지 (messages) — EventReview.tsx
// ---------------------------------------------------------------------------

// messages에는 created_at이 없다(실제 컬럼: id, event_id, status, content,
// updated_at, updated_by) — 브리프 원문의 order by created_at을 그대로 옮기면
// 42703(존재하지 않는 컬럼)으로 죽는다.
contentRouter.get("/messages", async (req, res) => {
  const eventId = String(req.query.event_id ?? "");
  if (!UUID.test(eventId)) return res.status(400).json({ error: "event_id가 필요합니다" });
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select id, event_id, status, content, updated_at, updated_by
         from messages
        where event_id = $1
        order by updated_at`,
      [eventId],
    );
    return rows;
  });
  res.json(rows);
});

// ---------------------------------------------------------------------------
// 발송 이력 (dispatches) — History.tsx
// ---------------------------------------------------------------------------

// 브리프 원문의 컬럼(snapshot, fail_count, created_at)은 실제 스키마에 없다.
// 실제 컬럼(History.tsx가 실제로 select하는 목록과 동일): id, message_id,
// event_id, sent_at, channel, repeat_no, is_test, results, content.
// 정렬·since 필터 기준도 created_at이 아니라 sent_at이다.
contentRouter.get("/dispatches", async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);
  const since = req.query.since ? String(req.query.since) : null;
  if (since !== null && Number.isNaN(Date.parse(since))) {
    return res.status(400).json({ error: "since 형식이 올바르지 않습니다" });
  }
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select id, message_id, event_id, sent_at, channel, repeat_no, is_test, results, content
         from dispatches
        where ($1::timestamptz is null or sent_at >= $1::timestamptz)
        order by sent_at desc
        limit $2`,
      [since, limit],
    );
    return rows;
  });
  res.json(rows);
});
