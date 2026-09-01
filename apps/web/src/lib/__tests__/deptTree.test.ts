import { describe, expect, it } from "vitest";
import {
  buildDeptTree,
  flattenDepartments,
  deptPathLabel,
  leafDeptIds,
  deptSubtreeIds,
  deptDeleteOrder,
} from "../deptTree";
import type { DeptLike } from "../deptTree";

const d = (id: string, parent: string | null, name: string, sort = 0): DeptLike => ({
  id,
  parent_id: parent,
  name,
  sort_order: sort,
});

// QA W-15의 재현 상태를 그대로 만든다. 이 파일이 없던 동안 화면 넷은 전부
// "루트 + 그 직계 자식" 2단만 그렸고, 아래 세 모양은 어디에도 나타나지 않았다.
const threeLevels = [
  d("r", null, "리조트"),
  d("r-room", "r", "객실"),
  d("r-room-front", "r-room", "프론트"), // 3단
  d("r-room-hk", "r-room", "하우스키핑"), // 3단
  d("solo", null, "안전관리팀"), // 자식 없는 최상위
];

describe("buildDeptTree", () => {
  it("3단 부서를 3단 그대로 만든다", () => {
    const tree = buildDeptTree(threeLevels);
    const resort = tree.find((n) => n.dept.id === "r")!;
    expect(resort.depth).toBe(0);
    const room = resort.children[0]!;
    expect(room.dept.id).toBe("r-room");
    expect(room.depth).toBe(1);
    expect(room.children.map((c) => c.dept.id)).toEqual(["r-room-front", "r-room-hk"]);
    expect(room.children[0]!.depth).toBe(2);
  });

  it("자식 없는 최상위 부서도 루트로 남는다", () => {
    const tree = buildDeptTree(threeLevels);
    const solo = tree.find((n) => n.dept.id === "solo");
    expect(solo).toBeTruthy();
    expect(solo!.children).toEqual([]);
  });

  it("부모를 못 찾는 행은 버리지 않고 루트로 올린다", () => {
    // 부모가 목록에 없으면(권한·필터·경합) 그 부서는 화면에서 통째로 사라진다.
    // 사라지는 것이 이 라운드가 고치는 결함 자체이므로, 없애지 말고 드러낸다.
    const tree = buildDeptTree([d("orphan", "gone", "떠돌이"), d("r", null, "리조트")]);
    expect(tree.map((n) => n.dept.id).sort()).toEqual(["orphan", "r"]);
  });

  it("순환이 들어와도 멈추지 않는다", () => {
    // 서버가 400으로 막지만, 화면이 데이터 한 줄에 통째로 멎어서는 안 된다.
    const tree = buildDeptTree([d("a", "b", "가"), d("b", "a", "나")]);
    expect(tree.length).toBeGreaterThan(0);
    expect(flattenDepartments([d("a", "b", "가"), d("b", "a", "나")]).length).toBe(2);
  });

  it("형제는 sort_order 다음 이름순으로 정렬한다", () => {
    const rows = [
      d("b", null, "나", 1),
      d("a", null, "가", 1),
      d("z", null, "하", 0),
    ];
    expect(buildDeptTree(rows).map((n) => n.dept.id)).toEqual(["z", "a", "b"]);
  });
});

describe("flattenDepartments · deptPathLabel", () => {
  it("전위 순회 순서와 루트부터의 전체 경로를 준다", () => {
    const flat = flattenDepartments(threeLevels);
    expect(flat.map((f) => f.dept.id)).toEqual(["r", "r-room", "r-room-front", "r-room-hk", "solo"]);
    expect(deptPathLabel(flat[2]!.path)).toBe("리조트 · 객실 · 프론트");
    expect(deptPathLabel(flat[4]!.path)).toBe("안전관리팀");
  });

  it("이름이 같아도 다른 계열이면 라벨이 구분된다", () => {
    // 시드에 실제로 '리조트 · 조리'와 '골프 · 조리'가 있다. 닫힌 <select>는 고른
    // 항목 한 줄만 보여주므로 들여쓰기만으로는 이 둘을 가를 수 없다.
    const rows = [
      d("r", null, "리조트"),
      d("g", null, "골프", 1),
      d("r-c", "r", "조리"),
      d("g-c", "g", "조리"),
    ];
    const labels = flattenDepartments(rows).map((f) => deptPathLabel(f.path));
    expect(labels).toContain("리조트 · 조리");
    expect(labels).toContain("골프 · 조리");
  });
});

describe("leafDeptIds", () => {
  it("자식 없는 최상위 부서도 리프로 센다", () => {
    // 대시보드 체크리스트가 리프로 세는데 지침 화면이 그리지 않아, 체크리스트가
    // 영원히 완료되지 않던 상태(QA W-15)의 핵심 조건이다.
    expect(leafDeptIds(threeLevels).has("solo")).toBe(true);
  });

  it("3단의 말단이 리프이고 그 부모는 아니다", () => {
    const leaves = leafDeptIds(threeLevels);
    expect(leaves.has("r-room-front")).toBe(true);
    expect(leaves.has("r-room-hk")).toBe(true);
    expect(leaves.has("r-room")).toBe(false);
    expect(leaves.has("r")).toBe(false);
    expect([...leaves].sort()).toEqual(["r-room-front", "r-room-hk", "solo"]);
  });
});

describe("deptSubtreeIds · deptDeleteOrder", () => {
  it("자기 자신과 손자까지 자손 전체를 모은다", () => {
    expect([...deptSubtreeIds(threeLevels, "r")].sort()).toEqual([
      "r",
      "r-room",
      "r-room-front",
      "r-room-hk",
    ]);
  });

  it("삭제 순서는 가장 깊은 것부터다", () => {
    // parent_id가 on delete restrict라서 위에서부터 지우면 첫 줄에서 막히고,
    // 직계 자식만 지우면 손자에서 막혀 "일부만 지워진" 상태로 끝난다(QA W-25a).
    const order = deptDeleteOrder(threeLevels, "r").map((r) => r.id);
    expect(order[order.length - 1]).toBe("r");
    expect(order.indexOf("r-room-front")).toBeLessThan(order.indexOf("r-room"));
    expect(order.indexOf("r-room-hk")).toBeLessThan(order.indexOf("r-room"));
    expect(order).not.toContain("solo");
  });
});
