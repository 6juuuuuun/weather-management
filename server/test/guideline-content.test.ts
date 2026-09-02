import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { withService } from "../src/db.ts";
import { effectiveGuidelineSql, hasGuidelineContent } from "../src/guidelineContent.ts";

// "지침이 있다"를 무엇으로 셀지가 네 곳에서 갈라져 있었다(회귀 검증 §B-1).
// 세 곳(발송 초안·대시보드 체크리스트·지침 화면)은 `trim()` 기준이었고 checkHealth만
// `cardinality(staff_actions) > 0 or guest_notice <> ''`였다. 그래서 공백만 든 지침 한
// 줄이 **발송에는 아무 영향도 없는데** `/api/health/deep`을 503으로 만들었고, 같은
// 순간 대시보드는 그 부서를 "지침 없음"으로 셌다 — 두 화면이 정반대로 말한다.
//
// 규칙을 한 파일로 모았지만 여전히 JS와 SQL 두 벌로 적힌다(질의 안에서 JS를 부를 수
// 없다). 그래서 **둘이 같은 판정을 내는지 실제 Postgres에 물어본다.** 한쪽만 고치면
// 여기서 깨진다 — 그것이 이 파일의 존재 이유다.
const DEPT = "zzguideline-content-부서";

const CASES: { label: string; staff: string[]; notice: string; expected: boolean }[] = [
  { label: "항목·안내문 모두 있음", staff: ["제설 대기"], notice: "안내문", expected: true },
  { label: "항목만 있음", staff: ["제설 대기"], notice: "", expected: true },
  { label: "안내문만 있음", staff: [], notice: "안내문", expected: true },
  { label: "빈 배열 + 빈 안내문", staff: [], notice: "", expected: false },
  // 회귀 검증 §B-1이 실제로 만든 값이다.
  { label: "공백만 든 항목", staff: ["  "], notice: "", expected: false },
  { label: "탭·개행만 든 항목", staff: ["\t\n"], notice: "", expected: false },
  { label: "공백만 든 안내문", staff: [], notice: "   ", expected: false },
  { label: "빈 항목 + 내용 있는 항목", staff: ["", "제설"], notice: "", expected: true },
  { label: "공백 항목 + 내용 있는 안내문", staff: ["  "], notice: "안내문", expected: true },
];

async function deptId(): Promise<string> {
  return withService(async (q) => {
    const { rows } = await q.query(
      `insert into departments (name) select $1
        where not exists (select 1 from departments where name = $1) returning id`,
      [DEPT],
    );
    return (
      rows[0]?.id ??
      (await q.query("select id from departments where name = $1", [DEPT])).rows[0].id
    );
  });
}

beforeEach(async () => {
  const id = await deptId();
  await withService((q) => q.query("delete from action_guidelines where department_id = $1", [id]));
});

afterAll(async () => {
  await withService(async (q) => {
    await q.query(
      "delete from action_guidelines where department_id in (select id from departments where name = $1)",
      [DEPT],
    );
    await q.query("delete from departments where name = $1", [DEPT]);
  });
});

describe("hasGuidelineContent(JS)와 effectiveGuidelineSql(SQL)이 같은 판정을 낸다", () => {
  it.each(CASES.map((c) => [c.label, c] as const))("%s", async (_label, c) => {
    const id = await deptId();
    const sqlSaysEffective = await withService(async (q) => {
      await q.query(
        `insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice)
         values ($1, 'rain', 'watch', $2, $3)`,
        [id, c.staff, c.notice],
      );
      const { rows } = await q.query(
        `select count(*)::int as n from action_guidelines g
          where g.department_id = $1 and ${effectiveGuidelineSql("g")}`,
        [id],
      );
      return Number(rows[0].n) > 0;
    });

    const jsSaysEffective = hasGuidelineContent({ staff_actions: c.staff, guest_notice: c.notice });

    // 기대값을 못박는다. 두 판정이 **함께** 틀리면 서로 같기만 해서는 잡히지 않는다.
    expect(jsSaysEffective).toBe(c.expected);
    expect(sqlSaysEffective).toBe(c.expected);
  });

  // 스키마가 staff_actions를 not null로 못박고 있다 — SQL 쪽 null 방어는 그래서
  // 실제로는 닿지 않는 길이다. 그 사실 자체를 여기서 고정한다: 컬럼이 나중에
  // nullable로 바뀌면 이 테스트가 깨지고, 그때 SQL의 unnest(null) 처리를 다시 봐야 한다.
  it("staff_actions는 not null이라 SQL이 null을 만날 일이 없다", async () => {
    const id = await deptId();
    await expect(
      withService((q) =>
        q.query(
          `insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice)
           values ($1, 'rain', 'watch', null, '')`,
          [id],
        ),
      ),
    ).rejects.toThrow(/not-null/);
    // JS 쪽은 호출부가 어떤 모양을 넘겨도 견뎌야 한다(옵셔널 필드).
    expect(hasGuidelineContent({ staff_actions: null, guest_notice: null })).toBe(false);
  });
});
