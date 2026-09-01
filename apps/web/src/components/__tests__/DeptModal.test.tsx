import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeptModal } from "../DeptModal";

const mocks = vi.hoisted(() => ({
  listDepartments: vi.fn(),
  createDepartment: vi.fn(),
  renameDepartment: vi.fn(),
  moveDepartment: vi.fn(),
  deleteDepartment: vi.fn(),
}));

vi.mock("../../lib/api/org", () => ({
  listDepartments: (...a: unknown[]) => mocks.listDepartments(...a),
  createDepartment: (...a: unknown[]) => mocks.createDepartment(...a),
  renameDepartment: (...a: unknown[]) => mocks.renameDepartment(...a),
  moveDepartment: (...a: unknown[]) => mocks.moveDepartment(...a),
  deleteDepartment: (...a: unknown[]) => mocks.deleteDepartment(...a),
}));

// 리조트 > 객실 > 프론트 (3단) + 자식 없는 최상위 하나.
const threeLevels = [
  { id: "d1", parent_id: null, name: "리조트", sort_order: 0 },
  { id: "d2", parent_id: "d1", name: "객실", sort_order: 0 },
  { id: "d3", parent_id: "d2", name: "프론트", sort_order: 0 },
  { id: "d4", parent_id: null, name: "안전관리팀", sort_order: 1 },
];

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.listDepartments.mockReset().mockResolvedValue(threeLevels);
  mocks.createDepartment.mockReset().mockResolvedValue(null);
  mocks.renameDepartment.mockReset().mockResolvedValue(null);
  mocks.moveDepartment.mockReset().mockResolvedValue(null);
  mocks.deleteDepartment.mockReset().mockResolvedValue(null);
});

function renderModal() {
  return render(<DeptModal onClose={vi.fn()} onChanged={vi.fn()} />);
}

// QA W-15 · 편집기가 정확히 2단만 그려서, 3단 부서는 만들어 놓고도 이 화면에서
// 이름을 바꾸거나 지울 수단이 없었다.
describe("DeptModal 계층 표시", () => {
  it("3단 부서까지 전부 그린다", async () => {
    renderModal();
    await screen.findByLabelText("프론트 삭제");
    // 이름 칸만 본다 — 상위 부서 드롭다운의 option에도 같은 글자가 들어 있다.
    const names = [...document.querySelectorAll(".dept-modal-name")].map((el) => el.textContent);
    expect(names).toEqual(["리조트", "객실", "프론트", "안전관리팀"]);
  });

  it("깊어질수록 들여쓰기가 늘어난다", async () => {
    renderModal();
    await screen.findByLabelText("프론트 삭제");
    const padOf = (name: string) => {
      const el = [...document.querySelectorAll(".dept-modal-name")].find((e) => e.textContent === name)!;
      return Number((el.closest(".dept-modal-row") as HTMLElement).style.paddingLeft.replace("px", ""));
    };
    expect(padOf("리조트")).toBeLessThan(padOf("객실"));
    expect(padOf("객실")).toBeLessThan(padOf("프론트"));
  });

  it("최상위가 아닌 부서에도 하위 부서 추가 버튼이 있다", async () => {
    renderModal();
    // 예전에는 루트에만 붙어 있어서 3단을 화면에서 만들 방법이 없었다.
    expect(await screen.findByLabelText("객실 하위 부서 추가")).toBeInTheDocument();
    expect(screen.getByLabelText("프론트 하위 부서 추가")).toBeInTheDocument();
  });
});

// QA W-25c · PATCH가 이름만 바꿔서, 조직 개편은 지우고 새로 만드는 수밖에 없었고
// 그러면 그 부서의 지침·수신자 지정이 cascade로 사라졌다.
describe("DeptModal 상위 부서 이동", () => {
  it("상위 부서를 고르면 그 부서만 옮긴다", async () => {
    renderModal();
    const select = (await screen.findByLabelText("프론트 상위 부서")) as HTMLSelectElement;
    expect(select.value).toBe("d2");
    fireEvent.change(select, { target: { value: "d4" } });
    await waitFor(() => expect(mocks.moveDepartment).toHaveBeenCalledWith("d3", "d4"));
  });

  it("최상위를 고르면 parent_id를 null로 보낸다", async () => {
    renderModal();
    const select = await screen.findByLabelText("객실 상위 부서");
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(mocks.moveDepartment).toHaveBeenCalledWith("d2", null));
  });

  it("자기 자신과 자기 자손은 상위 부서 후보에서 빠진다", async () => {
    renderModal();
    const select = (await screen.findByLabelText("객실 상위 부서")) as HTMLSelectElement;
    const values = [...select.querySelectorAll("option")].map((o) => o.value);
    // 자기 자신(d2)과 자손(d3)을 고를 수 있으면 트리에서 떨어져 나간 고리가 생긴다.
    expect(values).not.toContain("d2");
    expect(values).not.toContain("d3");
    expect(values).toContain("d1");
    expect(values).toContain("d4");
  });

  it("후보 목록은 전체 경로로 적힌다", async () => {
    renderModal();
    const select = await screen.findByLabelText("안전관리팀 상위 부서");
    const labels = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(labels).toContain("리조트 · 객실 · 프론트");
  });

  it("서버가 거절하면 그 문구를 보여준다", async () => {
    const { ApiError } = await import("../../lib/api/client");
    mocks.moveDepartment.mockRejectedValue(new ApiError(400, "부서를 자기 하위 부서 밑으로 옮길 수 없습니다"));
    renderModal();
    const select = await screen.findByLabelText("프론트 상위 부서");
    fireEvent.change(select, { target: { value: "d4" } });
    expect(await screen.findByText(/자기 하위 부서 밑으로/)).toBeInTheDocument();
  });
});

// QA W-25a · 직계 자식만 지우고 부모를 지우면, 3단에서는 손자가 남아 부모 삭제가
// 막힌다 — 그 사이에 이미 지워진 부서들은 지침·수신자와 함께 영구히 사라진 뒤다.
describe("DeptModal 삭제", () => {
  it("자손 전체를 가장 깊은 것부터 지운다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderModal();
    fireEvent.click(await screen.findByLabelText("리조트 삭제"));
    await waitFor(() => expect(mocks.deleteDepartment).toHaveBeenCalledTimes(3));
    expect(mocks.deleteDepartment.mock.calls.map((c) => c[0])).toEqual(["d3", "d2", "d1"]);
  });

  it("확인창이 하위 부서 개수를 자손 전체로 센다", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderModal();
    fireEvent.click(await screen.findByLabelText("리조트 삭제"));
    expect(confirmSpy.mock.calls[0]?.[0]).toContain("하위 부서 2개");
    expect(mocks.deleteDepartment).not.toHaveBeenCalled();
  });
});
