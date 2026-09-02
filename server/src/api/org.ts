import { Router } from "express";
import { UUID, withUser, withService } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";
import { isAllowedEmailDomain, isValidEmailShape } from "../auth/emailDomain.ts";
import { linkKakaoworkUserId, clearKakaoworkUserId } from "../kakaoLink.ts";

export const orgRouter = Router();
orgRouter.use(requireAuth);

// 직원 행이 없는 세션은 이 라우터 전체를 쓸 수 없다(QA W-01b).
//
// 예전에는 직원을 삭제해도 로그인 계정이 남았고, 그 계정(role: null)이 여기 모든
// GET을 200으로 통과해 **전 직원의 이름·이메일·전화번호·카카오워크 ID**를 계속
// 읽었다. RLS의 r_all 정책도 auth.uid() is not null만 보므로 막지 못한다
// (db/migrations/0002_rls.sql:34).
//
// 삭제가 계정을 함께 지우게 고쳤으니(아래 DELETE) 이 상태는 원칙적으로 생기지
// 않는다. 그래도 남겨 둔다 — 이 라우터가 개인정보의 유일한 출입구이고, 반쪽 상태를
// 만드는 새 경로가 언제 생길지는 아무도 보장할 수 없다. 정상 사용자는 가입이든
// 사전 등록이든 반드시 직원 행을 갖는다.
//
// 경로를 명시해 이 라우터가 실제로 가진 자원에만 건다. app.use("/api", orgRouter)로
// 마운트돼 있어서 경로 없는 use()는 **뒤에 등록된 다른 /api 라우트까지**(예:
// POST /api/send) 이 미들웨어를 통과하게 만든다 — 실제로 그렇게 되어 send 라우트가
// 자기 문구 대신 이 문구를 돌려줬다. 새 자원을 추가하면 이 목록에도 넣을 것.
orgRouter.use(
  ["/departments", "/employees", "/recipients", "/alert-recipients", "/alert-settings"],
  (req, res, next) => {
    if (!req.user?.employeeId) {
      return res.status(403).json({ error: "직원 정보가 없는 계정입니다. 관리자에게 문의해 주세요" });
    }
    next();
  },
);

const EMP_COLS = "id, auth_user_id, name, email, kakaowork_user_id, department_id, role, phone, created_at";

// db/migrations/0001_schema.sql의 enum 정의와 그대로 맞춘다. 잘못된 값을 검증
// 없이 그대로 바인딩하면 Postgres가 "invalid input value for enum ..."으로
// 죽고, 그 예외가 어디서도 잡히지 않아 Express 기본 핸들러가 스택트레이스와
// 내부 파일 경로가 담긴 HTML을 그대로 응답으로 내보낸다(실제로 재현해 확인함).
// DB에 닿기 전에 여기서 막아 400으로 돌려준다.
const EVENT_KINDS = ["rain", "snow", "wind", "heat"] as const;
const EMP_ROLES = ["admin", "approver", "staff"] as const;
const REPEAT_POLICIES = ["once", "hourly_until_below", "until_daily_accum_below"] as const;
const HEAT_BASES = ["temp", "feels"] as const;

// 입력 길이 상한(QA W-30). 어디에도 상한이 없어서 QA가 부서 이름 500자와 직원
// 이름 5000자를 그대로 저장했다. 이 값들은 화면 표·부서 트리·**카카오워크 DM
// 본문**에 그대로 실린다 — 한 행이 표를 가로로 밀어내 다른 열을 화면 밖으로
// 내보내고, 긴 이름 하나가 특보 메시지를 통째로 못 읽게 만든다.
// 화면(apps/web)의 maxLength와 같은 값이어야 하지만, 화면 검사는 우회할 수
// 있으므로 최종 관문은 여기다.
export const MAX_DEPT_NAME = 40;
export const MAX_EMP_NAME = 40;
export const MAX_PHONE = 30;
export const MAX_KAKAOWORK_ID = 64;

// 글자 수는 코드 포인트로 센다. UTF-16 code unit(String.length)으로 세면 이모지
// 하나가 2자로 잡혀 같은 "글자 수"가 입력에 따라 다르게 걸린다.
//
// **정정(회귀 검증 §E-7):** 예전 주석은 "화면의 maxLength(코드 포인트 기준)"라고
// 적었는데 사실이 아니다. HTML의 `maxlength`는 **UTF-16 code unit**으로 센다.
// 그래서 이모지가 섞이면 화면이 서버보다 **더 엄격**해진다(이모지 1자 = 화면 2자).
// 방향이 안전한 쪽이라 그대로 둔다 — 화면이 막은 값은 서버도 받아들일 수 있는
// 값이고, 반대(화면은 통과했는데 저장만 실패)는 일어나지 않는다. 서버가 최종
// 관문이라는 성질도 그대로다.
const overLength = (v: string, max: number) => [...v].length > max;

// ---------------------------------------------------------------------------
// 부서
// ---------------------------------------------------------------------------

