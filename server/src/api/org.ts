import { Router } from "express";
import { UUID, withUser, withService } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";
import { isAllowedEmailDomain } from "../auth/emailDomain.ts";

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

// parent_id/sort_order도 함께 내려준다 — 부서는 2단 계층(상위/하위)이고 화면
// (DeptModal.tsx/Employees.tsx/Guidelines.tsx)이 그 계층으로 트리를 그린다.
// 정렬은 그대로 이름순을 유지한다(기존 계약) — 계층 그룹핑·정렬은 화면이
// sort_order로 직접 한다.
const DEPT_COLS = "id, parent_id, name, sort_order";

orgRouter.get("/departments", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(`select ${DEPT_COLS} from departments order by name`);
    return rows;
  });
  res.json(rows);
});

// parent_id/sort_order는 선택값이다 — 최상위 부서는 그대로 parent_id 없이(= null)
// 만든다. parent_id를 보내면 형식(UUID)과 실존 여부를 DB에 닿기 전에 검증한다
// (content.ts의 guidelines가 department_id에 쓰는 것과 같은 이유 — 형식만 맞고
// 실존하지 않으면 외래키 위반이 그대로 새어 500이 된다).
orgRouter.post("/departments", requireAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "부서 이름이 필요합니다" });
  const parentId = req.body?.parent_id ?? null;
  if (parentId !== null && !UUID.test(String(parentId))) {
    return res.status(400).json({ error: "parent_id 형식이 올바르지 않습니다" });
  }
  const sortOrder = req.body?.sort_order;
  const rows = await withUser(req.user!.accountId, async (q) => {
    if (parentId !== null) {
      const { rows: parentRows } = await q.query("select id from departments where id = $1", [parentId]);
      if (parentRows.length === 0) return null;
    }
    const { rows } = await q.query(
      `insert into departments (name, parent_id, sort_order)
       values ($1, $2, coalesce($3, 0))
       returning ${DEPT_COLS}`,
      [name, parentId, sortOrder ?? null],
    );
    return rows;
  });
  if (rows === null) return res.status(400).json({ error: `parent_id ${parentId}에 해당하는 부서가 없습니다` });
  res.status(201).json(rows[0]);
});

orgRouter.patch("/departments/:id", requireAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "부서 이름이 필요합니다" });
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `update departments set name = $2 where id = $1 returning ${DEPT_COLS}`,
      [req.params.id, name],
    );
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

