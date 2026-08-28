import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";

export const orgRouter = Router();
orgRouter.use(requireAuth);

const EMP_COLS = "id, auth_user_id, name, email, kakaowork_user_id, department_id, role, phone, created_at";

// db/migrations/0001_schema.sql의 enum 정의와 그대로 맞춘다. 잘못된 값을 검증
// 없이 그대로 바인딩하면 Postgres가 "invalid input value for enum ..."으로
// 죽고, 그 예외가 어디서도 잡히지 않아 Express 기본 핸들러가 스택트레이스와
// 내부 파일 경로가 담긴 HTML을 그대로 응답으로 내보낸다(실제로 재현해 확인함).
// DB에 닿기 전에 여기서 막아 400으로 돌려준다.
const EVENT_KINDS = ["rain", "snow", "wind", "heat"] as const;
const EMP_ROLES = ["admin", "approver", "staff"] as const;

// ---------------------------------------------------------------------------
// 부서
// ---------------------------------------------------------------------------

orgRouter.get("/departments", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select id, name from departments order by name");
    return rows;
  });
  res.json(rows);
});

orgRouter.post("/departments", requireAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "부서 이름이 필요합니다" });
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("insert into departments (name) values ($1) returning id, name", [name]);
    return rows;
  });
  res.status(201).json(rows[0]);
});

orgRouter.patch("/departments/:id", requireAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "부서 이름이 필요합니다" });
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("update departments set name = $2 where id = $1 returning id, name", [
      req.params.id,
      name,
    ]);
    return rows;
  });
  if (rows.length === 0) return res.status(404).json({ error: "부서를 찾을 수 없습니다" });
  res.json(rows[0]);
});

orgRouter.delete("/departments/:id", requireAdmin, async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("delete from departments where id = $1 returning id", [req.params.id]);
    return rows;
  });
  if (rows.length === 0) return res.status(404).json({ error: "부서를 찾을 수 없습니다" });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 직원
// ---------------------------------------------------------------------------

// role은 콤마로 여러 값을 받는다(Criteria.tsx가 admin,approver만 뽑아 쓰는 것과
// Employees.tsx가 전체를 쓰는 것을 한 엔드포인트로 합친다). 비어 있으면 필터 없이
// 전체를 돌려준다 — $1::text[] is null 분기로 한 질의 안에서 처리한다.
orgRouter.get("/employees", async (req, res) => {
  const roleParam = String(req.query.role ?? "").trim();
  const roles = roleParam ? roleParam.split(",").map((r) => r.trim()).filter(Boolean) : null;
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select ${EMP_COLS} from employees
        where $1::text[] is null or role::text = any($1::text[])
        order by name`,
      [roles],
    );
    return rows;
  });
  res.json(rows);
});

// 부분 갱신이다. 화면에는 이름·역할·부서·전화를 모두 바꾸는 폼 말고도
// "부서만 바꾼다"(담당 배정) 같은 좁은 액션이 있다 — 매번 4개 필드를 전부
// 요구하면 그런 액션이 나머지 필드를 값이 없는 것으로 지워 버린다. 요청 본문에
// 실제로 있는 키만 SET한다(department_id를 명시적으로 null로 보내는 "미지정
// 처리"는 그대로 허용해야 하므로 undefined 체크가 아니라 "in" 체크를 쓴다).
orgRouter.patch("/employees/:id", requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  if ("role" in body && !EMP_ROLES.includes(body.role)) {
    return res.status(400).json({ error: `role은 ${EMP_ROLES.join(", ")} 중 하나여야 합니다` });
  }
  const sets: string[] = [];
  const vals: unknown[] = [req.params.id];
  for (const key of ["name", "role", "department_id", "phone"] as const) {
    if (key in body) {
      vals.push(body[key]);
      sets.push(`${key} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "변경할 값이 없습니다" });
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `update employees set ${sets.join(", ")} where id = $1 returning ${EMP_COLS}`,
      vals,
    );
    return rows;
  });
  if (rows.length === 0) return res.status(404).json({ error: "직원을 찾을 수 없습니다" });
  res.json(rows[0]);
});

orgRouter.delete("/employees/:id", requireAdmin, async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("delete from employees where id = $1 returning id", [req.params.id]);
    return rows;
  });
  if (rows.length === 0) return res.status(404).json({ error: "직원을 찾을 수 없습니다" });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 지침 수신자 (부서별) — Guidelines.tsx
// ---------------------------------------------------------------------------

