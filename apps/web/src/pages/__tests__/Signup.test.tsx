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
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "password12345" } });
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
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "password12345" } });
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
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: [] }));
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "short" } });
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
    push("/api/public/departments", () => jsonResponse([{ id: "d1", parent_id: null, name: "객실", sort_order: 1 }]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: [] }));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    await screen.findByRole("option", { name: "객실" });
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "password12345" } });
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
    push("/api/public/departments", () => jsonResponse({ error: "서버 오류가 발생했습니다" }, 500));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: [] }));
    renderSignup();

    expect(await screen.findByText(/부서 목록을 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("부서")).toHaveDisplayValue("선택하지 않음");

    push("/api/public/departments", () => jsonResponse([{ id: "d1", parent_id: null, name: "객실", sort_order: 1 }]));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(screen.queryByText(/부서 목록을 불러오지 못했습니다/)).not.toBeInTheDocument());
    expect(await screen.findByRole("option", { name: "객실" })).toBeInTheDocument();
  });
  // 화면 테스트는 fetch를 스텁하므로 서버 응답을 절대 보지 않는다 — 그래서 여기서
  // 지킬 수 있는 것은 "무엇을 보내는가"다. 전화번호 서식은 온전히 화면의 일이라
  // 이 자리에서만 잡힌다.
  it("공백이 든 번호를 붙여넣어도 정규형으로 보이고 그대로 제출된다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: [] }));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.change(screen.getByLabelText("휴대폰 번호"), { target: { value: "010 1234 5678" } });

    expect(screen.getByLabelText("휴대폰 번호")).toHaveValue("010-1234-5678");

    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(true));
    const init = fetchMock.mock.calls.find(([path]) => path === "/api/auth/signup")![1] as RequestInit;
    expect(JSON.parse(init.body as string).phone).toBe("010-1234-5678");
  });

  // 오타 하나로 자기 계정에 못 들어가는 일을 막는 칸이다. 값은 서버로 나가지 않는다 —
  // 화면에서만 비교한다.
  it("비밀번호 확인이 다르면 가입 요청을 보내지 않고 무엇이 틀렸는지 말한다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: [] }));
    renderSignup();

    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "password12346" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(screen.getByText(/비밀번호가 서로 다릅니다/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(false);
  });

  it("확인 칸의 값은 서버로 나가지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: [] }));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(true));
    const init = fetchMock.mock.calls.find(([path]) => path === "/api/auth/signup")![1] as RequestInit;
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual([
      "department_id", "email", "name", "password", "phone",
    ]);
  });
});

// 서비스 시작 때 .env의 ALLOWED_EMAIL_DOMAINS 한 줄로 켜는 기능이다 — 그래서 **두 모드가
// 모두** 검증돼야 한다. 한 모드만 보면 설정을 켜는 날(또는 비우는 날)에야 나머지 절반이
// 드러난다. 서버는 어느 모드에서도 그대로 최종 관문이다.
describe("가입 — 회사 이메일 도메인 고정", () => {
  function fillRest() {
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
  }

  it("도메인이 정확히 하나면 아이디 칸과 고정 도메인으로 나누고, 조립한 주소를 보낸다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: ["dnocorp.com"] }));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    expect(await screen.findByText("@dnocorp.com")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "asher91" } });
    fillRest();
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(true));
    const init = fetchMock.mock.calls.find(([path]) => path === "/api/auth/signup")![1] as RequestInit;
    expect(JSON.parse(init.body as string).email).toBe("asher91@dnocorp.com");
  });

  // 아이디 칸으로 다른 도메인이 밀려 들어오면 안 된다 — 주소 전체를 붙여넣는 것이
  // 가장 흔한 동작이고, 그때 나가는 값이 화면에 보이는 것과 달라서는 안 된다.
  it("아이디 칸에 주소 전체를 붙여넣어도 다른 도메인이 실려 나가지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: ["dnocorp.com"] }));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    await screen.findByText("@dnocorp.com");
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: " asher91@evil.com " } });
    expect(screen.getByLabelText("회사 이메일")).toHaveValue("asher91");
    fillRest();
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(true));
    const init = fetchMock.mock.calls.find(([path]) => path === "/api/auth/signup")![1] as RequestInit;
    expect(JSON.parse(init.body as string).email).toBe("asher91@dnocorp.com");
  });

  // 아이디가 비면 `@dnocorp.com`만 남은 주소가 나갈 뻔한 자리다. 첫 관문은 input의
  // required이고(브라우저가 제출 자체를 막는다), 제출 처리에도 같은 검사가 한 겹 더
  // 있다 — 여기서 확인하는 것은 "어느 관문이 잡았는가"가 아니라 **요청이 안 나간다**는
  // 사실이다.
  it("도메인만 붙여넣어 아이디가 비면 가입 요청을 보내지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: ["dnocorp.com"] }));
    renderSignup();

    await screen.findByText("@dnocorp.com");
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "@evil.com" } });
    expect(screen.getByLabelText("회사 이메일")).toHaveValue("");
    fillRest();
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(screen.getByLabelText("회사 이메일")).toBeRequired());
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(false);
  });

  it("설정이 비어 있으면(제한 없음) 지금과 같은 자유 입력 한 칸이다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: [] }));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => path === "/api/public/signup-config")).toBe(true),
    );
    expect(screen.queryByText(/^@/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("회사 이메일")).toHaveAttribute("type", "email");

    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fillRest();
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(true));
    const init = fetchMock.mock.calls.find(([path]) => path === "/api/auth/signup")![1] as RequestInit;
    expect(JSON.parse(init.body as string).email).toBe("a@gonjiam.com");
  });

  // 도메인이 여럿이면 화면이 어느 쪽을 붙일지 정할 수 없다 — 하나를 골라 고정하면
  // 나머지 도메인을 쓰는 사람은 가입할 길이 화면에서 사라진다.
  it("도메인이 둘 이상이면 자유 입력으로 남는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ email_domains: ["dnocorp.com", "gonjiam.com"] }));
    renderSignup();

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => path === "/api/public/signup-config")).toBe(true),
    );
    expect(screen.queryByText("@dnocorp.com")).not.toBeInTheDocument();
    expect(screen.getByLabelText("회사 이메일")).toHaveAttribute("type", "email");
  });

  // 설정 조회 한 번의 실패로 가입 자체를 막으면 부서 목록보다 훨씬 나쁜 실패가 된다.
  it("설정 조회가 실패해도 자유 입력으로 가입할 수 있다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/public/departments", () => jsonResponse([]));
    push("/api/public/signup-config", () => jsonResponse({ error: "서버 오류가 발생했습니다" }, 500));
    push("/api/auth/signup", () => jsonResponse({ ok: true }, 201));
    renderSignup();

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => path === "/api/public/signup-config")).toBe(true),
    );
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fillRest();
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/signup")).toBe(true));
    const init = fetchMock.mock.calls.find(([path]) => path === "/api/auth/signup")![1] as RequestInit;
    expect(JSON.parse(init.body as string).email).toBe("a@gonjiam.com");
  });
});