// employees 목록에 계정(auth_accounts) 상태를 덧붙인다(수정 라운드 1 · 리뷰 F3).
// 서버에 이 필드가 없어서 Employees.tsx가 "비활성화됨"을 서버 진실이 아니라 세션
// 로컬 상태로만 흉내 냈고, 관리자 B가 새로고침하면(또는 A가 자기 화면을 새로 고쳐도)
// 방금 비활성화한 계정이 다시 "사용 중"으로 보였다 — 정보 없음이 아니라 반대 사실을
// 적극적으로 주장하는 결함이었다.
//
// auth_accounts는 RLS가 켜져 있고 app_user 경로(withUser)에는 정책이 하나도 없어
// 항상 0행이 돈다(db/migrations/0011_auth_rls.sql) — 세션 해시·비밀번호 해시가 그
// 경로로 노출되면 안 되기 때문에 의도적으로 그렇게 막아 둔 것이다. 그래서 employees
// 조회 자체는 지금처럼 withUser로 하되, 계정 상태만 auth/routes.ts의 다른 모든
// auth_accounts 접근과 같은 통로(withService)로 따로 읽어 애플리케이션 레벨에서
// 합친다 — select 목록에 status만 두고 password_hash 등 민감한 컬럼은 건드리지 않는다.
// 계정이 아직 없는(사전 등록만 된) 직원은 auth_user_id가 null이라 조회 대상에서
// 빠지고 account_status가 null로 내려간다 — 화면이 "미가입"과 "비활성"을 구분할 수 있다.
async function withAccountStatus<T extends { auth_user_id: string | null }>(
  rows: T[],
): Promise<(T & { account_status: string | null })[]> {
  const accountIds = [...new Set(rows.map((r) => r.auth_user_id).filter((id): id is string => id !== null))];
  if (accountIds.length === 0) {
    return rows.map((r) => ({ ...r, account_status: null }));
  }
  const statusById = await withService(async (q) => {
    const { rows: accRows } = await q.query(
      "select id, status from auth_accounts where id = any($1::uuid[])",
      [accountIds],
    );
    return new Map<string, string>(accRows.map((a: { id: string; status: string }) => [a.id, a.status]));
  });
  return rows.map((r) => ({
    ...r,
    account_status: r.auth_user_id ? (statusById.get(r.auth_user_id) ?? null) : null,
  }));
}

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
  res.json(await withAccountStatus(rows));
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
  // 이메일은 가입(POST /api/auth/signup)이 이 직원 행에 계정을 이어 붙이는 병합 키다.
  // 오타가 난 채로 남으면 그 직원이 가입해도 부서·역할이 유실된 별도 계정이 되므로
  // 관리자가 고칠 수 있어야 한다. 정규화 규칙은 가입 경로와 반드시 같아야 한다
  // (auth/routes.ts: String(email).trim().toLowerCase()) — 다르면 병합이 어긋난다.
  if ("email" in body) {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "이메일이 비어 있습니다" });
    // 도메인 규칙도 가입 경로와 같아야 한다. 여기가 비어 있으면 관리자가 사내 도메인이
    // 아닌 주소를 넣을 수 있고, 그 직원은 가입해도 이 행에 병합되지 않는다.
    if (!isAllowedEmailDomain(email)) {
      return res.status(400).json({ error: "회사 이메일만 등록할 수 있습니다" });
    }
    vals.push(email);
    sets.push(`email = $${vals.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "변경할 값이 없습니다" });
  let rows: any[];
  try {
    rows = await withUser(req.user!.accountId, async (q) => {
      const { rows } = await q.query(
        `update employees set ${sets.join(", ")} where id = $1 returning ${EMP_COLS}`,
        vals,
      );
      return rows;
    });
  } catch (e: any) {
    // employees.email은 unique다. 이미 다른 직원이 쓰는 이메일로 바꾸려 한 경우로,
    // 클라이언트 잘못이므로 500이 아니라 409다(POST /employees와 같은 처리).
    if (e?.code === "23505") return res.status(409).json({ error: "이미 등록된 이메일입니다" });
    throw e;
  }
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

// 가입 없이 관리자가 미리 등록하는 직원 행이다(로그인 계정은 아직 없음, auth_user_id
// null). auth/routes.ts의 signup이 이메일 대소문자를 정규화하는 것과 같은 이유로
// 여기서도 정규화한다 — 안 하면 같은 사람이 대소문자만 다른 이메일로 가입할 때
// on conflict(email)이 걸리지 않아 행이 중복된다.
orgRouter.post("/employees", requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!name || !email) return res.status(400).json({ error: "이름과 이메일이 필요합니다" });
  // 사전 등록도 같은 도메인 규칙을 받는다 — PATCH와 같은 이유다(병합 키).
  if (!isAllowedEmailDomain(email)) {
    return res.status(400).json({ error: "회사 이메일만 등록할 수 있습니다" });
  }
  const role = body.role ?? "staff";
  if (!EMP_ROLES.includes(role)) {
    return res.status(400).json({ error: `role은 ${EMP_ROLES.join(", ")} 중 하나여야 합니다` });
  }
  const departmentId = body.department_id ?? null;
  if (departmentId !== null && !UUID.test(String(departmentId))) {
    return res.status(400).json({ error: "department_id 형식이 올바르지 않습니다" });
  }
  try {
    const rows = await withUser(req.user!.accountId, async (q) => {
      if (departmentId !== null) {
        const { rows: deptRows } = await q.query("select id from departments where id = $1", [departmentId]);
        if (deptRows.length === 0) return null;
      }
      const { rows } = await q.query(
        `insert into employees (name, email, department_id, role)
         values ($1, $2, $3, $4) returning ${EMP_COLS}`,
        [name, email, departmentId, role],
      );
      return rows;
    });
    if (rows === null) {
      return res.status(400).json({ error: `department_id ${departmentId}에 해당하는 부서가 없습니다` });
    }
    res.status(201).json(rows[0]);
  } catch (e: any) {
    // employees.email은 unique다 — 이미 있는 이메일로 사전 등록을 시도한 경우.
    if (e?.code === "23505") return res.status(409).json({ error: "이미 등록된 이메일입니다" });
    throw e;
  }
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