orgRouter.get("/recipients", async (req, res) => {
  const departmentId = req.query.department_id ? String(req.query.department_id) : null;
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select r.department_id, r.employee_id, e.name, e.role, e.kakaowork_user_id
         from recipients r join employees e on e.id = r.employee_id
        where $1::uuid is null or r.department_id = $1
        order by e.name`,
      [departmentId],
    );
    return rows;
  });
  res.json(rows);
});

// 화면(Guidelines.tsx)이 특정 부서의 수신자 선택 상태 전체를 넘긴다. alert-recipients와
// 같은 이유로 부분 갱신 대신 통째로 교체하되, recipients는 부서별로 나뉜 자원이라
// 이 부서(departmentId) 몫만 지우고 다시 넣는다 — 전체를 지우면 다른 부서의
// 수신자 지정까지 함께 사라진다.
orgRouter.put("/recipients/:departmentId", requireAdmin, async (req, res) => {
  const departmentId = req.params.departmentId;
  const ids: string[] = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : [];
  await withUser(req.user!.accountId, async (q) => {
    await q.query("delete from recipients where department_id = $1", [departmentId]);
    for (const id of ids) {
      await q.query("insert into recipients (department_id, employee_id) values ($1, $2)", [departmentId, id]);
    }
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 특보 승인 수신자 (alert_recipients) — Criteria.tsx
// ---------------------------------------------------------------------------

// 수신자는 화면이 '전체 선택 상태'를 넘기므로 부분 갱신이 아니라 통째로 교체한다.
// 부분 갱신으로 만들면 화면과 서버의 상태가 어긋날 때 조용히 남는 행이 생긴다.
orgRouter.put("/alert-recipients", requireAdmin, async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : [];
  await withUser(req.user!.accountId, async (q) => {
    await q.query("delete from alert_recipients");
    for (const id of ids) {
      await q.query("insert into alert_recipients (employee_id) values ($1)", [id]);
    }
  });
  res.status(204).end();
});

orgRouter.get("/alert-recipients", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select ar.employee_id, e.name, e.role
         from alert_recipients ar join employees e on e.id = ar.employee_id
        order by e.name`,
    );
    return rows;
  });
  res.json(rows);
});

// ---------------------------------------------------------------------------
// 특보 반복 발송 설정 (alert_settings) — Settings.tsx
// ---------------------------------------------------------------------------

orgRouter.get("/alert-settings", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      "select kind, enabled, repeat_policy, repeat_accum_threshold, heat_repeat_basis, updated_at from alert_settings order by kind",
    );
    return rows;
  });
  res.json(rows);
});

// alert_settings는 db/seed.sql이 심어 둔 4행(kind별 1행)이 항상 존재하고, RLS 정책은
// admin에게 update만 허용한다 — w_admin 하나뿐이고 insert/delete 정책은 없다
// (db/test/schema.test.ts의 27개 정책 목록 참고). 표에 적힌 옛 질의는 upsert였지만
// 그대로 옮기면 insert 절이 정책에 막혀 매 호출이 42501(RLS 위반)로 죽는다.
// 실제 화면(Settings.tsx)도 이미 이 제약 때문에 kind별 update로 우회하고 있어
// 그 동작을 그대로 따른다 — 목록에 없는 kind는 조용히 무시된다(행이 없어 0건 갱신).
orgRouter.put("/alert-settings", requireAdmin, async (req, res) => {
  const inRows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  // 행 하나라도 kind가 잘못되면 그 행까지 일부만 반영되고 나머지가 400으로
  // 끊기는 상태를 피하려고, DB에 닿기 전에 전체를 먼저 검증한다.
  const badKind = inRows.find((r) => !EVENT_KINDS.includes(r?.kind));
  if (badKind) {
    return res.status(400).json({ error: `kind는 ${EVENT_KINDS.join(", ")} 중 하나여야 합니다` });
  }
  const rows = await withUser(req.user!.accountId, async (q) => {
    const out: any[] = [];
    for (const r of inRows) {
      const { rows } = await q.query(
        `update alert_settings
            set enabled = $2, repeat_policy = $3, repeat_accum_threshold = $4, heat_repeat_basis = $5,
                updated_at = now()
          where kind = $1
          returning kind, enabled, repeat_policy, repeat_accum_threshold, heat_repeat_basis, updated_at`,
        [r.kind, r.enabled, r.repeat_policy, r.repeat_accum_threshold ?? null, r.heat_repeat_basis ?? null],
      );
      out.push(...rows);
    }
    return out;
  });
  res.json(rows);
});
