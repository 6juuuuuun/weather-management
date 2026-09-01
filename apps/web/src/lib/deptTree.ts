// 부서 트리 — 화면 4개(부서 관리·직원·행동 지침·대시보드 체크리스트)가 공유한다.
//
// 예전에는 화면마다 "루트를 고르고 그 직계 자식을 붙인다"를 따로 적었다. 서버는
// parent_id에 깊이 제한을 두지 않으므로(server/src/api/org.ts) 3단 부서를 만들면
// **어느 화면에도 나타나지 않았다** — 데이터는 있는데 아무도 볼 수 없는 상태다
// (QA W-15). 그래서 계층은 여기 한 곳에서만 계산하고, 화면은 결과를 그리기만 한다.
//
// 규칙 세 가지를 여기서 못 박는다.
//   1) 깊이 제한 없음. 부모가 있으면 그 아래, 없으면 루트.
//   2) 부모를 못 찾는 행(목록에 없는 parent_id)은 **버리지 않고 루트로 올린다**.
//      버리면 그 부서는 다시 화면에서 사라지고, 사라진 이유를 아무도 알 수 없다.
//   3) 순환(A→B→A)이 들어와도 무한 재귀에 빠지지 않는다. 서버가 막고 있지만
//      화면이 데이터 한 줄에 통째로 멈추는 일은 없어야 한다.

export type DeptLike = { id: string; parent_id: string | null; name: string; sort_order: number };

export type DeptNode<T extends DeptLike> = {
  dept: T;
  depth: number;
  children: DeptNode<T>[];
};

/** 형제 정렬: sort_order 우선, 같으면 이름순. 부모를 옮기면 sort_order가 겹칠 수
 *  있어서(옮긴 부서는 원래 값을 그대로 갖는다) 이름으로 한 번 더 가른다 —
 *  그러지 않으면 목록 순서가 렌더마다 흔들린다. */
function bySortThenName<T extends DeptLike>(a: T, b: T): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ko");
}

/** 평면 목록을 트리로 만든다. 루트부터 정렬된 상태로 돌려준다. */
export function buildDeptTree<T extends DeptLike>(rows: T[]): DeptNode<T>[] {
  const byId = new Map<string, T>();
  for (const r of rows) byId.set(r.id, r);

  const childrenOf = new Map<string | null, T[]>();
  for (const r of rows) {
    // 자기 자신이 부모거나 목록에 없는 부모를 가리키면 루트로 취급한다(규칙 2).
    const parent = r.parent_id && r.parent_id !== r.id && byId.has(r.parent_id) ? r.parent_id : null;
    const arr = childrenOf.get(parent) ?? [];
    arr.push(r);
    childrenOf.set(parent, arr);
  }
  for (const arr of childrenOf.values()) arr.sort(bySortThenName);

  const seen = new Set<string>();
  const build = (row: T, depth: number): DeptNode<T> => {
    seen.add(row.id);
    const kids = (childrenOf.get(row.id) ?? []).filter((c) => !seen.has(c.id));
    return { dept: row, depth, children: kids.map((c) => build(c, depth + 1)) };
  };

  const roots = (childrenOf.get(null) ?? []).map((r) => build(r, 0));

  // 여기까지 한 번도 닿지 않은 행 = 루트에서 도달할 수 없는 고리(A→B→A) 안에
  // 갇힌 부서다. 그냥 두면 서버는 계속 내려주는데 화면에는 한 줄도 안 보이는,
  // 이 라운드가 고치는 것과 똑같은 상태가 된다. 고리를 끊어 루트로 올려 보여준다.
  for (const row of rows.slice().sort(bySortThenName)) {
    if (!seen.has(row.id)) roots.push(build(row, 0));
  }
  return roots;
}

export type FlatDept<T extends DeptLike> = {
  dept: T;
  depth: number;
  /** 루트부터 자기까지의 이름 목록. 드롭다운 라벨이 이걸 이어 붙인다. */
  path: string[];
  hasChildren: boolean;
};

/** 트리를 화면에 그리는 순서(전위 순회)대로 편다. */
export function flattenDeptTree<T extends DeptLike>(nodes: DeptNode<T>[], parentPath: string[] = []): FlatDept<T>[] {
  const out: FlatDept<T>[] = [];
  for (const node of nodes) {
    const path = [...parentPath, node.dept.name];
    out.push({ dept: node.dept, depth: node.depth, path, hasChildren: node.children.length > 0 });
    out.push(...flattenDeptTree(node.children, path));
  }
  return out;
}

/** 목록을 그대로 받아 화면 순서대로 편다(트리를 따로 만들 필요가 없는 곳용). */
export function flattenDepartments<T extends DeptLike>(rows: T[]): FlatDept<T>[] {
  return flattenDeptTree(buildDeptTree(rows));
}

/** 드롭다운 라벨. 2단까지는 지금 화면과 글자 하나까지 같다("리조트 · 조리").
 *  깊어지면 그대로 길어진다 — 같은 이름의 부서가 다른 부모 밑에 있는 것은
 *  시드에도 이미 있어서(리조트 · 조리 / 골프 · 조리) 경로 없이는 구분되지 않는다. */
export const deptPathLabel = (path: string[]): string => path.join(" · ");

/** 자식이 없는 부서 = 리프. 위치가 아니라 데이터로 정한다 —
 *  자식 없는 최상위 부서도 리프이고(QA W-15), 3단·4단의 말단도 리프다. */
export function leafDeptIds<T extends DeptLike>(rows: T[]): Set<string> {
  const hasChild = new Set<string>();
  for (const r of rows) {
    if (r.parent_id && r.parent_id !== r.id) hasChild.add(r.parent_id);
  }
  return new Set(rows.filter((r) => !hasChild.has(r.id)).map((r) => r.id));
}

/** 자기 자신과 모든 하위 부서의 id. 부모 이동에서 "자기 자손 밑으로는 못 간다"를
 *  판정하고, 삭제에서 지워야 할 범위를 구하는 데 함께 쓴다. */
export function deptSubtreeIds<T extends DeptLike>(rows: T[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  // 순환이 있어도 out이 더 이상 커지지 않으면 멈춘다.
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parent_id && out.has(r.parent_id) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

/** 삭제 순서: 가장 깊은 것부터. parent_id가 on delete restrict라서
 *  위에서부터 지우면 첫 줄에서 막힌다. */
export function deptDeleteOrder<T extends DeptLike>(rows: T[], rootId: string): T[] {
  const subtree = deptSubtreeIds(rows, rootId);
  const depthOf = new Map<string, number>();
  for (const { dept, depth } of flattenDepartments(rows)) depthOf.set(dept.id, depth);
  return rows
    .filter((r) => subtree.has(r.id))
    .sort((a, b) => (depthOf.get(b.id) ?? 0) - (depthOf.get(a.id) ?? 0));
}
