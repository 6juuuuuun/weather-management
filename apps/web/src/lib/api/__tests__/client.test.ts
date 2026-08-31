import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError, apiGet, apiSend } from "../client";

beforeEach(() => vi.restoreAllMocks());

describe("API 클라이언트", () => {
  // 세션이 httpOnly 쿠키에 있으므로 요청에 쿠키가 실려야 한다.
  // credentials를 빼면 로그인해도 모든 요청이 401로 떨어진다.
  it("항상 쿠키를 함께 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/departments");
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });

  it("실패하면 상태 코드를 담은 ApiError를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "권한이 없습니다" }), { status: 403 })),
    );
    await expect(apiGet("/api/departments")).rejects.toMatchObject({
      status: 403,
      message: "권한이 없습니다",
    });
  });

  it("본문이 없는 204에도 터지지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiSend("PUT", "/api/guidelines", { rows: [] })).resolves.toBeNull();
  });

  // 실패 응답이 JSON이 아닐 수 있다(라우트가 아예 없어 Express 기본 404 HTML이 오는 경우 등).
  // 이때도 파싱 예외로 죽지 않고 기본 문구로 ApiError를 던져야 한다.
  it("에러 본문이 JSON이 아니면 기본 문구를 쓴다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Not Found</html>", { status: 404 })));
    await expect(apiGet("/api/nope")).rejects.toMatchObject({
      status: 404,
      message: "요청이 실패했습니다 (404)",
    });
  });

  // body가 있는 요청에는 Content-Type과 JSON 직렬화된 본문이 실려야 한다 —
  // 둘 중 하나라도 빠지면 서버(express.json())가 body를 파싱하지 못해 req.body가 비어버린다.
  it("본문이 있는 요청은 JSON으로 직렬화해 Content-Type과 함께 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiSend("PATCH", "/api/employees/e1", { name: "홍길동" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/employees/e1");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ name: "홍길동" }));
  });

  // Task 9(로그인 화면)의 선행조건. auth/middleware.ts는 "비밀번호 강제 변경"
  // 상태에서 모든 /api/* 요청에 403 { must_change_password: true }를 주는데
  // requireAdmin의 권한 거부도 403이라 상태 코드만으로는 갈리지 않는다. 호출부가
  // 본문의 플래그를 읽어 /change-password로 보낼 수 있어야 한다 — 이게 없으면
  // 한국어 메시지 문자열 비교밖에 방법이 없고 문구가 바뀌면 깨진다.
  it("오류 응답 본문을 통째로 보존한다 (must_change_password를 상태 코드와 구분할 수 있다)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "비밀번호를 먼저 변경해야 합니다", must_change_password: true }), {
          status: 403,
        }),
      ),
    );
    const err = await apiGet("/api/departments").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.body?.must_change_password).toBe(true);
  });

  // 같은 403이라도 권한 거부에는 그 플래그가 없어야 한다 — 둘이 구분되지 않으면
  // 위 테스트만으로는 아무것도 증명하지 못한다.
  it("권한 거부 403에는 must_change_password가 없다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "권한이 없습니다" }), { status: 403 })),
    );
    const err = await apiGet("/api/departments").catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.body?.must_change_password).toBeUndefined();
  });

  it("오류 본문이 JSON이 아니면 body는 null이다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Not Found</html>", { status: 404 })));
    const err = await apiGet("/api/nope").catch((e) => e);
    expect(err.body).toBeNull();
  });

  // 본문 없는 GET은 Content-Type을 보내지 않는다 — 실려도 무해하지만, 있으면
  // "본문 유무로 헤더를 분기한다"는 의도가 깨졌다는 신호다.
  it("본문이 없는 GET은 Content-Type을 보내지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/departments");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers).toEqual({});
    expect(init.body).toBeUndefined();
  });
});
