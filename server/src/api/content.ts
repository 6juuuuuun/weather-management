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
      // updated_by_name은 수정 시점에 함께 저장한 이름 스냅샷이다(0013_actor_name_snapshot.sql).
      // 화면은 지금까지 직원 목록에서 updated_by를 찾아 이름을 그렸는데, 그 사람이
      // 삭제되면 이름이 통째로 사라졌다 — 삭제가 계정까지 지우게 된 지금은 더 자주
      // 그렇게 된다. 서버가 스냅샷을 함께 주면 "홍길동(삭제된 직원)"을 그릴 수 있다.
      `select id, department_id, kind, grade, staff_actions, guest_notice, updated_at, updated_by, updated_by_name
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

  // department_id는 형식(UUID)만 위에서 확인했다 — 형식은 맞지만 실존하지 않는
  // 부서를 그대로 insert에 넘기면 외래키 위반(23503)이 나고, 그건 index.ts의
  // 공용 에러 핸들러가 잡아 일반 500으로 뭉갠다. kind/grade와 같은 이유로,
  // DB에 쓰기 전에 존재 여부까지 확인해 400으로 걸러 배치 검증을 완성한다.
  const deptIds = [...new Set(inRows.map((r) => r.department_id as string))];
  if (deptIds.length > 0) {
    const existingIds = await withUser(req.user!.accountId, async (q) => {
      const { rows } = await q.query("select id from departments where id = any($1::uuid[])", [deptIds]);
      return new Set(rows.map((r) => r.id as string));
    });
    const missingId = deptIds.find((id) => !existingIds.has(id));
    if (missingId) {
      return res.status(400).json({ error: `department_id ${missingId}에 해당하는 부서가 없습니다` });
    }
  }

  await withUser(req.user!.accountId, async (q) => {
    for (const r of inRows) {
      // updated_by는 current_emp_id()(0002_rls.sql, security definer)로 서버가
      // 직접 채운다 — 클라이언트가 보낸 값을 신뢰하면 다른 직원 행세로 기록을
      // 남길 수 있다.
      await q.query(
        `insert into action_guidelines
           (department_id, kind, grade, staff_actions, guest_notice, updated_at, updated_by, updated_by_name)
         values ($1, $2, $3, $4, $5, now(), current_emp_id(),
                 (select name from employees where id = current_emp_id()))
         on conflict (department_id, kind, grade) do update
           set staff_actions = excluded.staff_actions,
               guest_notice = excluded.guest_notice,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by,
               updated_by_name = excluded.updated_by_name`,
        [r.department_id, r.kind, r.grade, Array.isArray(r.staff_actions) ? r.staff_actions : [], r.guest_notice ?? ""],
      );
    }
  });
  res.status(204).end();
});

// 등록한 지침을 지울 수단이 없었다(QA W-22). 부서를 재편해 더 이상 쓰지 않는
// (부서 × 종류 × 등급) 지침이 영구히 남아 초안에 계속 블록으로 끼고, 무력화하려고
// 내용을 비우면 "제목만 있는 DM"이 나갔다. 지우는 길을 연다.
//
// w_admin_all(0002_rls.sql)이 action_guidelines의 delete까지 admin에게 허용하므로
// withUser 그대로 두면 정책이 판정한다. requireAdmin은 화면 오동작을 막는 앞단이다.
contentRouter.delete("/guidelines/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(400).json({ error: "id 형식이 올바르지 않습니다" });
  const deleted = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("delete from action_guidelines where id = $1 returning id", [id]);
    return rows;
  });
  // 이미 없는 지침을 204로 돌려주면 화면은 지운 줄 알고 목록만 다시 그린다 —
  // "왜 그대로지?"의 원인을 알 수 없다. 다른 삭제 경로(org.ts)와 규약을 맞춘다.
  if (deleted.length === 0) return res.status(404).json({ error: "지침을 찾을 수 없습니다" });
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
      `select id, event_id, status, content, updated_at, updated_by, updated_by_name
         from messages
        where event_id = $1
        order by updated_at`,
      [eventId],
    );
    return rows;
  });
  res.json(rows);
});

// EventReview.tsx의 "임시 저장" — 승인 전 초안의 content(부서 블록 배열)를 고친다.
// w_approver 정책은 0007_approver_from_alert_recipients.sql이 current_emp_is_approver()
// (= alert_recipients 등록 여부)로 재정의해 둔 상태다 — role='approver'가 아니라 실제
// Alert 수신자만 통과한다(role만 approver고 미등록이면 막힌다, admin도 미등록이면
// 막힌다). 화면의 "승인 권한 = Alert 수신자 등록"이라는 안내와 실제 게이트를 맞추기
// 위한 의도적 설계다(2026-08-13 스펙). requireAdmin을 쓰지 않고 withUser로만 접근해
// 이 정책이 그대로 판정하게 둔다.
//
// update가 0건일 때 "없어서"인지 "권한이 없어서"인지를 구분해야 한다 — 둘 다 그냥
// 0건으로는 구분이 안 된다. r_messages(전 로그인 사용자에게 select 허용)로 먼저
// 존재를 확인한 뒤, 그래도 update가 0건이면 그건 정책이 막은 것(403)이다.
contentRouter.patch("/messages/:id", async (req, res) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(400).json({ error: "id 형식이 올바르지 않습니다" });
  if (!Array.isArray(req.body?.content)) {
    return res.status(400).json({ error: "content가 필요합니다" });
  }
  const outcome = await withUser(req.user!.accountId, async (q) => {
    const { rows: existing } = await q.query("select id, status from messages where id = $1", [id]);
    if (existing.length === 0) return { kind: "not_found" as const };
    // 승인(approved)된 메시지는 이미 발송 파이프라인이 읽어 간 내용이다. 이후 수정은
    // 실제로 나간 문구와 화면에 보이는 문구를 어긋나게 만들 뿐 발송을 되돌리지 못하므로
    // 초안 상태에서만 허용한다.
    if (existing[0].status !== "draft") return { kind: "not_draft" as const };
    const { rows } = await q.query(
      `update messages
          set content = $2, updated_at = now(), updated_by = current_emp_id(),
              updated_by_name = (select name from employees where id = current_emp_id())
        where id = $1
        returning id, event_id, status, content, updated_at, updated_by, updated_by_name`,
      [id, JSON.stringify(req.body.content)],
    );
    if (rows.length === 0) return { kind: "forbidden" as const };
    return { kind: "ok" as const, row: rows[0] };
  });
  if (outcome.kind === "not_found") return res.status(404).json({ error: "메시지를 찾을 수 없습니다" });
  if (outcome.kind === "not_draft") {
    return res.status(409).json({ error: "이미 승인된 메시지는 수정할 수 없습니다" });
  }
  if (outcome.kind === "forbidden") return res.status(403).json({ error: "권한이 없습니다" });
  res.json(outcome.row);
});

// ---------------------------------------------------------------------------
// 발송 이력 (dispatches) — History.tsx
// ---------------------------------------------------------------------------

// 브리프 원문의 컬럼(snapshot, fail_count, created_at)은 실제 스키마에 없다.
// 실제 컬럼(History.tsx가 실제로 select하는 목록과 동일): id, message_id,
// event_id, sent_at, channel, repeat_no, is_test, results, content.
// 정렬·since 필터 기준도 created_at이 아니라 sent_at이다.
//
// History.tsx는 dispatches 자체 컬럼만으로는 화면을 못 그린다 — weather_events
// (kind, grade, detected_at: 표의 "특보"·"특보 발생" 열과 상세 모달 제목)와
// messages.content(폴백: dispatches.content는 0004 마이그레이션이 나중에 추가한
// nullable 스냅샷 컬럼이라 그 이전 발송 이력엔 값이 없다 — 그때 메시지 본문으로
// 대신한다, History.tsx의 `d.content ?? d.messages!.content ?? []`와 동일한 이유)
// 두 개를 조인해 함께 내려준다. message_content로 이름을 구분해 dispatches.content
// (스냅샷, null일 수 있음)와 섞이지 않게 한다 — 폴백 판단은 화면 쪽이 그대로 한다.
// event_id·message_id 둘 다 not null 외래키라 참조 행이 항상 존재하므로 inner join.
//
// History.tsx는 `.eq("is_test", false)`로 테스트 발송을 아예 조회하지 않는다 —
// "그때 누구에게 보냈나"를 확인하는 화면이라 테스트 발송이 실제 발송처럼 섞이면
// 안 된다. 이 엔드포인트도 기본은 제외하고, include_test=true를 명시할 때만
// 포함한다 — 기본값을 제외로 둬야 화면이 지금 동작을 그대로 유지한다.
contentRouter.get("/dispatches", async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);
  const since = req.query.since ? String(req.query.since) : null;
  if (since !== null && Number.isNaN(Date.parse(since))) {
    return res.status(400).json({ error: "since 형식이 올바르지 않습니다" });
  }
  const includeTest = String(req.query.include_test ?? "") === "true";
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      // event_status·message_status는 화면이 "이미 해제된 특보"의 재발송 버튼을 막는 데
      // 쓴다(QA W-11) — 서버도 같은 조건으로 거부하지만, 누를 수 있는 버튼을 그려 두면
      // 승인자는 지난주 관측값이 나가는 줄 모르고 누른다.
      `select d.id, d.message_id, d.event_id, d.sent_at, d.channel, d.repeat_no, d.is_test, d.results, d.content,
              we.kind, we.grade, we.detected_at, we.status as event_status,
              m.content as message_content, m.status as message_status
         from dispatches d
         join weather_events we on we.id = d.event_id
         join messages m on m.id = d.message_id
        where ($1::timestamptz is null or d.sent_at >= $1::timestamptz)
          and ($3 or d.is_test = false)
        order by d.sent_at desc
        limit $2`,
      [since, limit, includeTest],
    );
    return rows;
  });
  res.json(rows);
});
