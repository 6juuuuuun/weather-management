// "지침이 있다"를 무엇으로 셀지 **한 곳에서** 정한다.
//
// 라운드 B는 "내용이 비어 있는 지침은 등록으로 세지 않는다"를 네 곳이 같은 기준으로
// 쓴다고 적었는데, 실제로는 세 곳만 같았다(회귀 검증 §B-1):
//   - weatherTick의 초안 필터  : staff_actions.some(a => a.trim() !== "") || guest_notice.trim() !== ""
//   - 대시보드 셋업 체크리스트 : 같음
//   - 행동 지침 화면의 부서 점 : 같음
//   - checkHealth              : cardinality(staff_actions) > 0 or guest_notice <> ''  ← **다르다**
// 그래서 공백만 든 지침 행 하나(`staff_actions: ["  "]`)가 발송에는 아무 영향도 없는데
// `/api/health/deep`을 503으로 만들었고, 같은 순간 대시보드는 그 부서를 "지침 없음"으로
// 셌다 — 두 화면이 정반대로 말한다.
//
// 값이 두 언어(JS/SQL)로 적히는 것은 피할 수 없으므로, 대신 **한 파일 안에 나란히** 두고
// 둘이 같은 판정을 내는지 테스트가 실제 DB에 물어본다(server/test/guideline-content.test.ts).
// 화면 쪽(apps/web/src/lib/setup.ts의 hasGuidelineContent)도 같은 규칙을 따른다 — 웹과
// 서버는 별개 npm 패키지라 상수를 공유할 통로가 없고, 이 프로젝트는 그럴 때
// "값을 두 곳에 적고 어긋나면 깨지는 테스트로 묶는" 관례를 쓴다(MIN_PASSWORD와 같다).

export type GuidelineContent = {
  staff_actions?: readonly (string | null)[] | null;
  guest_notice?: string | null;
};

/** 이 지침 행이 실제로 보낼 내용을 담고 있는가. 공백만 든 항목은 내용이 아니다. */
export function hasGuidelineContent(g: GuidelineContent): boolean {
  const actions = g.staff_actions ?? [];
  return actions.some((a) => (a ?? "").trim() !== "") || (g.guest_notice ?? "").trim() !== "";
}

/**
 * 위 판정과 같은 뜻의 SQL 조건. `alias`는 action_guidelines의 별칭이다.
 *
 * `btrim(a) <> ''`가 아니라 `!~ '^[[:space:]]*$'`인 이유: **Postgres의 btrim은 기본적으로
 * 스페이스만 자른다.** 탭·개행만 든 항목("\t\n")을 btrim은 "내용 있음"으로, JS의 trim()은
 * "내용 없음"으로 판정한다 — 규칙을 한 파일에 모아 놓고도 두 언어가 갈라지는 바로 그
 * 모양이다. 실제로 이 파일과 함께 만든 대조 테스트(test/guideline-content.test.ts)가
 * 그 한 칸을 잡아냈다. POSIX의 `[[:space:]]`는 스페이스·탭·개행·CR·FF·VT를 모두 포함해
 * JS의 trim()과 실질적으로 같은 범위다.
 *
 * unnest(null)은 0행을 돌려주므로 staff_actions가 null이어도 안전하다(스키마상으로는
 * not null이라 그 값이 들어올 수 없다 — 방어로만 남긴다).
 */
export function effectiveGuidelineSql(alias = "g"): string {
  return (
    `(exists (select 1 from unnest(${alias}.staff_actions) a where a !~ '^[[:space:]]*$')` +
    ` or coalesce(${alias}.guest_notice, '') !~ '^[[:space:]]*$')`
  );
}