// parent_id/sort_order도 함께 내려준다 — 부서는 깊이 제한이 없는 계층이고 화면
// (DeptModal.tsx/Employees.tsx/Guidelines.tsx/Dashboard.tsx)이 그 계층으로 트리를
// 그린다. 화면이 2단만 그리던 동안 3단 부서는 데이터에만 있고 어디에도 보이지
// 않았다(QA W-15) — 계층 계산은 apps/web/src/lib/deptTree.ts 한 곳으로 모았다.
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
  if (overLength(name, MAX_DEPT_NAME)) {
    return res.status(400).json({ error: `부서 이름은 ${MAX_DEPT_NAME}자 이하여야 합니다` });
  }
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
    // 같은 부모 아래 같은 이름을 막는다(QA W-25e). 예전에는 몇 개든 만들 수 있었고,
    // 그러면 어느 화면에서도 구분되지 않는다: 직원 배정 드롭다운도 지침 화면도
    // 부서 수신자 목록도 이름만 그리므로, 관리자는 지침을 어느 쪽에 달았는지
    // 알 수 없다. 서로 다른 부모 아래의 같은 이름은 정상이다(시드의 '리조트 · 조리'와
    // '골프 · 조리') — 그래서 형제 범위로만 본다.
    // parent_id가 null인 최상위끼리도 형제이므로 is not distinct from으로 비교한다
    // (= 연산자는 null끼리 참이 되지 않아 최상위 중복이 그대로 통과한다).
    const { rows: dup } = await q.query(
      "select id from departments where parent_id is not distinct from $1 and name = $2",
      [parentId, name],
    );
    if (dup.length > 0) return "duplicate" as const;
    const { rows } = await q.query(
      `insert into departments (name, parent_id, sort_order)
       values ($1, $2, coalesce($3, 0))
       returning ${DEPT_COLS}`,
      [name, parentId, sortOrder ?? null],
    );
    return rows;
  });
  if (rows === null) return res.status(400).json({ error: `parent_id ${parentId}에 해당하는 부서가 없습니다` });
  if (rows === "duplicate") {
    return res.status(409).json({ error: `같은 상위 부서 아래에 '${name}' 부서가 이미 있습니다` });
  }
  res.status(201).json(rows[0]);
});

// 이름과 상위 부서를 바꾼다. 예전에는 이름만 바꿨고 parent_id는 보내도 조용히
// 무시됐다(QA W-25c) — 조직 개편 때 지우고 새로 만드는 수밖에 없었고, 그러면 그
// 부서의 지침과 수신자 지정이 cascade로 함께 사라졌다.
//
// 보낸 키만 바꾼다: name만 보내면 상위 부서는 그대로, parent_id만 보내면 이름은
// 그대로다. `parent_id: null`은 "최상위로 올린다"는 뜻이므로 "안 보냈다"와 반드시
// 구분해야 한다 — 그래서 값이 아니라 키의 존재로 가른다.
orgRouter.patch("/departments/:id", requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasParent = Object.prototype.hasOwnProperty.call(body, "parent_id");
  if (!hasName && !hasParent) return res.status(400).json({ error: "부서 이름이 필요합니다" });

  const id = String(req.params.id ?? "");
  // 형식이 틀린 id를 그대로 바인딩하면 아래 recursive CTE가 uuid 캐스팅에서 죽고,
  // 그 예외는 500이 되어 "없는 부서"와 구분되지 않는다.
  if (!UUID.test(id)) return res.status(404).json({ error: "부서를 찾을 수 없습니다" });

  let name: string | null = null;
  if (hasName) {
    name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "부서 이름이 필요합니다" });
    if (overLength(name, MAX_DEPT_NAME)) {
      return res.status(400).json({ error: `부서 이름은 ${MAX_DEPT_NAME}자 이하여야 합니다` });
    }
  }

  let parentId: string | null = null;
  if (hasParent) {
    parentId = body.parent_id === null || body.parent_id === "" ? null : String(body.parent_id);
    if (parentId !== null && !UUID.test(parentId)) {
      return res.status(400).json({ error: "parent_id 형식이 올바르지 않습니다" });
    }
    if (parentId === id) {
      return res.status(400).json({ error: "부서를 자기 자신의 하위로 옮길 수 없습니다" });
    }
  }

  const result = await withUser(req.user!.accountId, async (q) => {
    const { rows: self } = await q.query("select id, name, parent_id from departments where id = $1", [id]);
    if (self.length === 0) return { kind: "not-found" as const };

    if (hasParent && parentId !== null) {
      const { rows: parentRows } = await q.query("select id from departments where id = $1", [parentId]);
      if (parentRows.length === 0) return { kind: "no-parent" as const };

      // 자기 자손을 부모로 지정하면 트리에서 통째로 떨어져 나간 고리가 생긴다 —
      // 서버는 계속 그 행들을 내려주지만 루트에서 닿지 않아 어느 화면에도 뜨지
      // 않고, 화면의 재귀 렌더가 무한히 돈다. DB에는 이걸 막는 제약이 없으므로
      // 여기서 자손 집합을 직접 구해 막는다.
      const { rows: cycle } = await q.query(
        `with recursive subtree as (
           select id from departments where id = $1
           union all
           select d.id from departments d join subtree s on d.parent_id = s.id
         )
         select 1 from subtree where id = $2`,
        [id, parentId],
      );
      if (cycle.length > 0) return { kind: "cycle" as const };
    }

    // 이름을 바꾸든 상위를 옮기든 결과가 "같은 부모 아래 같은 이름"이면 막는다
    // (QA W-25e — POST와 같은 규칙). 옮기기가 특히 위험하다: 이름은 그대로 두고
    // 부모만 바꿔도 그쪽 형제와 이름이 겹칠 수 있는데, 그 순간 두 부서는 모든
    // 화면에서 같은 글자가 된다. 자기 자신은 비교 대상에서 뺀다.
    const nextName = hasName ? name : (self[0].name as string);
    const nextParent = hasParent ? parentId : ((self[0].parent_id ?? null) as string | null);
    const { rows: dup } = await q.query(
      "select id from departments where parent_id is not distinct from $1 and name = $2 and id <> $3",
      [nextParent, nextName, id],
    );
    if (dup.length > 0) return { kind: "duplicate" as const, name: nextName as string };

    const { rows } = await q.query(
      `update departments
          set name = coalesce($2, name),
              parent_id = case when $4 then $3::uuid else parent_id end
        where id = $1
       returning ${DEPT_COLS}`,
      [id, name, parentId, hasParent],
    );
    return { kind: "ok" as const, row: rows[0] };
  });

  if (result.kind === "not-found") return res.status(404).json({ error: "부서를 찾을 수 없습니다" });
  if (result.kind === "no-parent") {
    return res.status(400).json({ error: `parent_id ${parentId}에 해당하는 부서가 없습니다` });
  }
  if (result.kind === "cycle") {
    return res.status(400).json({ error: "부서를 자기 하위 부서 밑으로 옮길 수 없습니다" });
  }
  if (result.kind === "duplicate") {
    return res.status(409).json({ error: `같은 상위 부서 아래에 '${result.name}' 부서가 이미 있습니다` });
  }
  res.json(result.row);
});

