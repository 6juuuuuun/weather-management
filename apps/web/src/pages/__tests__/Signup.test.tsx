import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Signup from "../Signup";
import { jsonResponse, makeFetchQueue } from "../../test-support/fetchQueue";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSignup() {
  return render(
    <MemoryRouter>
      <Signup />
    </MemoryRouter>,
  );
}

describe("회원가입", () => {
  it("가입에 성공하면 완료 안내를 보여준다", async () => {
    // mockResolvedValue로 같은 Response 인스턴스를 재사용하면, 마운트 시 부서 목록
    // 조회가 먼저 그 응답 본문을 소비해 버려 실제 제출 응답이 "body stream already
    // read"로 깨진다(부서 목록을 다시 즉시 로드하게 된 항목 6과 맞물려 드러난 문제) —
    // 그래서 호출마다 새 Response를 만든다.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Response(JSON.stringify({ ok: true }), { status: 201 })),
    );
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    expect(await screen.findByText(/가입이 완료/)).toBeInTheDocument();
  });

  // 회귀: 예전 로그인 화면은 catch가 없어 실패해도 성공 화면을 보여줬다.
  it("서버가 거부하면 실패 사유를 보여주고 성공 화면으로 넘어가지 않는다", async () => {
    // 위와 같은 이유로 호출마다 새 Response를 만든다.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          () => new Response(JSON.stringify({ error: "회사 이메일로만 가입할 수 있습니다" }), { status: 400 }),
        ),
    );
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gmail.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    expect(await screen.findByText(/회사 이메일로만/)).toBeInTheDocument();
    expect(screen.queryByText(/가입이 완료/)).not.toBeInTheDocument();
  });

  // 수정 라운드 1 · 항목 6(컨트롤러 판정): 부서 목록은 다시 마운트 시 즉시 불러온다.
  // 원래 브리프 단언("fetchMock이 전혀 불리지 않았다")은 그 즉시 로드와 모순됐다 —
  // 이 테스트가 실제로 지켜야 하는 것은 "클라이언트 검증에 걸리면 가입 요청을 보내지
  // 않는다"이지 "아무 요청도 하지 않는다"가 아니므로, 단언을 그렇게 좁힌다.
  it("비밀번호가 10자 미만이면 가입 요청(POST /api/auth/signup)을 보내지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/departments", () => jsonResponse([]));
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(screen.getByText(/10자/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(false);
  });

  // 수정 라운드 2 · 항목 1: department_id를 null로 고정해도(사용자가 고른 부서를
  // 화면에서 버려도) 이전까지는 어떤 테스트도 잡지 못했다 — 계약 테스트(lib/api/auth)는
  // signup() 함수 자체가 받은 값을 그대로 보내는지만 지키지, 화면이 그 함수에 실제로
  // 무엇을 넘기는지는 지키지 않았다. 여기서는 select로 부서를 실제로 고르고, 나가는
  // 요청 본문의 department_id가 그 값과 일치하는지 직접 단언한다.
  it("고른 부서의 id를 그대로 department_id로 보낸다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/departments", () => jsonResponse([{ id: "d1", parent_id: null, name: "객실", sort_order: 1 }]));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    await screen.findByRole("option", { name: "객실" });
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.change(screen.getByLabelText("부서"), { target: { value: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([path]) => path === "/api/auth/signup")!;
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string).department_id).toBe("d1");
  });

  // F6: 마운트 시 부서 목록을 못 불러오면(500 등) 조용히 빈 상태로 남기지 않고
  // 오류와 재시도 수단을 보여준다. 재시도를 누르면 실제로 다시 불러온다 —
  // 부서를 못 고른 채 가입하면 department_id: null이 되어 requireDepartment
  // 라우트가 통째로 막힌다.
  it("부서 목록을 불러오지 못하면 오류와 재시도 버튼을 보여주고, 재시도하면 다시 불러온다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/departments", () => jsonResponse({ error: "서버 오류가 발생했습니다" }, 500));
    renderSignup();

    expect(await screen.findByText(/부서 목록을 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("부서")).toHaveDisplayValue("선택하지 않음");

    push("/api/departments", () => jsonResponse([{ id: "d1", parent_id: null, name: "객실", sort_order: 1 }]));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(screen.queryByText(/부서 목록을 불러오지 못했습니다/)).not.toBeInTheDocument());
    expect(await screen.findByRole("option", { name: "객실" })).toBeInTheDocument();
  });
});