// 하위 부서가 있는 부서는 지울 수 없다. departments.parent_id는 on delete
// restrict라 Postgres가 23503으로 막아 주는데, 그 예외를 아무도 잡지 않아
// "서버 오류가 발생했습니다"(500)로 나갔다(QA W-24·W-25b) — 관리자는 무엇이
// 잘못됐는지도, 무엇을 먼저 해야 하는지도 알 수 없었다. 이유를 말해 준다.
orgRouter.delete("/departments/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id ?? "");
  // 형식이 아닌 id를 그대로 바인딩하면 uuid 캐스팅에서 22P02로 죽고 그 예외가
  // 500이 된다. 같은 자원의 PATCH와 같은 규약(404)으로 맞춘다 — 없는 부서를
  // 지우려는 것과 결과가 같다.
  if (!UUID.test(id)) return res.status(404).json({ error: "부서를 찾을 수 없습니다" });

  const outcome = await withUser(req.user!.accountId, async (q) => {
    // 자식 수를 먼저 세어 사유에 실을 수 있게 한다. 23503을 잡아 문구만 바꾸면
    // "몇 개가 남아 있는지"를 말할 수 없고, 관리자는 트리를 눈으로 훑어야 한다.
    const { rows: kids } = await q.query(
      "select count(*)::int as n from departments where parent_id = $1",
      [id],
    );
    if (kids[0].n > 0) return { kind: "has-children" as const, n: kids[0].n as number };
    const { rows } = await q.query("delete from departments where id = $1 returning id", [id]);
    return { kind: rows.length === 0 ? ("not-found" as const) : ("ok" as const) };
  });
  if (outcome.kind === "has-children") {
    return res.status(409).json({
      error: `하위 부서 ${outcome.n}개가 남아 있어 삭제할 수 없습니다. 하위 부서를 먼저 옮기거나 삭제해 주세요`,
    });
  }
  if (outcome.kind === "not-found") return res.status(404).json({ error: "부서를 찾을 수 없습니다" });
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
//
// 잠금 상태(account_locked, account_lock_count)도 함께 붙인다(QA W-17). 잠금은
// 지금까지 어느 화면에도 나오지 않았고, 관리자 화면은 잠긴 계정을 여전히
// "사용 중"이라고 적극적으로 말했다 — 이메일만 아는 사람이 15분마다 5번씩 틀려
// 승인권자를 무기한 잠가 두어도 관리자는 알 방법이 없다. 누적 횟수까지 보여야
// "한 번 잊었다"와 "누가 겨냥하고 있다"를 구분할 수 있다.
type AccountInfo = {
  status: string;
  locked: boolean;
  lock_count: number;
};

async function withAccountStatus<T extends { auth_user_id: string | null }>(
  rows: T[],
): Promise<(T & { account_status: string | null; account_locked: boolean; account_lock_count: number })[]> {
  const empty = { account_status: null, account_locked: false, account_lock_count: 0 };
  const accountIds = [...new Set(rows.map((r) => r.auth_user_id).filter((id): id is string => id !== null))];
  if (accountIds.length === 0) {
    return rows.map((r) => ({ ...r, ...empty }));
  }
  const byId = await withService(async (q) => {
    const { rows: accRows } = await q.query(
      `select id, status, lock_count,
              (locked_until is not null and locked_until > now()) as locked
         from auth_accounts where id = any($1::uuid[])`,
      [accountIds],
    );
    return new Map<string, AccountInfo>(
      accRows.map((a: { id: string } & AccountInfo) => [a.id, { status: a.status, locked: a.locked, lock_count: a.lock_count }]),
    );
  });
  return rows.map((r) => {
    const acc = r.auth_user_id ? byId.get(r.auth_user_id) : undefined;
    if (!acc) return { ...r, ...empty };
    return {
      ...r,
      account_status: acc.status,
      account_locked: acc.locked,
      account_lock_count: acc.lock_count,
    };
  });
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
  // 경로의 id는 아래 select/update에서 uuid 컬럼과 비교된다. 형식이 아닌 값은
  // 22P02로 죽고 그 예외가 500이 되어 "없는 직원"과 구분되지 않았다(QA W-24) —
  // 같은 파일의 DELETE /employees/:id는 이미 400으로 막고 있었다.
  if (!UUID.test(String(req.params.id ?? ""))) {
    return res.status(400).json({ error: "id 형식이 올바르지 않습니다" });
  }
  // 이름은 지금까지 trim도 길이 검사도 없었다(QA W-30 — 이메일만 정규화됐다).
  // 이 값은 직원 명부·승인 화면 수신자 목록·카카오워크 DM 본문에 그대로 실린다.
  if ("name" in body) {
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "이름이 비어 있습니다" });
    if (overLength(name, MAX_EMP_NAME)) {
      return res.status(400).json({ error: `이름은 ${MAX_EMP_NAME}자 이하여야 합니다` });
    }
    body.name = name;
  }
  if ("phone" in body && body.phone !== null && overLength(String(body.phone), MAX_PHONE)) {
    return res.status(400).json({ error: `전화번호는 ${MAX_PHONE}자 이하여야 합니다` });
  }
  if ("role" in body && !EMP_ROLES.includes(body.role)) {
    return res.status(400).json({ error: `role은 ${EMP_ROLES.join(", ")} 중 하나여야 합니다` });
  }
  // department_id는 uuid 컬럼이다. 형식이 아닌 값을 그대로 바인딩하면 Postgres가
  // 22P02로 죽고 그 예외가 에러 미들웨어까지 새어 500이 된다. 같은 파일의
  // POST /employees·POST /departments는 이미 400으로 거르고 있었다 — 라우트마다
  // 규칙이 다르면 운영자가 로그에서 클라이언트 실수와 진짜 장애를 구분할 수 없다.
  // null은 "부서 미지정"이라 그대로 허용한다.
  if ("department_id" in body && body.department_id !== null && !UUID.test(String(body.department_id))) {
    return res.status(400).json({ error: "department_id 형식이 올바르지 않습니다" });
  }
  // kakaowork_user_id는 보통 서버가 이메일로 조회해 채운다(kakaoLink.ts). 그런데
  // 조회가 실패하는 경우가 실제로 있다: 카카오워크 계정 이메일이 회사 이메일과 다르거나,
  // 봇이 그 사용자를 못 찾거나, 조직 이관 중이거나. 그때 관리자가 손으로 넣을 수 있는
  // 길이 없으면 그 사람은 영원히 특보를 못 받는다 — 이 라우트는 requireAdmin이다.
  // 빈 문자열은 "지운다"는 뜻으로 받아 null로 저장한다(공백만 든 값이 들어가면
  // is not null 필터를 통과해 발송이 카카오워크 API 오류로 실패한다).
  if ("kakaowork_user_id" in body) {
    const raw = body.kakaowork_user_id;
    if (raw !== null && typeof raw !== "string") {
      return res.status(400).json({ error: "kakaowork_user_id는 문자열이거나 null이어야 합니다" });
    }
    if (raw !== null && overLength(String(raw).trim(), MAX_KAKAOWORK_ID)) {
      return res.status(400).json({ error: `카카오워크 ID는 ${MAX_KAKAOWORK_ID}자 이하여야 합니다` });
    }
    body.kakaowork_user_id = raw === null || String(raw).trim() === "" ? null : String(raw).trim();
  }
  const sets: string[] = [];
  const vals: unknown[] = [req.params.id];
  for (const key of ["name", "role", "department_id", "phone", "kakaowork_user_id"] as const) {
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
    // 형식과 도메인을 다른 문구로 가른다(QA W-20) — `a@`·`@b`·`x@x`·공백이 든 값이
    // 그대로 저장됐고, 형식이 틀렸을 때 나가는 문구는 "회사 이메일만 등록할 수
    // 있습니다"라 **도메인 제한을 켜지도 않은 배포에서 도메인 탓을 했다.**
    // 형식이 깨진 이메일은 그 주소로 아무도 가입할 수 없어 영영 계정과 못 붙는다.
    if (!isValidEmailShape(email)) {
      return res.status(400).json({ error: "이메일 형식이 올바르지 않습니다" });
    }
    // 도메인 규칙도 가입 경로와 같아야 한다. 여기가 비어 있으면 관리자가 사내 도메인이
    // 아닌 주소를 넣을 수 있고, 그 직원은 가입해도 이 행에 병합되지 않는다.
    if (!isAllowedEmailDomain(email)) {
      return res.status(400).json({ error: "회사 이메일만 등록할 수 있습니다" });
    }
    vals.push(email);
    sets.push(`email = $${vals.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "변경할 값이 없습니다" });

  // 이 라우트는 여기서부터 withUser가 아니라 withService로 간다(QA W-01f).
  //
  // 이메일을 고치면 **로그인 이메일(auth_accounts.email)도 같은 트랜잭션에서**
  // 따라가야 한다. 예전에는 employees만 바뀌어서 명부와 계정이 갈라졌다: 당사자는
  // 그날부터 로그인하지 못하는데(옛 이메일이 여전히 유일한 열쇠) 관리자 화면에는
  // 새 이메일만 보였고, 비워진 새 이메일로 제3자가 가입하면 그 직원의 부서·역할을
  // 통째로 물려받았다. auth_accounts는 RLS상 app_user 경로에서 항상 0행이라
  // (0011_auth_rls.sql) withUser로는 손댈 수 없고, 두 풀로 나눠 쓰면 한 트랜잭션이
  // 되지 않는다 — 중간 상태가 곧 지금 고치는 그 유령이다.
  // 권한 관문은 그대로 requireAdmin이다(위 미들웨어). RLS의 w_admin_upd 정책이
  // 보던 것과 같은 조건을 애플리케이션 층에서 이미 강제한다.
  let rows: any[];
  // 바꾸기 **전**의 이메일을 같은 트랜잭션에서 함께 읽는다. 아래에서 "이메일이 실제로
  // 바뀌었는가"를 판정하는 데 쓴다 — 화면의 수정 폼은 바뀌지 않은 이메일도 매번 함께
  // 보내므로, 그 구분 없이 다시 조회하면 무관한 저장 한 번마다 연결이 흔들린다.
  let prevEmail: string | null = null;
  let outcome: "ok" | "not_found" | "last_admin";
  try {
    const result = await withService(async (q) => {
      const { rows: before } = await q.query(
        "select id, email, auth_user_id, role from employees where id = $1",
        [req.params.id],
      );
      if (before.length === 0) return { kind: "not_found" as const, rows: [] as any[] };
      prevEmail = (before[0].email ?? null) as string | null;

      // 마지막 관리자가 스스로 관리자에서 내려오는 것을 막는다(QA W-19).
      // 관리자가 1명뿐인 배포가 기본값이고(ops/make-admin.sh가 1명을 지정한다),
      // 그 사람이 자기 역할을 staff로 바꾸면 관리자 0명이 되어 설정·직원 관리·지침
      // 등록이 전부 막힌다. 복구 경로가 제품 안에 없다(서버 터미널 SQL뿐).
      // 같은 파일의 계정 비활성화에는 이미 자기대상 가드가 있는데
      // (auth/routes.ts) 역할 강등에만 없었다.
      if (
        "role" in body &&
        body.role !== "admin" &&
        before[0].role === "admin" &&
        before[0].auth_user_id !== null &&
        String(before[0].auth_user_id).toLowerCase() === req.user!.accountId.toLowerCase()
      ) {
        const { rows: adminRows } = await q.query(
          "select count(*)::int as n from employees where role = 'admin'",
        );
        if (adminRows[0].n <= 1) return { kind: "last_admin" as const, rows: [] as any[] };
      }

      const { rows } = await q.query(
        `update employees set ${sets.join(", ")} where id = $1 returning ${EMP_COLS}`,
        vals,
      );
      // 로그인 이메일을 같은 트랜잭션에서 따라가게 한다. 계정이 아직 없는(사전 등록)
      // 직원은 따라갈 대상이 없다.
      if (before[0].auth_user_id && rows[0].email !== prevEmail) {
        await q.query("update auth_accounts set email = $2 where id = $1", [
          before[0].auth_user_id,
          rows[0].email,
        ]);
      }
      return { kind: "ok" as const, rows };
    });
    outcome = result.kind;
    rows = result.rows;
  } catch (e: any) {
    // unique 위반이 두 테이블에서 날 수 있다 — 어느 쪽인지 말해 주지 않으면 관리자는
    // "이미 등록된 이메일입니다"를 보고 직원 명부만 뒤진다. 원인이 로그인 계정 쪽이면
    // 명부에는 그 이메일이 없다.
    if (e?.code === "23505" && e?.constraint === "auth_accounts_email_key") {
      return res.status(409).json({
        error: "그 이메일을 쓰는 로그인 계정이 이미 있습니다. 직원 이메일을 바꾸지 않았습니다",
      });
    }
    // employees.email은 unique다. 이미 다른 직원이 쓰는 이메일로 바꾸려 한 경우로,
    // 클라이언트 잘못이므로 500이 아니라 409다(POST /employees와 같은 처리).
    if (e?.code === "23505") return res.status(409).json({ error: "이미 등록된 이메일입니다" });
    // 형식은 맞지만 존재하지 않는 부서 uuid — 외래키 위반(23503)이다. 이것도
    // 클라이언트 잘못이므로 500으로 내보내지 않는다(POST /employees와 같은 문구).
    if (e?.code === "23503") {
      return res.status(400).json({ error: `department_id ${body.department_id}에 해당하는 부서가 없습니다` });
    }
    throw e;
  }
  if (outcome === "last_admin") {
    return res.status(403).json({
      error: "마지막 관리자입니다. 다른 사람을 관리자로 지정한 뒤에 역할을 바꾸세요",
    });
  }
  if (rows.length === 0) return res.status(404).json({ error: "직원을 찾을 수 없습니다" });
  // 이메일이 바뀌면 카카오워크 연결도 다시 맞춰야 한다 — 옛 이메일로 조회한 id가
  // 그대로 남으면 그 직원의 특보가 남의 계정으로 간다. 관리자가 이 요청에서
  // kakaowork_user_id를 직접 지정했다면 그 값을 존중하고 조회하지 않는다.
  // 이메일이 실제로 달라졌을 때만 움직인다(수정 폼이 같은 값을 매번 보낸다).
  if ("email" in body && !("kakaowork_user_id" in body) && prevEmail !== rows[0].email) {
    const out = await linkKakaoworkUserId(rows[0].email);
    if (out.linked) {
      rows[0].kakaowork_user_id = out.linked;
    } else if (rows[0].kakaowork_user_id !== null) {
      // 조회가 실패했다(봇 키 없음·네트워크 오류·새 이메일의 카카오워크 계정 없음).
      // 여기서 옛 값을 그대로 두면 **바로 위 주석이 경고한 그 상태**가 된다:
      // 이 직원 앞으로 나가는 특보가 옛 이메일 주인의 계정으로 간다. 인사이동으로
      // 이메일이 넘어간 경우라면 낯선 사람이 남의 특보 DM을 받는다.
      // 지워서 "미연결"로 떨어뜨린다 — 미연결은 하루 한 번 도는 재시도와 관리자의
      // 수동 입력으로 복구되고, 그 사실이 셋업 체크리스트·/api/health/deep·워치독에
      // 드러난다. 잘못 간 DM은 복구도 발견도 안 된다.
      await clearKakaoworkUserId(rows[0].id);
      rows[0].kakaowork_user_id = null;
    }
  }
  res.json(rows[0]);
});

// 직원을 지우면 **로그인 계정도 함께 지운다**(QA W-01a·b·c, 사용자 결정 D-1).
//
// 예전에는 employees 행만 지웠다. 그러면 두 가지 중 하나가 일어났다:
//   - 그 사람이 특보를 승인한 적이 없으면 → 계정이 그대로 남아 계속 로그인했다.
//     퇴사자가 전 직원의 이름·이메일·전화번호·카카오워크 ID를 계속 읽었고,
//     그 계정을 끄는 유일한 버튼은 방금 사라진 그 행에 달려 있었다.
//   - 승인한 적이 있으면 → weather_events.approved_by가 NO ACTION 외래키라
//     삭제 자체가 실패하고 관리자 화면에는 "서버 오류가 발생했습니다"(500)만 떴다.
//
// 사용자 결정: 계정도 함께 지우되 **승인자 이름은 이력에 남긴다.** 외래키는
// 0013_actor_name_snapshot.sql이 on delete set null로 바꿔 두었고, 여기서 지우기
// 직전에 이름을 스냅샷한다. 안전 경보 시스템에서 "누가 이 특보를 승인했는가"는
// 그 사람이 퇴사했다고 사라져서는 안 된다.
//
// 반드시 한 트랜잭션이어야 한다 — 직원만 지워지고 계정이 남는 중간 상태가 곧
// 지금 고치고 있는 그 유령이다. auth_accounts는 withUser 경로에서 항상 0행이므로
// (0011_auth_rls.sql) 통로는 withService 하나뿐이고, 권한 관문은 requireAdmin이다.
orgRouter.delete("/employees/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return res.status(400).json({ error: "id 형식이 올바르지 않습니다" });

  const outcome = await withService(async (q) => {
    const { rows: found } = await q.query("select id, name, auth_user_id from employees where id = $1", [id]);
    if (found.length === 0) return "not_found" as const;
    const emp = found[0];

    // 자기 자신은 지울 수 없다(QA W-01c). 계정 비활성화·임시 비밀번호 발급에는
    // 이미 같은 가드가 있는데(auth/routes.ts) 삭제에만 없었다 — 관리자가 1명뿐인
    // 배포에서 자기 행을 지우면 그 순간 관리자 0명에 자기 계정까지 사라진다.
    if (emp.auth_user_id !== null && String(emp.auth_user_id).toLowerCase() === req.user!.accountId.toLowerCase()) {
      return "self" as const;
    }

    // 이름 스냅샷. coalesce로 이미 채워진 값은 덮지 않는다 — 승인 시점의 이름이
    // 그 뒤의 개명보다 이력으로서 정확하다.
    await q.query(
      "update weather_events set approved_by_name = coalesce(approved_by_name, $2) where approved_by = $1",
      [id, emp.name],
    );
    await q.query(
      "update messages set updated_by_name = coalesce(updated_by_name, $2) where updated_by = $1",
      [id, emp.name],
    );
    await q.query(
      "update action_guidelines set updated_by_name = coalesce(updated_by_name, $2) where updated_by = $1",
      [id, emp.name],
    );

    await q.query("delete from employees where id = $1", [id]);
    // 계정을 지우면 auth_sessions는 on delete cascade로 함께 사라진다
    // (0009_auth_local.sql) — 남은 세션이 끊기는 것이 이 삭제의 핵심이다.
    if (emp.auth_user_id) {
      await q.query("delete from auth_accounts where id = $1", [emp.auth_user_id]);
    }
    return "ok" as const;
  });

  if (outcome === "not_found") return res.status(404).json({ error: "직원을 찾을 수 없습니다" });
  if (outcome === "self") {
    return res.status(403).json({ error: "본인 계정은 스스로 삭제할 수 없습니다" });
  }
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
  if (overLength(name, MAX_EMP_NAME)) {
    return res.status(400).json({ error: `이름은 ${MAX_EMP_NAME}자 이하여야 합니다` });
  }
  // 사전 등록도 같은 형식·도메인 규칙을 받는다 — PATCH와 같은 이유다(병합 키).
  // 형식과 도메인은 다른 문구다(QA W-20).
  if (!isValidEmailShape(email)) {
    return res.status(400).json({ error: "이메일 형식이 올바르지 않습니다" });
  }
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
    // 사전 등록된 직원도 곧바로 카카오워크에 연결한다. 이 사람이 Alert 수신자로
    // 지정되는 것은 대개 등록 직후인데, 그때 연결이 없으면 승인 요청이 안 간다.
    const linked = await linkKakaoworkUserId(email);
    if (linked.linked) rows[0].kakaowork_user_id = linked.linked;
    res.status(201).json(rows[0]);
  } catch (e: any) {
    // employees.email은 unique다 — 이미 있는 이메일로 사전 등록을 시도한 경우.
    if (e?.code === "23505") return res.status(409).json({ error: "이미 등록된 이메일입니다" });
    throw e;
  }
});

// ---------------------------------------------------------------------------
// 수신자 목록 교체의 공통 본문 규칙 (QA W-07)
// ---------------------------------------------------------------------------

// 예전에는 두 교체 라우트가 똑같이 `Array.isArray(body?.employee_ids) ? ... : []`로
// 시작했다 — **필드가 없거나 배열이 아니면 "빈 목록으로 교체"로 해석**하고 바로
// 뒤의 delete가 무조건 먼저 돌았다. 그래서 본문이 빈 요청 하나(화면 오류, 오타 난
// 필드 이름, 잘려 도착한 요청)로 그 목록이 통째로 지워지고 응답은 204 "성공"이었다.
// alert_recipients는 곧 승인 권한이므로(0007_approver_from_alert_recipients.sql)
// 그 순간부터 **시스템 안의 누구도 특보를 승인할 수 없는데** 화면에도 로그에도
// 흔적이 남지 않는다.
//
// 그래서 "비우겠다는 의도"와 "본문이 잘못됐다"를 가른다: 전원 해제는 명시적인
// 빈 배열([])로만 표현되고, 나머지는 전부 400이다.
//
// 반환값이 문자열이면 그것이 거부 사유다(호출부가 그대로 400으로 내보낸다).
function parseEmployeeIds(body: unknown): string[] | string {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(raw, "employee_ids")) {
    return "employee_ids가 필요합니다 (전원 해제하려면 employee_ids: []를 명시해 주세요)";
  }
  const ids = raw.employee_ids;
  if (!Array.isArray(ids)) {
    return "employee_ids는 배열이어야 합니다 (전원 해제하려면 employee_ids: []를 명시해 주세요)";
  }
  if (ids.some((id) => !UUID.test(String(id)))) {
    return "employee_ids 형식이 올바르지 않습니다";
  }
  // 같은 직원 id가 두 번 들어오면 두 번째 insert가 기본키 중복(23505)으로 죽고,
  // 그 예외를 아무도 잡지 않아 500이 나갔다(QA W-24). 중복은 "그 사람을 넣겠다"는
  // 뜻이 명백하고 결과 상태도 하나뿐이므로 거부하지 않고 접는다 — 이 라우트가
  // 받는 것은 목록이 아니라 집합이다.
  return [...new Set(ids.map((id) => String(id)))];
}

// ---------------------------------------------------------------------------
// 지침 수신자 (부서별) — Guidelines.tsx
// ---------------------------------------------------------------------------

orgRouter.get("/recipients", async (req, res) => {
  const departmentId = req.query.department_id ? String(req.query.department_id) : null;
  // $1::uuid 캐스팅이라 형식이 아닌 값은 22P02로 죽고 500이 나갔다(QA W-24).
  // 같은 파일의 다른 uuid 입력과 같은 규칙(400)이다.
  if (departmentId !== null && !UUID.test(departmentId)) {
    return res.status(400).json({ error: "department_id 형식이 올바르지 않습니다" });
  }
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
  const departmentId = String(req.params.departmentId ?? "");
  // 경로의 부서 id와 본문의 직원 id 모두 uuid 컬럼에 그대로 들어간다. 형식이 아닌
  // 값은 Postgres가 22P02로 죽고 그 예외가 500이 되어 나갔다 — 같은 파일의
  // POST /departments·POST /employees와 같은 규칙(400)으로 맞춘다.
  if (!UUID.test(departmentId)) {
    return res.status(400).json({ error: "department_id 형식이 올바르지 않습니다" });
  }
  const ids = parseEmployeeIds(req.body);
  if (typeof ids === "string") return res.status(400).json({ error: ids });
  try {
    const ok = await withUser(req.user!.accountId, async (q) => {
      // 형식만 맞고 실존하지 않는 부서면 delete가 0행을 지우고 insert가 외래키
      // 위반으로 터진다(트랜잭션은 정상 롤백되지만 응답은 500이었다). 먼저 본다.
      const { rows } = await q.query("select id from departments where id = $1", [departmentId]);
      if (rows.length === 0) return false;
      await q.query("delete from recipients where department_id = $1", [departmentId]);
      for (const id of ids) {
        await q.query("insert into recipients (department_id, employee_id) values ($1, $2)", [departmentId, id]);
      }
      return true;
    });
    if (!ok) return res.status(400).json({ error: `department_id ${departmentId}에 해당하는 부서가 없습니다` });
  } catch (e: any) {
    // 존재하지 않는 직원 id를 넘긴 경우다(employee_id 외래키). 클라이언트 잘못이다.
    if (e?.code === "23503") return res.status(400).json({ error: "없는 직원이 employee_ids에 있습니다" });
    throw e;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 특보 승인 수신자 (alert_recipients) — Criteria.tsx
// ---------------------------------------------------------------------------

// 수신자는 화면이 '전체 선택 상태'를 넘기므로 부분 갱신이 아니라 통째로 교체한다.
// 부분 갱신으로 만들면 화면과 서버의 상태가 어긋날 때 조용히 남는 행이 생긴다.
orgRouter.put("/alert-recipients", requireAdmin, async (req, res) => {
  const ids = parseEmployeeIds(req.body);
  if (typeof ids === "string") return res.status(400).json({ error: ids });
  try {
    await withUser(req.user!.accountId, async (q) => {
      await q.query("delete from alert_recipients");
      for (const id of ids) {
        await q.query("insert into alert_recipients (employee_id) values ($1)", [id]);
      }
    });
  } catch (e: any) {
    // 없는 직원 id(외래키 위반). 트랜잭션은 롤백되므로 기존 목록은 그대로다 —
    // 그 사실이 응답에서 읽혀야 관리자가 다시 시도할 수 있다.
    if (e?.code === "23503") {
      return res.status(400).json({ error: "없는 직원이 employee_ids에 있습니다 (수신자 목록은 그대로입니다)" });
    }
    throw e;
  }
  res.status(204).end();
});

orgRouter.get("/alert-recipients", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      // kakaowork_user_id를 함께 내려준다 — 화면(대시보드 셋업 체크리스트·알림 설정)이
      // "특보를 받을 수 있는 사람이 실제로 있는가"를 이 값으로 센다. 없으면 화면은
      // 수신자가 지정돼 있다는 것만 보고 "준비 완료"라고 말한다(그게 F-0의 절반이었다).
      //
      // department_id도 함께 내려준다(QA W-31). 이 목록은 승인 권한을 지정하는
      // 화면인데 그 사람이 어느 부서인지 보이지 않아, 동명이인이 있으면 누구를
      // 지우는지 알 수 없었다.
      `select ar.employee_id, e.name, e.role, e.kakaowork_user_id, e.department_id
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
  // kind 말고는 아무것도 보지 않았다(QA W-24). enabled에 문자열을 보내면 22P02,
  // repeat_policy에 없는 값을 보내면 check 제약 위반(23514)이 그대로 새어
  // 500 "서버 오류가 발생했습니다"가 됐다 — 알림 설정은 관리자가 자주 만지는
  // 화면이고, 그 500은 "내가 잘못 눌렀다"와 "서버가 죽었다"를 구분해 주지 않는다.
  // 값 목록은 0001_schema.sql의 check 제약과 그대로 같다.
  const badValue = inRows.find(
    (r) =>
      typeof r?.enabled !== "boolean" ||
      !REPEAT_POLICIES.includes(r?.repeat_policy) ||
      (r?.repeat_accum_threshold !== null &&
        r?.repeat_accum_threshold !== undefined &&
        !Number.isFinite(Number(r.repeat_accum_threshold))) ||
      (r?.heat_repeat_basis !== null &&
        r?.heat_repeat_basis !== undefined &&
        !HEAT_BASES.includes(r?.heat_repeat_basis)),
  );
  if (badValue) {
    return res.status(400).json({
      error:
        `enabled는 true/false, repeat_policy는 ${REPEAT_POLICIES.join(", ")} 중 하나여야 하고, ` +
        `repeat_accum_threshold는 숫자, heat_repeat_basis는 ${HEAT_BASES.join(", ")} 중 하나여야 합니다`,
    });
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
